/**
 * 客户端提供的幂等 key 目前处于哪个状态——跟 Day19 `ApprovalStore` 一样,状态推进
 * 只在"这一步真的发生了"的那一刻才写入,不会因为并发请求而被提前标记。
 */
export type IdempotencyEntry<Response> =
  | { readonly status: 'in-flight' }
  | { readonly status: 'completed'; readonly response: Response }

/**
 * 重复提交同一个 `Idempotency-Key` 不应该让副作用（这里是 `Agent.send()`）真的
 * 发生两次。`claim(key)` 是唯一一处会修改状态的地方,而且只在"这个 key 第一次
 * 出现"这一件事上做判断——调用方必须先 `claim()` 拿到 `true` 才可以真的去执行
 * 一次副作用,`false` 的话必须去 `get()` 读已经记录的结果,不能自己再跑一遍。
 *
 * 这个类不做时间淘汰（Day19 `ApprovalRequest` 有 `expiresAt`,这里没有）——幂等 key
 * 的语义就是"同一个 key 永远对应同一次操作",没有"过期之后可以重新用"这回事,
 * 跟审批"批准是有时效的"是两种不同的东西,不能照搬同一套过期逻辑。
 */
export class IdempotencyStore<Response> {
  private readonly entries = new Map<string, IdempotencyEntry<Response>>()

  /** 第一次见到这个 key，占住它并返回 `true`——调用方现在、也只有现在，可以真的去
   * 执行一次副作用。已经见过（不管是还在跑还是已经跑完）都返回 `false`。 */
  claim(key: string): boolean {
    if (this.entries.has(key)) return false
    this.entries.set(key, { status: 'in-flight' })
    return true
  }

  /** 只有真正 `claim()` 成功过的调用方才应该调用这个——把之前占的位置换成真实结果。 */
  complete(key: string, response: Response): void {
    this.entries.set(key, { status: 'completed', response })
  }

  get(key: string): IdempotencyEntry<Response> | undefined {
    return this.entries.get(key)
  }
}
