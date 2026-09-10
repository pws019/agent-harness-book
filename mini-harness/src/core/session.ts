import type { Message } from '../llm/types.js'

/**
 * 简化版的 turn 结束原因，只给 Session 记录用——刻意不 import agent-loop.ts 的
 * StopReason，让 session.ts 保持在比 Agent/runTurn 更底层的位置，不反向依赖它们。
 * Day9+ 集成时再决定要不要把两者对齐。
 */
export type TurnEndReason =
  | { readonly kind: 'completed' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'budget_exhausted'; readonly reason: 'max_steps' | 'max_tool_calls' | 'deadline' }
  | { readonly kind: 'error'; readonly message: string }

/**
 * 仅追加日志的事件词汇——今天只做 DSH 真实事件表里最核心的一个子集：
 * turn/step 边界 + 三种会变成消息的"surface"事件。故意不做的（写在 study.md 里）：
 * `system/message`（系统提示词组装，Day11 的话题）、`assistant/chunk`（流式中间态持久化，
 * Day9 崩溃恢复真正需要时再加）、`request/header`（请求信封快照，Day11 附近）。
 */
export interface SessionEventPayloadMap {
  'turn/start': { readonly turn: number }
  'turn/end': { readonly turn: number; readonly reason: TurnEndReason }
  'step/start': { readonly turn: number; readonly step: number }
  'step/end': { readonly turn: number; readonly step: number }
  /** message.role 必须是 'user'。 */
  'user/message': { readonly turn: number; readonly message: Message }
  /** message.role 必须是 'assistant'；blocks 里可能包含 tool-call 块。 */
  'assistant/message': { readonly turn: number; readonly step: number; readonly message: Message }
  /** 模型请求了一次工具调用，原始 JSON 字符串，还没执行。 */
  'tool/call': {
    readonly turn: number
    readonly step: number
    readonly callId: string
    readonly name: string
    readonly arguments: string
  }
  /** 一次工具调用的结果，callId 必须对应同一 step 里更早的一条 tool/call。 */
  'tool/result': {
    readonly turn: number
    readonly step: number
    readonly callId: string
    readonly content: string
    readonly isError: boolean
  }
}

export type SessionEventType = keyof SessionEventPayloadMap

/** 一条不可变的日志条目：payload 之外，统一带 seq（单调递增位置）和 time（epoch 毫秒）。 */
export type SessionEvent = {
  [K in SessionEventType]: { readonly type: K; readonly seq: number; readonly time: number } & SessionEventPayloadMap[K]
}[SessionEventType]

export class SessionAppendError extends Error {}

/**
 * 判断一个值是不是"无损 JSON"：只允许 null/string/boolean/有限 number/纯数组/
 * 普通对象字面量的任意嵌套组合。跟 Day3/Day6 deepFreeze 里判断"纯数据"用的是
 * 同一个思路——递归时遇到不是纯数据的东西（class 实例、函数、undefined、NaN、
 * Symbol、bigint）直接判定失败，不允许它们悄悄混进日志。
 */
export function isJsonValue(value: unknown): boolean {
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (t === 'object') {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(value as Record<string, unknown>).every(isJsonValue)
  }
  return false
}

interface OpenStep {
  readonly step: number
  readonly pendingCallIds: Set<string>
}

/**
 * 仅追加的会话事件日志，是 agent 一次交互的唯一真源——LLM 消息历史从这份日志
 * *派生*而来（见 deriveMessages），Agent 不应该再单独维护一份可能跟日志漂移的
 * message 数组。
 *
 * append() 在写入前做两件事：
 * 1. 校验 payload 是无损 JSON（isJsonValue）——写不进日志的东西，不允许存在。
 * 2. 校验 turn/step/tool-call 的开闭配对不变式——不合法的调用序列直接抛
 *    SessionAppendError，而不是静默写入一条会让 deriveMessages 产生歧义的记录。
 */
export class Session {
  private readonly log: SessionEvent[] = []
  private readonly clock: () => number
  private openTurn: number | undefined
  private openStep: OpenStep | undefined

