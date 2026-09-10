import { generateWithRetry, type GenerateRuntime, type LlmAdapter, type RetryPolicy } from '../llm/adapter.js'
import type { FinishReason, LlmFailure, Message, ToolCallBlock, ToolResultBlock } from '../llm/types.js'
import type { ToolRegistry } from '../tools/registry.js'
import { ToolAbortedError, ToolTimeoutError } from '../tools/types.js'

/**
 * 系统对"这一轮是否真的完成了"的判断结果，绝不是"模型自己说完成了"。
 * 具体规则见下方 runTurn 的实现和 study.md 第2节。
 */
export type StopReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'budget_exhausted'; readonly reason: 'max_steps' | 'max_tool_calls' | 'deadline' }
  | { readonly kind: 'error'; readonly failure: LlmFailure }

export type AgentLoopEvent =
  | { readonly type: 'turn-start' }
  | { readonly type: 'step-start'; readonly step: number }
  | { readonly type: 'model-response'; readonly message: Message; readonly finish: FinishReason; readonly attempts: number }
  | { readonly type: 'tool-call'; readonly toolCall: ToolCallBlock }
  | { readonly type: 'tool-result'; readonly toolCallId: string; readonly content: string; readonly isError: boolean }
  | { readonly type: 'step-end'; readonly step: number }
  | { readonly type: 'turn-end'; readonly stopReason: StopReason }

export interface AgentLoopOptions {
  readonly maxSteps?: number
  readonly maxToolCalls?: number
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
  readonly retryPolicy?: RetryPolicy
  readonly retryRuntime?: GenerateRuntime
  /**
   * 在每个 step 开头调用一次，取出这段时间外部通过 steer() 排队的引导消息并追加进历史。
   * 只在 step 边界生效：如果调用方在某个 step 正跑到一半时 steer() 了一条消息，这条消息
   * 不会影响这一步已经发出去的请求（Day3 的深冻结请求本来就没法被事后修改），只会在下一个
   * step 开头才被这里取出、追加进历史，参见 study.md 第3节。
   */
  readonly pollSteering?: () => readonly Message[]
}

export interface AgentLoopDeps {
  readonly adapter: LlmAdapter
  readonly tools: ToolRegistry
  readonly provider: string
  readonly model: string
  readonly system?: string
}

const DEFAULT_MAX_STEPS = 20
const DEFAULT_MAX_TOOL_CALLS = 50

/**
 * 一个 turn 的骨架：请求模型 -> 执行工具 -> 把结果回填进历史 -> 继续请求，
 * 直到系统确认"不再欠下任何工作"或撞到某个预算上限。
 *
 * `history` 是调用方传入、原地追加的数组——这是我们在 Day8 引入事件日志之前，
 * "会话状态"的最简替身。Day8 起，历史会从仅追加事件日志派生，而不是像这样
 * 直接维护一个可变数组。
 *
 * 返回值（generator 的 return，不是某个 yield）就是这个 turn 的最终 StopReason。
 */
