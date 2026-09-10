import type { TokenUsage } from '../llm/types.js'

/**
 * 累计的 token 用量。一旦变成 `'unknown'`，就永远回不去数字了——见 `TokenMeter.record()`
 * 的说明：这是"未报告的 usage 记成 unknown，不是 0"这条原则在累加场景下的自然延伸。
 */
export interface TokenUsageTotals {
  readonly inputTokens: number | 'unknown'
  readonly outputTokens: number | 'unknown'
  readonly cacheReadTokens: number | 'unknown'
  readonly cacheWriteTokens: number | 'unknown'
}

/**
 * 累计一个 turn（或者你想累计的任何范围）的 token 用量。
 *
 * "未报告的 usage 是 unknown，不是 0"——如果直接把 `undefined` 当 0 处理，累计出来的
 * 数字会显得"完整、可信"，但其实是编出来的：某一次 provider attempt 没上报用量，
 * 不代表这次真的没花 token，可能只是这个 provider/这次响应没告诉你。一旦某次 `record()`
 * 收到了 `undefined`，这份累计值就**永久**变成 `'unknown'`——哪怕后面的调用又正常
 * 上报了用量，也回不去数字：你已经确定漏了一段真实存在的用量，任何后续的"看起来
 * 正常"的数字加总都只会是一个更精确但依然错误的答案。
 */
export class TokenMeter {
  private inputTokens: number | 'unknown' = 0
  private outputTokens: number | 'unknown' = 0
  private cacheReadTokens: number | 'unknown' = 0
  private cacheWriteTokens: number | 'unknown' = 0

  record(usage: TokenUsage | undefined): void {
    if (usage === undefined) {
      this.inputTokens = 'unknown'
      this.outputTokens = 'unknown'
      this.cacheReadTokens = 'unknown'
      this.cacheWriteTokens = 'unknown'
      return
    }
    this.inputTokens = add(this.inputTokens, usage.inputTokens)
    this.outputTokens = add(this.outputTokens, usage.outputTokens)
    // 缓存字段本身就是可选的（不是所有 provider 都做 prompt caching），"没报告"在这里
    // 是一个合法的、天然的 0，不是"这次调用整体的用量成谜"——跟 input/output 缺失的
    // 含义不一样，所以不会让整个 meter 变成 unknown。
    this.cacheReadTokens = add(this.cacheReadTokens, usage.cacheReadTokens ?? 0)
    this.cacheWriteTokens = add(this.cacheWriteTokens, usage.cacheWriteTokens ?? 0)
  }

  totals(): TokenUsageTotals {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
    }
  }
}

function add(current: number | 'unknown', delta: number): number | 'unknown' {
  return current === 'unknown' ? 'unknown' : current + delta
}
