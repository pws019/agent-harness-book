import { contentHash } from '../tools/file-io.js'

/**
 * 一次具体的审批请求——绑定到一次具体的工具调用和它的确切参数,不是一句"要不要
 * 继续"的抽象询问。`argsHash` 复用 Day15 `edit_file` 的乐观并发控制思路
 * （`contentHash`/`expectedHash` 那一套）：不是给文件内容算指纹,是给这次调用的
 * 参数算指纹——同一种"版本指纹代替加锁"的手法,只是应用场景从"文件会不会被
 * 并发改写"换成了"批准的到底是不是这组参数"。
 */
export interface ApprovalRequest {
  readonly nonce: string
  readonly action: string
  readonly target: string
  readonly argsSummary: string
  readonly argsHash: string
  readonly expiresAt: number
}

export class ApprovalError extends Error {}

export class ApprovalNotFoundError extends ApprovalError {
  constructor(nonce: string) {
    super(`unknown approval nonce: "${nonce}"`)
    this.name = 'ApprovalNotFoundError'
  }
}

export class ApprovalAlreadyConsumedError extends ApprovalError {
  constructor(nonce: string) {
    super(`approval "${nonce}" has already been consumed — a one-time approval cannot be replayed`)
    this.name = 'ApprovalAlreadyConsumedError'
  }
}

export class ApprovalExpiredError extends ApprovalError {
  constructor(nonce: string) {
    super(`approval "${nonce}" has expired`)
    this.name = 'ApprovalExpiredError'
  }
}

export class ApprovalArgsMismatchError extends ApprovalError {
  constructor(nonce: string) {
    super(`approval "${nonce}" was granted for different arguments than the ones now being executed`)
    this.name = 'ApprovalArgsMismatchError'
  }
}

export class ApprovalRevokedError extends ApprovalError {
  constructor(nonce: string) {
    super(`approval "${nonce}" was revoked before it could be consumed`)
    this.name = 'ApprovalRevokedError'
  }
}

/**
 * 一次性、可审计的能力令牌——不是聊天记录里的一句"可以"。`create()` 只负责记录
 * "允许执行什么、绑定哪组参数、什么时候过期"，不涉及"谁批准的"这类用户交互细节
 * （那是调用方——比如 Day21 milestone 里的 CLI——的事）。`consume()` 一次只能
 * 成功一次：nonce 不存在、已经被消费过、已经被撤销、已经过期、参数对不上原来
 * 批准的那组,五个条件任何一个不满足都拒绝，且只在全部通过之后才真正标记为已消费。
 */
export class ApprovalStore {
  private readonly requests = new Map<string, { readonly request: ApprovalRequest; consumed: boolean; revoked: boolean }>()
  private nextId = 0

  create(action: string, target: string, argsSummary: string, args: unknown, ttlMs: number, now: number = Date.now()): ApprovalRequest {
    const nonce = `approval-${this.nextId++}`
    const request: ApprovalRequest = {
      nonce,
      action,
      target,
      argsSummary,
      argsHash: contentHash(JSON.stringify(args)),
      expiresAt: now + ttlMs,
    }
    this.requests.set(nonce, { request, consumed: false, revoked: false })
    return request
  }

  /**
   * 消费一次批准。**不修改任何状态,直到全部校验都通过**——参数不匹配这类失败
   * 不会"顺手"把 nonce 也标记消费掉,给调用方留一次用正确参数重试的机会
   * （直到真正过期或者真的被成功消费一次为止）。
   */
  consume(nonce: string, args: unknown, now: number = Date.now()): void {
    const entry = this.requests.get(nonce)
    if (!entry) throw new ApprovalNotFoundError(nonce)
    if (entry.consumed) throw new ApprovalAlreadyConsumedError(nonce)
    if (entry.revoked) throw new ApprovalRevokedError(nonce)
    if (now > entry.request.expiresAt) throw new ApprovalExpiredError(nonce)
    if (contentHash(JSON.stringify(args)) !== entry.request.argsHash) throw new ApprovalArgsMismatchError(nonce)
    entry.consumed = true
  }

  /**
   * 主动撤销一个批准——比如用户点了批准之后又反悔了，或者上层逻辑发现情况变了、
   * 这次批准不该再生效。一个 nonce 在任意时刻只可能处于下面四种状态之一，
   * `revoke()` 对每一种的反应都不一样，不是统一抛错或统一 no-op：
   *
   * | nonce 状态                    | revoke() 的反应                     |
   * |-------------------------------|--------------------------------------|
   * | 不存在                         | 抛 `ApprovalNotFoundError`——调用方手里的 nonce 应该是真实的，不存在意味着记错了 id，是 bug 信号，跟 `consume()` 对未知 id 的态度一致 |
   * | 待消费（未消费/未过期/未撤销）    | 标记为已撤销，成功返回                 |
   * | 已消费                         | 抛 `ApprovalAlreadyConsumedError`——撤销一个已经真正执行过的高风险操作，"太晚了"这个事实本身值得让调用方知道，不能悄悄吞掉 |
   * | 已过期                         | no-op，直接返回——`consume()` 反正会因为过期自己失败，撤销一个已经废了的请求不需要额外报错 |
   * | 已撤销（重复调用）               | no-op，直接返回——撤销本身是幂等操作，跟 Day6 `Agent.dispose()`/Day17 `JobRuntime.dispose()` 是同一个心智模型 |
   */
  revoke(nonce: string, now: number = Date.now()): void {
    const entry = this.requests.get(nonce)
    if (!entry) throw new ApprovalNotFoundError(nonce)
    if (entry.consumed) throw new ApprovalAlreadyConsumedError(nonce)
    if (entry.revoked) return
    if (now > entry.request.expiresAt) return
    entry.revoked = true
  }
}

/**
 * 三种交互类型显式区分成一个封闭联合类型,不共用一个含糊的 yes/no 接口——跟
 * Day2 `StreamChunk`/Day8 `SessionEvent` 是同一套"assertNever 兜底"手法：
 * - `question`：单纯信息缺失,需要用户补一句自由文本。
 * - `choice`：偏好选择,答案是给定选项里的一个,不是自由文本。
 * - `approval`：风险审批,答案是"批准"还是"拒绝"这一个具体的 `ApprovalRequest`。
 * 三者的"回答方式"完全不同,共用一个模糊的 `{ prompt: string }` 会让调用方
 * 没法从类型上区分"这次该展示一个输入框、一个选择器、还是一个批准/拒绝按钮"。
 */
export type UserInteractionRequest =
  | { readonly kind: 'question'; readonly prompt: string }
  | { readonly kind: 'choice'; readonly prompt: string; readonly options: readonly string[] }
  | { readonly kind: 'approval'; readonly request: ApprovalRequest }

export function assertNeverInteraction(value: never): never {
  throw new Error(`Unhandled UserInteractionRequest variant: ${JSON.stringify(value)}`)
}
