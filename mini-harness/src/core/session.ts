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

  append<K extends SessionEventType>(type: K, data: SessionEventPayloadMap[K]): SessionEvent {
    if (!isJsonValue(data)) {
      throw new SessionAppendError(`event "${type}" payload is not lossless JSON`)
    }
    this.checkInvariant(type, data)
    const event = { type, seq: this.log.length, time: this.clock(), ...data } as SessionEvent
    this.log.push(event)
    return event
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