export async function* runTurn(
  history: Message[],
  deps: AgentLoopDeps,
  options: AgentLoopOptions = {},
): AsyncGenerator<AgentLoopEvent, StopReason> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS
  const deadline = options.deadlineMs !== undefined ? Date.now() + options.deadlineMs : undefined
  let toolCallCount = 0
  let step = 0

  yield { type: 'turn-start' }

  for (;;) {
    if (options.signal?.aborted) {
      yield { type: 'turn-end', stopReason: { kind: 'cancelled' } }
      return { kind: 'cancelled' }
    }
    if (deadline !== undefined && Date.now() > deadline) {
      const stopReason: StopReason = { kind: 'budget_exhausted', reason: 'deadline' }
      yield { type: 'turn-end', stopReason }
      return stopReason
    }

    step += 1
    if (step > maxSteps) {
      const stopReason: StopReason = { kind: 'budget_exhausted', reason: 'max_steps' }
      yield { type: 'turn-end', stopReason }
      return stopReason
    }

    yield { type: 'step-start', step }

    for (const steered of options.pollSteering?.() ?? []) {
      history.push(steered)
    }

    const result = await generateWithRetry(
      deps.adapter,
      {
        provider: deps.provider,
        model: deps.model,
        system: deps.system,
        // A snapshot, not `history` itself: generateWithRetry deep-freezes the request it's
        // given (Day3), and `history` is the mutable array we keep appending to below. Handing
        // over the live array would freeze it in place and this loop could never push again.
        messages: [...history],
        signal: options.signal,
      },
      options.retryPolicy,
      options.retryRuntime,
    )

    yield { type: 'model-response', message: result.message, finish: result.finish, attempts: result.attempts }
    history.push(result.message)

    // Cancellation can surface two ways from generateWithRetry: as finish.kind === 'aborted'
    // (the signal was already aborted before dispatch, handled entirely inside Day3's retry
    // loop), or as an adapter throwing mid-stream once it notices the signal fire -- which our
    // error-classification path turns into finish.kind === 'error' with code 'ABORTED'. Both
    // must map to the same StopReason; treating only the first as cancellation was a real gap
    // we found while building Day6 (see study.md §"坑三").
    const isCancellation =
      result.finish.kind === 'aborted' || (result.finish.kind === 'error' && result.finish.failure.code === 'ABORTED')
    if (isCancellation) {
      yield { type: 'turn-end', stopReason: { kind: 'cancelled' } }
      return { kind: 'cancelled' }
    }
    if (result.finish.kind === 'error') {
      const stopReason: StopReason = { kind: 'error', failure: result.finish.failure }
      yield { type: 'turn-end', stopReason }
      return stopReason
    }

    const toolCalls = result.message.blocks.filter((block): block is ToolCallBlock => block.type === 'tool-call')

    // 系统确认完成的条件：模型这一步没有欠下任何工具调用，而不是"模型嘴上说完了"。
    // finish.kind === 'tool-calls' 但消息里实际没有 tool-call 块，属于畸形响应，
    // 我们保守地当成"还没完成"处理，继续下一步而不是武断收尾。
    if (toolCalls.length === 0 && result.finish.kind !== 'tool-calls') {
      yield { type: 'step-end', step }
      yield { type: 'turn-end', stopReason: { kind: 'completed' } }
      return { kind: 'completed' }
    }

    const toolResults: ToolResultBlock[] = []
    for (const call of toolCalls) {
      toolCallCount += 1
      if (toolCallCount > maxToolCalls) {
        const stopReason: StopReason = { kind: 'budget_exhausted', reason: 'max_tool_calls' }
        yield { type: 'turn-end', stopReason }
        return stopReason
      }

      yield { type: 'tool-call', toolCall: call }

      let outcome: { content: string; isError: boolean }
      try {
        outcome = await executeToolCall(deps.tools, call, options.signal)
      } catch (error) {
        // 超时/取消不是"业务失败"，是运行时层面的中止信号：不伪造一条工具结果、
        // 不再处理这一步剩下的工具调用，直接让整个 turn 提前以 cancelled 收场。
        // 呼应 Day2"未完成的工具调用一律丢弃"——这里丢弃的是本该发生、但没能
        // 安全完成的这一次调用，而不是假装它有一个结果。
        if (error instanceof ToolTimeoutError || error instanceof ToolAbortedError) {
          const stopReason: StopReason = { kind: 'cancelled' }
          yield { type: 'turn-end', stopReason }
          return stopReason
        }
        throw error
      }

      const { content, isError } = outcome
      toolResults.push({ type: 'tool-result', toolCallId: call.id, content, isError })
      yield { type: 'tool-result', toolCallId: call.id, content, isError }
    }

    if (toolResults.length > 0) {
      history.push({ role: 'tool', blocks: toolResults })
    }

    yield { type: 'step-end', step }
  }
}

/**
 * 执行一次工具调用，把"工具执行本身抛出的、可以当成一条业务结果处理的错误"翻译成
 * 一条 isError 工具结果，而不是让整个 turn 崩溃。覆盖的故障场景（对应 study.md 故障
 * 注入清单）：调用不存在的工具、参数不是合法 JSON、工具内部抛出业务错误。
 *
 * ToolTimeoutError/ToolAbortedError 是例外：它们不是"这次调用失败了"这种业务结果，
 * 是"这次调用没能安全跑完"这种运行时信号，原样往上抛，由 runTurn 决定让整个 turn
 * 提前结束，而不是在这里伪造一条工具结果。
 */
async function executeToolCall(
  tools: ToolRegistry,
  call: ToolCallBlock,
  signal: AbortSignal | undefined,
): Promise<{ content: string; isError: boolean }> {
  let args: unknown
  try {
    args = JSON.parse(call.arguments)
  } catch {
    return { content: `invalid JSON arguments for tool "${call.name}": ${call.arguments}`, isError: true }
  }

  try {
    const result = await tools.execute(call.name, args, { signal: signal ?? new AbortController().signal, cwd: '.' })
    return { content: result.content, isError: false }
  } catch (error) {
    if (error instanceof ToolTimeoutError || error instanceof ToolAbortedError) throw error
    return { content: error instanceof Error ? error.message : String(error), isError: true }
  }
}
