export type GoalStatus = 'open' | 'pending-verification' | 'closed'

export class GoalNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown goal: "${id}"`)
    this.name = 'GoalNotFoundError'
  }
}

export class GoalVerificationFailedError extends Error {
  constructor(id: string) {
    super(`goal "${id}" failed verification — it was not actually closed`)
    this.name = 'GoalVerificationFailedError'
  }
}

export class GoalNotPendingError extends Error {
  constructor(id: string, actual: GoalStatus) {
    super(`goal "${id}" cannot be closed from status "${actual}" — call markPendingVerification() first`)
    this.name = 'GoalNotPendingError'
  }
}

interface GoalEntry {
  readonly id: string
  readonly description: string
  status: GoalStatus
  readonly verify: () => boolean | Promise<boolean>
}

/**
 * 一个有状态、有明确完成条件的目标——跟"模型自己说它完成了"这种常见的朴素 agent
 * 设计最根本的区别：**模型的自我声明只能把状态推到 `pending-verification`，
 * 从来没有权限直接把一个 goal 标记成 `closed`**。真正的关闭必须调用 `close()`，
 * 而 `close()` 内部会调用创建这个 goal 时注册的 `verify()`——一个跟模型输出完全
 * 独立的、外部的检查函数（可以是"跑一遍测试""检查某个文件是否存在""调一次 API
 * 确认状态"），`verify()` 返回 `false` 的话 `close()` 直接抛错，goal 停在
 * `pending-verification`，不会被静默关闭。
 *
 * 这是"信任但要验证"这条课程主线（Day15 `expectedHash`、Day19 `ApprovalStore`、
 * Day21 `propose-edit` 的验证命令）在"目标管理"这个新场景下的又一次具体落地：
 * 模型的输出永远只是一个**提议**，不是一个**事实**，事实需要外部验证。
 */
export class GoalStore {
  private readonly goals = new Map<string, GoalEntry>()
  private nextId = 0

  open(description: string, verify: () => boolean | Promise<boolean>): string {
    const id = `goal-${this.nextId++}`
    this.goals.set(id, { id, description, status: 'open', verify })
    return id
  }

  status(id: string): GoalStatus {
    return this.require(id).status
  }

  /** 模型的工具调用只能触达这一步——把状态从 `open` 推到 `pending-verification`,
   * 不能更进一步。已经是 `pending-verification` 再调一次是 no-op（幂等），
   * 已经 `closed` 再调则是调用方的 bug信号，直接抛错。 */
  markPendingVerification(id: string): void {
    const goal = this.require(id)
    if (goal.status === 'closed') throw new GoalNotPendingError(id, goal.status)
    goal.status = 'pending-verification'
  }

  /** 真正关闭一个 goal——唯一能让状态变成 `closed` 的入口。必须先处于
   * `pending-verification`（不能从 `open` 直接跳过来,即使 `verify()` 会通过——
   * 这条限制强制"模型至少得先声明一次完成",不能让外部代码绕过模型直接关闭一个
   * 模型自己都还没碰过的 goal）；`verify()` 返回 `false` 就抛
   * `GoalVerificationFailedError`,状态保持在 `pending-verification`,可以再次
   * 尝试关闭（比如模型先修好问题、再触发一次真正的验证）。已经 `closed` 再调用是
   * 幂等 no-op。 */
  async close(id: string): Promise<void> {
    const goal = this.require(id)
    if (goal.status === 'closed') return
    if (goal.status !== 'pending-verification') throw new GoalNotPendingError(id, goal.status)
    const verified = await goal.verify()
    if (!verified) throw new GoalVerificationFailedError(id)
    goal.status = 'closed'
  }

  private require(id: string): GoalEntry {
    const goal = this.goals.get(id)
    if (!goal) throw new GoalNotFoundError(id)
    return goal
  }
}
