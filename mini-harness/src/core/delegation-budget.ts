export interface DelegationBudgetLimits {
  readonly maxConcurrent: number
  readonly maxTotalChildren: number
  readonly maxDepth: number
  /** 可选。累计消耗（所有已经跑完的子 Agent 的 input+output token 之和）达到这个数,
   * 不再允许启动新的子 Agent——诚实的边界：这个上限只在"启动下一个子 Agent 之前"
   * 检查,拦不住一个**已经在跑**的子 Agent 自己超支（那需要深入改 agent-loop.ts 的
   * token 预算机制,Day12 已经有 `maxTokens` 选项管这件事,但那是单个 Agent 内部的
   * 事,`DelegationBudget` 管的是"这一棵委派树累计花了多少"，是另一层）。 */
  readonly maxTokens?: number
  /** 可选。一个子 Agent 从 `send()` 到必须结束的最长时间——超过就被取消,不是"建议"，
   * 是真的会调用 `agent.cancel()`。 */
  readonly maxTimeMs?: number
}

/**
 * 一棵委派树的预算所有者——`SubagentManager.startChild()` 在真正启动子 Agent 之前
 * 问它"现在能不能再开一个"。判断本身 fail-closed：跟 Day18 `FailClosedCommandPolicy`
 * 同一个纪律,`canStart()` 内部任何一步计算出错都当成"不能开"，不会因为预算检查自己
 * 出了 bug 就悄悄放行。
 */
export class DelegationBudget {
  private running = 0
  private totalStarted = 0
  private tokensUsed = 0

  constructor(private readonly limits: DelegationBudgetLimits) {}

  canStart(currentDepth: number): boolean {
    try {
      if (currentDepth >= this.limits.maxDepth) return false
      if (this.running >= this.limits.maxConcurrent) return false
      if (this.totalStarted >= this.limits.maxTotalChildren) return false
      if (this.limits.maxTokens !== undefined && this.tokensUsed >= this.limits.maxTokens) return false
      return true
    } catch {
      return false
    }
  }

  /** 调用方必须在真正调用 `new Agent()` 之前调用——`running`/`totalStarted` 两个计数
   * 都要在"这次启动已经确定会发生"的那一刻更新,不能等子 Agent 跑完才补记账
   * （不然并发启动多个子 Agent 时,`maxConcurrent` 这道检查会完全失效）。 */
  recordStart(): void {
    this.running += 1
    this.totalStarted += 1
  }

  /** 子 Agent 结束时调用——`tokensUsedByChild` 通常是从它的 `TurnRecord` 事件里
   * 汇总出来的 input+output token 之和。 */
  recordEnd(tokensUsedByChild: number): void {
    this.running -= 1
    this.tokensUsed += tokensUsedByChild
  }

  get maxTimeMs(): number | undefined {
    return this.limits.maxTimeMs
  }
}
