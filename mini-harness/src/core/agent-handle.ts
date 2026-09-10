import { runTurn, type AgentLoopEvent, type AgentLoopOptions, type StopReason } from './agent-loop.js'
import {
  closeDanglingActivity,
  deriveMessages,
  Session,
  type SessionEvent,
  type SessionEventPayloadMap,
  type SessionEventType,
  type SessionSink,
  type TurnEndReason,
} from './session.js'
import type { LlmAdapter } from '../llm/adapter.js'
import type { Message } from '../llm/types.js'
import type { ToolRegistry } from '../tools/registry.js'

export type { SessionSink } from './session.js'

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
  readonly loopOptions?: Omit<AgentLoopOptions, 'signal' | 'pollSteering'>
  /** 可选：每次事件写进 Session 之后，同步转发给它——比如接一个 `JsonlSessionStore`。 */
  readonly sink?: SessionSink
}

export interface TurnRecord {
  readonly userMessage: Message
  readonly events: readonly AgentLoopEvent[]
  readonly stopReason: StopReason
  readonly cancelCause?: AgentCancelCause
}

/** `StopReason.error` 携带完整的 LlmFailure；Session 记录只要一句人类可读的话，不认识 LlmFailure 这个类型。 */
function toTurnEndReason(stopReason: StopReason): TurnEndReason {
  switch (stopReason.kind) {
    case 'completed':
      return { kind: 'completed' }
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'budget_exhausted':
      return { kind: 'budget_exhausted', reason: stopReason.reason }
    case 'error':
      return { kind: 'error', message: stopReason.failure.message }
  }
}

/**
 * 一个进程内的 Agent 句柄：管理 turn 的排队、单 writer 执行、取消传播和幂等释放。
 *
 * Day9 起，`history` 不再是一个手动维护的字段——它是 `deriveMessages(session.events)`
 * 现算出来的派生视图（见 session.ts）。`drain()` 是唯一的翻译层：`runTurn()` 本身对
 * Session 一无所知，继续像 Day5-8 那样操作一个每次新建的 `Message[]` 草稿数组；
 * `drain()` 把它消费到的每个 `AgentLoopEvent` 同步翻译成一条 `Session.append(...)`。
 *
 * 刻意简化（相对 DSH 的完整 AgentRegistry/AgentHandle 双层所有权模型）：
 * - 没有独立的"注册表 + 结构性所有者"两层所有权，只有一个持有者概念——谁拿到这个
 *   Agent 实例，谁负责调用 dispose()。
 * - 没有实现 inject()（不唤醒 driver、纯粹等下一个 step 边界被采纳的上下文）——只实现了
 *   send()（对应 DSH 的 followup）和 steer()（对应 DSH 的 followup 之外那种"追上正在跑的
 *   活动"的引导消息，在下一个 step 边界生效，不打断当前 step 已经发出去的请求）。
 */
export class Agent {
  readonly records: TurnRecord[] = []

  private readonly session: Session
  private readonly nextTurnQueue: Message[] = []
  private readonly nextStepQueue: Message[] = []
  private controller: AbortController | undefined
  private currentCancelCause: AgentCancelCause | undefined
  private idleWaiters: Array<() => void> = []
  private disposed = false
  private runLoopPromise: Promise<void> | undefined
  private nextTurnNumber: number

  constructor(
    private readonly deps: AgentDeps,
    restoredEvents?: readonly SessionEvent[],
  ) {
    this.session = restoredEvents ? Session.restoreFrom(restoredEvents) : new Session()
    this.nextTurnNumber = 1 + Math.max(-1, ...this.session.events.filter((e) => e.type === 'turn/start').map((e) => e.turn))
  }

  /**
   * 从持久化恢复：`events` 是上次 `store.load()` 读回来的日志。如果日志末尾挂着一个没
   * 关闭的 turn（进程就是在那个点被杀掉的），立刻诚实地把它收尾（见 `closeDanglingActivity`），
   * 不会假装那次调用成功了，也不会让这份历史带着一个永远打不开的开口。如果 `deps.sink`
   * 已经指向重新打开的底层 store，收尾产生的这几条新事件也会同步镜像过去。
   */
  static restore(deps: AgentDeps, events: readonly SessionEvent[]): Agent {
    const agent = new Agent(deps, events)
    closeDanglingActivity(agent.session, { kind: 'cancelled' }, deps.sink)
    return agent
  }

