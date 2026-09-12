import type { ContentBlock, Message } from '../llm/types.js'
import type { SessionEvent, TurnEndReason } from './session.js'

/**
 * 把日志投影成统计视图——跟 `deriveMessages` 是同一份日志的另一种派生，互不干扰。
 * 这正是"仅追加日志支持多视图共享同一份真相"这条 Day8 讲过的价值第一次真正兑现：
 * 想要"给模型看的历史"就调 `deriveMessages`，想要"给运维看的概览"就调这个，两者
 * 永远不会漂移，因为它们读的是同一份 `events`。
 */
export interface SessionProjection {
  readonly turnCount: number
  /** 不分名字的工具调用总数——`toolCallCountByName` 按名字拆开看，这个字段回答"总共调了几次"。 */
  readonly toolCallCount: number
  readonly toolCallCountByName: Readonly<Record<string, number>>
  readonly lastStopReason: TurnEndReason | undefined
}

export function projectSummary(events: readonly SessionEvent[]): SessionProjection {
  let turnCount = 0
  let toolCallCount = 0
  const toolCallCountByName: Record<string, number> = {}
  let lastStopReason: TurnEndReason | undefined

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        turnCount += 1
        break
      case 'tool/call':
        toolCallCount += 1
        toolCallCountByName[event.name] = (toolCallCountByName[event.name] ?? 0) + 1
        break
      case 'turn/end':
        lastStopReason = event.reason
        break
      case 'step/start':
      case 'step/end':
      case 'user/message':
      case 'assistant/message':
      case 'system/message':
      case 'tool/result':
      case 'compaction/start':
      case 'compaction/summary':
      case 'compaction/end':
        break
      default:
        assertNeverEvent(event)
    }
  }
  return { turnCount, toolCallCount, toolCallCountByName, lastStopReason }
}

function assertNeverEvent(event: never): never {
  throw new Error(`Unhandled SessionEvent variant: ${JSON.stringify(event)}`)
}

/**
 * 按 seq 游标分页，不用数组下标——下标在真实持久化场景里不稳定（比如 Day13 压缩会
 * 让旧事件在派生结果里"消失"，但 seq 是事件本身永久的身份，不会变）。
 */
export interface QueryOptions {
  /** 只要 seq 严格大于这个值的事件；省略等价于从头开始。 */
  readonly afterSeq?: number
  readonly limit?: number
}

export function queryEvents(events: readonly SessionEvent[], options: QueryOptions = {}): readonly SessionEvent[] {
  const afterSeq = options.afterSeq ?? -1
  const filtered = events.filter((event) => event.seq > afterSeq)
  return options.limit === undefined ? filtered : filtered.slice(0, options.limit)
}

export interface SessionTitle {
  readonly title: string
  /** 标题摘自哪一条事件——不是"我猜的"，是"这条 seq 的原文"，可以随时回去核对。 */
  readonly sourceSeq: number
}

/** 从第一条 user/message 摘一个标题，记录来源 seq。没有任何 user/message 时返回 undefined。 */
export function deriveTitle(events: readonly SessionEvent[], options: { readonly maxLength?: number } = {}): SessionTitle | undefined {
  const maxLength = options.maxLength ?? 60
  const firstUserMessage = events.find(
    (event): event is Extract<SessionEvent, { type: 'user/message' }> => event.type === 'user/message',
  )
  if (!firstUserMessage) return undefined

  const text = extractText(firstUserMessage.message).trim()
  if (text.length === 0) return undefined

  const title = text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
  return { title, sourceSeq: firstUserMessage.seq }
}

function extractText(message: Message): string {
  return message.blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
}
