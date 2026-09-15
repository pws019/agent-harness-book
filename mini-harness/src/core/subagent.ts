import { Agent, type AgentCancelCause, type AgentDeps } from './agent-handle.js'
import { DelegationBudget } from './delegation-budget.js'
import type { PermissionPreset } from './permission-presets.js'
import { createStructuredResult, type StructuredResult } from './structured-result.js'
import type { Message } from '../llm/types.js'

export class SubagentBudgetExceededError extends Error {
  constructor() {
    super('delegation budget exceeded — see DelegationBudget limits (maxConcurrent/maxTotalChildren/maxDepth/maxTokens)')
    this.name = 'SubagentBudgetExceededError'
  }
}

export class SubagentPermissionEscalationError extends Error {
  constructor(childPresetName: string, parentPresetName: string) {
    super(`child preset "${childPresetName}" would exceed parent preset "${parentPresetName}" — a child cannot have more authority than its parent`)
    this.name = 'SubagentPermissionEscalationError'
  }
}

/** `readonly < balanced < autonomous`——显式偏序，不是靠猜哪个 preset "听起来更严格"。
 * 任何不在这张表里的 preset 名字都视为"未知"，`presetRank()` 会抛错——fail-closed，
 * 跟 Day18 `FailClosedCommandPolicy` 同一个纪律：不认识的东西不给通过，不是默认放行。 */
const PRESET_RANK: Readonly<Record<string, number>> = { readonly: 0, balanced: 1, autonomous: 2 }

function presetRank(preset: PermissionPreset): number {
  const rank = PRESET_RANK[preset.name]
  if (rank === undefined) throw new Error(`unknown permission preset: "${preset.name}" — cannot rank it for escalation checks`)
  return rank
}

export interface SubagentSpec {
  readonly deps: Omit<AgentDeps, 'sink'>
  readonly task: Message
  /** 子 Agent 自己的权限预设——必须 ≤ 父 Agent 的（见 `PRESET_RANK`），省略时不做
   * 升权检查（这个项目里 `PermissionPreset` 今天还没有接进真正的工具执行路径,
   * 见 Day19 study.md,所以省略是常态,不是遗漏）。 */
  readonly preset?: PermissionPreset
}

export interface SubagentHandle {
  readonly id: string
  result(): Promise<StructuredResult>
  dispose(): Promise<void>
}

function sumTokens(events: readonly { readonly type: string; readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } }[]): number {
  return events.reduce((total, event) => {
    if (event.type !== 'model-response' || !event.usage) return total
    return total + event.usage.inputTokens + event.usage.outputTokens
  }, 0)
}

/**
 * 把一个子 Agent 的最终结果包成 `StructuredResult`——只取最后一条 `model-response`
 * 里的文本块,跟 `cli.ts` `runInvestigation()` 提取 `finalText` 是同一个模式
 * （Day7 起就是这样：最终结果 = 最后一次模型回复的文本）。 */
function extractStructuredResult(record: Agent['records'][number] | undefined): StructuredResult {
  if (!record) return createStructuredResult(false, null)
  const finalText = record.events
    .filter((e): e is Extract<typeof e, { type: 'model-response' }> => e.type === 'model-response')
    .map((e) => e.message.blocks.find((b) => b.type === 'text'))
    .filter((b): b is { readonly type: 'text'; readonly text: string } => b !== undefined)
    .at(-1)
  const ok = record.stopReason.kind === 'completed'
  return createStructuredResult(ok, finalText?.text ?? null)
}

/**
 * 委派边界的落地：只有任务可独立、上下文可隔离、并行有收益时才该委派——`startChild()`
 * 强制这条边界从设计上成立，不是靠自觉：
 * - **独立的 Session**：`new Agent(spec.deps)` 是一个全新的 `Agent` 实例，有自己独立
 *   的事件日志，不共享父 Agent 的可变 `Message[]` 历史（"共享一份可变历史"正是
 *   Day8 事件溯源要消除的那类跨 turn 污染，子 Agent 直接共享父的历史会重新引入
 *   这个问题）。
 * - **只有 `StructuredResult` 能跨边界**：`extractStructuredResult()` 把子 Agent
 *   的最终输出提取成一条经过 `isJsonValue()` 校验的结果,父 Agent 拿不到子 Agent
 *   内部完整的事件日志/工具调用细节。
 * - **权限不能升级**：子 Agent 的 `preset` 必须 ≤ 父 Agent 的（`presetRank()`）。
 * - **预算 fail-closed**：`DelegationBudget.canStart()` 说不行就是不行,不会因为
 *   "这次任务看起来很重要"就绕过去。
 */
export class SubagentManager {
  private readonly children = new Map<string, Agent>()
  private nextId = 0

  constructor(
    private readonly budget: DelegationBudget,
    private readonly depth: number = 0,
    private readonly parentPreset?: PermissionPreset,
  ) {}

  startChild(spec: SubagentSpec): SubagentHandle {
    if (!this.budget.canStart(this.depth)) throw new SubagentBudgetExceededError()
    if (spec.preset && this.parentPreset && presetRank(spec.preset) > presetRank(this.parentPreset)) {
      throw new SubagentPermissionEscalationError(spec.preset.name, this.parentPreset.name)
    }

    this.budget.recordStart()
    const id = `child-${this.nextId++}`
    const agent = new Agent(spec.deps)
    this.children.set(id, agent)

    const timeoutMs = this.budget.maxTimeMs
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => agent.cancel({ kind: 'parent' } satisfies AgentCancelCause), timeoutMs)
        : undefined

    agent.send(spec.task)

    const resultPromise = (async (): Promise<StructuredResult> => {
      await agent.whenIdle()
      clearTimeout(timer)
      const record = agent.records[0]
      this.budget.recordEnd(sumTokens(record?.events ?? []))
      return extractStructuredResult(record)
    })()

    return {
      id,
      result: () => resultPromise,
      dispose: async () => {
        clearTimeout(timer)
        await agent.dispose()
        this.children.delete(id)
      },
    }
  }

  /** 父 Agent 结束时调用——级联 dispose 所有还活着的子,不留孤儿。`Agent.dispose()`
   * 本身幂等（Day6），对已经跑完/已经 dispose 过的子重复调用是安全的 no-op。 */
  async disposeAll(): Promise<void> {
    await Promise.all([...this.children.values()].map((agent) => agent.dispose()))
    this.children.clear()
  }

  get runningChildCount(): number {
    return this.children.size
  }
}