  private appendEvent<K extends SessionEventType>(type: K, data: SessionEventPayloadMap[K]): void {
    const event = this.session.append(type, data)
    this.deps.sink?.append(event)
  }

  get status(): AgentStatus {
    return this.runLoopPromise ? 'running' : 'idle'
  }

  /** 模型消息历史——从事件日志现算出来的，不是单独维护的一份可能漂移的数组。 */
  get history(): readonly Message[] {
    return deriveMessages(this.session.events)
  }

  /** 底层事件日志，只读。给持久化（Day9 下半场）、投影/查询（Day10）用。 */
  get sessionEvents(): readonly SessionEvent[] {
    return this.session.events
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
      const turn = this.nextTurnNumber++
      this.appendEvent('turn/start', { turn })
      this.appendEvent('user/message', { turn, message: userMessage })

      this.controller = new AbortController()
      this.currentCancelCause = undefined
      const events: AgentLoopEvent[] = []
      // 当前开着的 step——只是为了翻译层给每条事件标上正确的 step 号；"这个 step 里还
      // 挂着哪些没结果的 tool/call" 不需要在这里另存一份，session.danglingActivity()
      // 已经从 Session 自己的簿记里能读到，见下面收尾那段。
      let openStep: number | undefined

      // this.history 在上面 append('user/message', ...) 之后已经现算出包含 userMessage 的
      // 完整历史；这里拷贝一份给 runTurn 当草稿数组，它会在这个副本上继续 .push()，不会
      // 碰 Session——Session 只由下面的翻译层写入。
      const scratchHistory: Message[] = [...this.history]
      const generator = runTurn(
        scratchHistory,
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
          pollSteering: () => {
            const steered = this.nextStepQueue.splice(0, this.nextStepQueue.length)
            for (const message of steered) this.appendEvent('user/message', { turn, message })
            return steered
          },
        },
      )

      let step = await generator.next()
      while (!step.done) {
        events.push(step.value)
        this.translateLoopEvent(turn, step.value, {
          getOpenStep: () => openStep,
          setOpenStep: (s) => (openStep = s),
        })
        step = await generator.next()
      }

      // turn/end 还没写，所以 openTurn 这时候必然还开着——closeDanglingActivity 负责把它
      // 收尾：正常完成时 step 已经关过了，它只补一条 turn/end；异常终止（取消/预算耗尽/
      // 错误）时 runTurn 可能没走到自己的 step-end 就直接返回了，这里会先诚实地给挂起的
      // tool/call 补一条 isError 的 tool/result、再补 step/end，最后才写 turn/end。
      closeDanglingActivity(this.session, toTurnEndReason(step.value), this.deps.sink)

      this.records.push({
        userMessage,
        events,
        stopReason: step.value,
        ...(this.currentCancelCause ? { cancelCause: this.currentCancelCause } : {}),
      })
      this.controller = undefined
    }
  }

  private translateLoopEvent(
    turn: number,
    event: AgentLoopEvent,
    state: {
      readonly getOpenStep: () => number | undefined
      readonly setOpenStep: (step: number | undefined) => void
    },
  ): void {
    switch (event.type) {
      case 'turn-start':
        return // turn/start + user/message 已经在进入循环前写好了
      case 'step-start':
        state.setOpenStep(event.step)
        this.appendEvent('step/start', { turn, step: event.step })
        return
      case 'model-response':
        // 空消息（比如 aborted-before-dispatch 产出的 { blocks: [] }）不记，不污染派生历史。
        if (event.message.blocks.length > 0) {
          this.appendEvent('assistant/message', { turn, step: state.getOpenStep()!, message: event.message })
        }
        return
      case 'tool-call':
        this.appendEvent('tool/call', {
          turn,
          step: state.getOpenStep()!,
          callId: event.toolCall.id,
          name: event.toolCall.name,
          arguments: event.toolCall.arguments,
        })
        return
      case 'tool-result':
        this.appendEvent('tool/result', {
          turn,
          step: state.getOpenStep()!,
          callId: event.toolCallId,
          content: event.content,
          isError: event.isError,
        })
        return
      case 'step-end':
        this.appendEvent('step/end', { turn, step: event.step })
        state.setOpenStep(undefined)
        return
      case 'turn-end':
        return // 收尾统一在 drain() 里做（要先处理异常终止的补写），不在这里单独处理
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
