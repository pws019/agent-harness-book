import { BlockAssembler } from './block-assembler.js'
import type { FinishReason, LlmFailure, LlmFailureCode, Message, StreamChunk, TokenUsage } from './types.js'

/**
 * 一次已经完全组装好的请求。Agent loop 只应该操作这个类型，永远不 import 任何
 * 具体 provider SDK 的类型。
 */
export interface GenerateOptions {
  readonly provider: string
  readonly model: string
  readonly messages: readonly Message[]
  readonly system?: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  readonly signal?: AbortSignal
}

/** 统一失败载荷抛出的错误类型。适配器和上层代码都用它来传递 LlmFailure。 */
export class LlmError extends Error {
  readonly failure: LlmFailure
  constructor(failure: LlmFailure) {
    super(failure.message)
    this.name = 'LlmError'
    this.failure = failure
  }
}

/**
 * 所有 provider 适配器的公共基类。唯一必须实现的方法是 stream()。
 * 约定（对应 study.md）：一次 stream() 调用只代表一次 provider attempt，
 * 适配器内部禁止自己做库级重试。
 */
export abstract class LlmAdapter {
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/**
 * provider 路由名 -> 适配器实例 的注册表。重复注册会原子失败（要么全部成功，要么一个都不注册）。
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, LlmAdapter>()

  register(providers: readonly string[], adapter: LlmAdapter): () => void {
    const conflicts = providers.filter((provider) => this.adapters.has(provider))
    if (conflicts.length > 0) {
      throw new LlmError({
        code: 'UNSUPPORTED_OPTION',
        message: `provider(s) already registered, registration rejected atomically: ${conflicts.join(', ')}`,
      })
    }
    for (const provider of providers) this.adapters.set(provider, adapter)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      for (const provider of providers) {
        if (this.adapters.get(provider) === adapter) this.adapters.delete(provider)
      }
    }
  }

  resolve(provider: string): LlmAdapter {
    const adapter = this.adapters.get(provider)
    if (!adapter) {
      throw new LlmError({ code: 'UNSUPPORTED_OPTION', message: `no adapter registered for provider "${provider}"` })
    }
    return adapter
  }
}

/**
 * 深冻结一个请求对象。冻结之后任何修改都会在严格模式下抛 TypeError，
 * 保证"发出去的请求"和"日志里记录的请求"永远是同一个不可变快照。
 */
export function freezeRequest<T>(request: T): Readonly<T> {
  deepFreeze(request)
  return request
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  if (Object.isFrozen(value)) return
  Object.freeze(value)
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
}

/**
 * 把组装器观察到的「内容块数量 + 原始 finish reason」翻译成最终的 FinishReason，
 * 关键规则：finish:stop 但零内容块，是可重试错误，不是静默成功。
 */
export function classifyFinish(blockCount: number, finish: FinishReason | undefined): FinishReason {
  if (!finish) {
    return {
      kind: 'error',
      failure: { code: 'PROTOCOL_ERROR', message: 'stream ended without a finish event' },
    }
  }
  if (finish.kind === 'stop' && blockCount === 0) {
    return {
      kind: 'error',
      failure: { code: 'EMPTY_RESPONSE', message: 'model returned finish:stop with zero content blocks' },
    }
  }
  return finish
}

/**
 * 重试策略。normal 模式有次数上限，用完就把最后一次的失败原样返回；
 * always 模式没有上限（配合外部的用户取消一起用）。
 *
 * maxRetries 的语义：首次尝试失败后，最多再重试 maxRetries 次
 * （所以总尝试次数上限是 maxRetries + 1）。
 */
export type RetryPolicy =
  | {
      readonly mode: 'normal'
      readonly maxRetries: number
      readonly retryableCodes: readonly LlmFailureCode[]
      readonly initialDelayMs: number
      readonly maxDelayMs: number
      readonly jitterRatio: number
    }
  | {
      readonly mode: 'always'
      readonly retryableCodes: readonly LlmFailureCode[]
      readonly initialDelayMs: number
      readonly maxDelayMs: number
      readonly jitterRatio: number
    }

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  mode: 'normal',
  maxRetries: 3,
  retryableCodes: ['EMPTY_RESPONSE', 'TIMEOUT', 'RATE_LIMITED', 'SERVER_ERROR'],
  initialDelayMs: 200,
  maxDelayMs: 5000,
  jitterRatio: 0.2,
}

export interface GenerateResult {
  readonly message: Message
  readonly usage?: TokenUsage
  readonly finish: FinishReason
  /** 总共发起了几次 provider attempt（1 = 一次成功，没有重试）。 */
  readonly attempts: number
}

export interface GenerateRuntime {
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
}

function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number): number {
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1))
  const jitter = base * policy.jitterRatio * (random() * 2 - 1)
  return Math.max(0, Math.round(base + jitter))
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 发起一次生成请求，失败时按 policy 重试。
 *
 * 边界规则（对应 study.md）：
 * - 请求会在第一次尝试前被深度冻结。
 * - 'ABORTED' 永远不会出现在需要重试的判断里得逞——即使有人误把它加进白名单，
 *   一旦 signal 已经被中止，函数会直接返回而不再进入下一次尝试。
 * - 每次循环体内只调用一次 adapter.stream()：一次调用 = 一次 provider attempt。
 */
export async function generateWithRetry(
  adapter: LlmAdapter,
  options: GenerateOptions,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  runtime: GenerateRuntime = {},
): Promise<GenerateResult> {
  const sleep = runtime.sleep ?? defaultSleep
  const random = runtime.random ?? Math.random
  // Freeze the exact object the caller handed us (not a copy) -- callers that logged this
  // object before calling us, and the request that actually gets dispatched, must stay the
  // same frozen snapshot. See study.md §2.
  const frozen = freezeRequest(options)

  let attempt = 0
  for (;;) {
    attempt += 1

    if (frozen.signal?.aborted) {
      return {
        message: { role: 'assistant', blocks: [] },
        finish: { kind: 'aborted', failure: { code: 'ABORTED', message: 'signal aborted before dispatch' } },
        attempts: attempt,
      }
    }

    const assembler = new BlockAssembler()
    let thrown: LlmFailure | undefined
    try {
      for await (const chunk of adapter.stream(frozen)) {
        assembler.push(chunk)
      }
    } catch (error) {
      thrown = error instanceof LlmError ? error.failure : { code: 'PROTOCOL_ERROR', message: String(error) }
    }

    const { blocks, usage, finish: rawFinish } = assembler.result()
    const finish: FinishReason = thrown ? { kind: 'error', failure: thrown } : classifyFinish(blocks.length, rawFinish)

    const isFailure = finish.kind === 'error' || finish.kind === 'aborted'
    const isRetryable = isFailure && policy.retryableCodes.includes(finish.failure.code)
    const attemptsRemain = policy.mode === 'always' || attempt <= policy.maxRetries

    if (isRetryable && attemptsRemain) {
      await sleep(backoffDelay(policy, attempt, random))
      continue
    }

    return { message: { role: 'assistant', blocks }, usage, finish, attempts: attempt }
  }
}