  constructor(options: { readonly clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now
  }

  get events(): readonly SessionEvent[] {
    return this.log
  }

  /**
   * 目前还"挂起"着的活动——如果 `undefined`，说明日志在一个干净的边界上结束（没有开着
   * 的 turn）。恢复一份中断的日志（Day9 持久化）或者异常终止一个正在跑的 turn 时，都要
   * 先问一下这个，再决定要不要补写收尾事件（见 `closeDanglingActivity`）。
   */
  danglingActivity(): DanglingActivity | undefined {
    if (this.openTurn === undefined) return undefined
    return {
      turn: this.openTurn,
      step: this.openStep?.step,
      pendingCallIds: this.openStep ? [...this.openStep.pendingCallIds] : [],
    }
  }

  append<K extends SessionEventType>(type: K, data: SessionEventPayloadMap[K]): SessionEvent {
    if (!isJsonValue(data)) {
      throw new SessionAppendError(`event "${type}" payload is not lossless JSON`)
    }
    this.checkInvariant(type, data)
    const event = { type, seq: this.log.length, time: this.clock(), ...data } as SessionEvent
    this.log.push(event)
    return event
  }

  /**
   * 从磁盘上加载回来的一份已有事件列表重建一个 Session——保留原始 seq/time（不是重新
   * 分配），但照样跑一遍开闭配对校验，重新算出"现在挂起着什么"。如果加载回来的事件序列
   * 本身内部不自洽（比如一条 tool/result 对应的 callId 从来没有被调用过），说明磁盘上的
   * 数据已经损坏，直接抛错——**日志末尾挂着一个没关闭的 turn/step 是正常的**（进程可能就是
   * 在那个点被杀掉的），只有"事件之间的因果关系对不上"才算真正的损坏。
   */
  static restoreFrom(events: readonly SessionEvent[]): Session {
    const session = new Session()
    for (const event of events) {
      session.checkInvariant(event.type, event)
      session.log.push(event)
    }
    return session
  }

  private checkInvariant<K extends SessionEventType>(type: K, data: SessionEventPayloadMap[K]): void {
    switch (type) {
      case 'turn/start': {
        const { turn } = data as SessionEventPayloadMap['turn/start']
        if (this.openTurn !== undefined) {
          throw new SessionAppendError(`turn/start(${turn}) while turn ${this.openTurn} is still open`)
        }
        this.openTurn = turn
        return
      }
      case 'turn/end': {
        const { turn } = data as SessionEventPayloadMap['turn/end']
        if (this.openTurn !== turn) {
          throw new SessionAppendError(`turn/end(${turn}) does not match the open turn ${String(this.openTurn)}`)
        }
        if (this.openStep !== undefined) {
          throw new SessionAppendError(`turn/end(${turn}) while step ${this.openStep.step} is still open`)
        }
        this.openTurn = undefined
        return
      }
      case 'step/start': {
        const { turn, step } = data as SessionEventPayloadMap['step/start']
        if (this.openTurn !== turn) {
          throw new SessionAppendError(`step/start(${turn},${step}) outside its turn`)
        }
        if (this.openStep !== undefined) {
          throw new SessionAppendError(`step/start(${turn},${step}) while step ${this.openStep.step} is still open`)
        }
        this.openStep = { step, pendingCallIds: new Set() }
        return
      }
      case 'step/end': {
        const { turn, step } = data as SessionEventPayloadMap['step/end']
        if (this.openTurn !== turn || this.openStep?.step !== step) {
          throw new SessionAppendError(`step/end(${turn},${step}) does not match the open step`)
        }
        if (this.openStep.pendingCallIds.size > 0) {
          throw new SessionAppendError(
            `step/end(${turn},${step}) while tool call(s) [${[...this.openStep.pendingCallIds].join(', ')}] have no result yet`,
          )
        }
        this.openStep = undefined
        return
      }
      case 'tool/call': {
        const { turn, step, callId } = data as SessionEventPayloadMap['tool/call']
        if (this.openTurn !== turn || this.openStep?.step !== step) {
          throw new SessionAppendError(`tool/call(${callId}) outside its step`)
        }
        if (this.openStep.pendingCallIds.has(callId)) {
          throw new SessionAppendError(`duplicate tool/call callId "${callId}" in the same step`)
        }
        this.openStep.pendingCallIds.add(callId)
        return
      }
      case 'tool/result': {
        const { turn, step, callId } = data as SessionEventPayloadMap['tool/result']
        if (this.openTurn !== turn || this.openStep?.step !== step || !this.openStep.pendingCallIds.has(callId)) {
          throw new SessionAppendError(`tool/result(${callId}) does not match a pending tool/call in this step`)
        }
        this.openStep.pendingCallIds.delete(callId)
        return
      }
      case 'user/message':
      case 'assistant/message':
        return
      default:
        return assertNeverEventType(type)
    }
  }
}

function assertNeverEventType(type: never): never {
  throw new Error(`Unhandled SessionEventType: ${JSON.stringify(type)}`)
}

export interface DanglingActivity {
  readonly turn: number
  /** `undefined` 表示 turn 开了但一个 step 都还没开始（比如取消发生在第一次请求模型之前）。 */
  readonly step: number | undefined
  readonly pendingCallIds: readonly string[]
}

/** append() 之后想同步收到通知的调用方实现这个接口（`JsonlSessionStore` 已经满足）。 */
export interface SessionSink {
  append(event: SessionEvent): void
}

/**
 * 把一份挂起的活动诚实地收尾：还没等到结果的 tool/call，补写一条 isError 的 tool/result
 * （不是伪造一个成功结果），再补 step/end，最后写 turn/end。用在两个场景：
 * 1. `Agent.drain()` 里一个 turn 异常终止（取消/预算耗尽/错误）的收尾。
 * 2. 从持久化恢复一份日志时，发现末尾挂着一个没关闭的 turn（进程就是在那个点被杀掉的）。
 *
 * 可选的 `sink`：这几条收尾事件跟 `Session.append()` 走的是同一个方法，但如果调用方
 * 是通过某个包装了 sink 转发的入口（比如 `Agent.appendEvent()`）在别处写事件，这里
 * 自己直接调 `session.append()` 就会绕开那层转发——这是我们在集成测试里真实踩到的坑：
 * 第一版没有这个参数，导致收尾产生的 `turn/end` 被记进了内存里的 Session，却没有被
 * 镜像写进持久化 store，两边从这一条开始就不一致了。传了 `sink` 就不会漏。
 */
export function closeDanglingActivity(session: Session, reason: TurnEndReason, sink?: SessionSink): void {
  const dangling = session.danglingActivity()
  if (!dangling) return
  const { turn, step, pendingCallIds } = dangling
  const append = <K extends SessionEventType>(type: K, data: SessionEventPayloadMap[K]): void => {
    const event = session.append(type, data)
    sink?.append(event)
  }
  if (step !== undefined) {
    for (const callId of pendingCallIds) {
      append('tool/result', { turn, step, callId, content: 'turn ended before this call produced a result', isError: true })
    }
    append('step/end', { turn, step })
  }
  append('turn/end', { turn, reason })
}

/**
 * 把日志派生成模型消息历史——唯一允许构造 Message[] 的地方。同一份事件日志
 * replay 任意多次，必须产出完全相同的结果（它是纯函数：不读任何外部状态，
 * 同样的输入永远产出同样的输出）。
 *
 * tool/result 按 (turn, step) 分组：同一个 step 里连续出现的 tool/result 事件，
 * 合并成一条 `{ role: 'tool', blocks: [...] }` 消息——这跟 Agent 目前把一个 step
 * 里所有工具结果打包成一条 tool 消息的行为保持一致（agent-loop.ts 的
 * `history.push({ role: 'tool', blocks: toolResults })`），Day9 把 Agent 接到
 * Session 上时不需要改变这个形状。
 */
export function deriveMessages(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = []
  let pendingToolBlocks: Message['blocks'][number][] = []

  const flushToolGroup = (): void => {
    if (pendingToolBlocks.length === 0) return
    messages.push({ role: 'tool', blocks: pendingToolBlocks })
    pendingToolBlocks = []
  }

  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        flushToolGroup()
        messages.push(event.message)
        break
      case 'assistant/message':
        flushToolGroup()
        messages.push(event.message)
        break
      case 'tool/result':
        pendingToolBlocks.push({
          type: 'tool-result',
          toolCallId: event.callId,
          content: event.content,
          isError: event.isError,
        })
        break
      case 'turn/start':
      case 'turn/end':
      case 'step/start':
      case 'step/end':
      case 'tool/call':
        break
      default:
        assertNeverEvent(event)
    }
  }
  flushToolGroup()
  return messages
}

function assertNeverEvent(event: never): never {
  throw new Error(`Unhandled SessionEvent variant: ${JSON.stringify(event)}`)
}
