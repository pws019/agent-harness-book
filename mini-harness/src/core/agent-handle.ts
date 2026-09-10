import { runTurn, type AgentLoopEvent, type AgentLoopOptions, type StopReason } from './agent-loop.js'
import type { LlmAdapter } from '../llm/adapter.js'
import type { Message } from '../llm/types.js'
import type { ToolRegistry } from '../tools/registry.js'

/**
 * 取消的原因，不是一个布尔值。cause 会被复制到当前进行中活动的 AbortSignal.reason，
 * 并且"第一个 cause 获胜"——同一次活动被取消后，后续的 cancel() 调用不改变已经
 * 记录下来的原因。
 */
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

export type AgentStatus = 'idle' | 'running'

export interface AgentDeps {
  readonly adapter: LlmAdapter
  readonly tools: ToolRegistry
  readonly provider: string
  readonly model: string
  readonly system?: string
  readonly loopOptions?: Omit<AgentLoopOptions, 'signal'>
}

export interface TurnRecord {
  readonly userMessage: Message
  readonly events: readonly AgentLoopEvent[]
  readonly stopReason: StopReason
  readonly cancelCause?: AgentCancelCause
}

/**
 * 一个进程内的 Agent 句柄：管理 turn 的排队、单 writer 执行、取消传播和幂等释放。
 *
 * 刻意简化（相对 DSH 的完整 AgentRegistry/AgentHandle 双层所有权模型）：
 * - 没有独立的"注册表 + 结构性所有者"两层所有权，只有一个持有者概念——谁拿到这个
 *   Agent 实例，谁负责调用 dispose()。
 * - 没有实现 inject()（不唤醒 driver、纯粹等下一个 step 边界被采纳的上下文）——只实现了
 *   send()（对应 DSH 的 followup）和 steer()（对应 DSH 的 followup 之外那种"追上正在跑的
 *   活动"的引导消息，在下一个 step 边界生效，不打断当前 step 已经发出去的请求）。
 */
export class Agent {
  readonly history: Message[] = []
  readonly records: TurnRecord[] = []

  private readonly nextTurnQueue: Message[] = []
  private readonly nextStepQueue: Message[] = []
  private controller: AbortController | undefined
  private currentCancelCause: AgentCancelCause | undefined
  private idleWaiters: Array<() => void> = []
  private disposed = false
  private runLoopPromise: Promise<void> | undefined

  constructor(private readonly deps: AgentDeps) {}

  get status(): AgentStatus {
    return this.runLoopPromise ? 'running' : 'idle'
  }

  /** 排队一个新 turn。空闲时会立刻唤醒 driver；运行中时新消息留在 inbox，等当前 turn 结束再处理。 */
  send(message: Message): void {
    this.assertNotDisposed()
    this.nextTurnQueue.push(message)
    this.wake()
  }

  /**
   * 追上正在跑的活动，插一条引导消息——不像 send() 那样开一个新 turn，而是让这条消息在
   * 当前 turn 的下一个 step 开头被采纳进历史。如果当前没有 turn 在跑，这条消息会在下一次
   * `send()` 触发的 turn 的第一个 step 就被采纳。不唤醒 driver：如果 driver 是空闲的，
   * 单靠 steer() 不会让它跑起来，需要配合 send() 才有意义。
   */
  steer(message: Message): void {
    this.assertNotDisposed()
    this.nextStepQueue.push(message)
  }

  /**
   * 取消当前正在进行的活动（如果有），并按默认行为清空排队消息
   * （对应 DSH 的默认 `keepInbox: false`）。cause 会被记录进当次 turn 的 TurnRecord。
   */
  cancel(cause: AgentCancelCause, options: { keepInbox?: boolean } = {}): void {
    this.currentCancelCause = cause
    this.controller?.abort(cause)
    if (!options.keepInbox) {
      this.nextTurnQueue.length = 0
    }
  }

  /**
   * 等到 agent 彻底没活干。⚠️ 陷阱（对应 study.md）：这只保证"整个 driver 现在空闲"，
   * **不**保证"你刚才 send() 的那条消息处理完了"——因为在你 await 这个 promise 期间，
   * 可能又有别的调用方 send() 了新消息，把空闲状态往后推了。如果需要跟踪某一条具体
   * 消息的结果，请改看 `records`（每条 turn 完成后会追加一条 TurnRecord）。
   */
  async whenIdle(): Promise<void> {
    if (!this.runLoopPromise) return
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /**
   * 幂等释放：第一次调用会取消当前活动、清空 inbox，并等待 driver 排空退出；
   * 之后的调用直接是 no-op，不会重新触发、也不会重新等待。
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.cancel({ kind: 'disposed' })
    if (this.runLoopPromise) {
      await this.runLoopPromise
    }
    // 唤醒任何还在等 whenIdle() 的调用方——disposed 之后不会再有新工作，永远不会再自然触发 notifyIdle()。
    this.notifyIdle()
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('Agent is disposed; create a new one instead of reusing it')
  }

  private wake(): void {
    if (this.runLoopPromise) return // 已经在跑；排进队列的消息会被同一个 drain 循环捡到
    if (this.disposed) return
    this.runLoopPromise = this.drain().finally(() => {
      this.runLoopPromise = undefined
      this.notifyIdle()
    })
  }

  private async drain(): Promise<void> {
    while (this.nextTurnQueue.length > 0 && !this.disposed) {
      const userMessage = this.nextTurnQueue.shift()!
      this.history.push(userMessage)

      this.controller = new AbortController()
      this.currentCancelCause = undefined
      const events: AgentLoopEvent[] = []
      const generator = runTurn(
        this.history,
        {
          adapter: this.deps.adapter,
          tools: this.deps.tools,
          provider: this.deps.provider,
          model: this.deps.model,
          system: this.deps.system,
        },
        {
          ...this.deps.loopOptions,
          signal: this.controller.signal,
          pollSteering: () => this.nextStepQueue.splice(0, this.nextStepQueue.length),
        },
      )

      let step = await generator.next()
      while (!step.done) {
        events.push(step.value)
        step = await generator.next()
      }

      this.records.push({
        userMessage,
        events,
        stopReason: step.value,
        ...(this.currentCancelCause ? { cancelCause: this.currentCancelCause } : {}),
      })
      this.controller = undefined
    }
  }

  private notifyIdle(): void {
    if (!this.disposed && this.nextTurnQueue.length > 0) {
      this.wake() // 排空过程中又来了新消息：不当作"空闲"，立刻接着跑
      return
    }
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }
}
