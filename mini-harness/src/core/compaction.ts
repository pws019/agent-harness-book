import type { ContentBlock, Message } from '../llm/types.js'
import { collectCompactionRanges, Session, type SessionEvent } from './session.js'

export interface CompactionPlan {
  readonly fromSeq: number
  readonly toSeq: number
  readonly summary: Message
}

/**
 * 纯函数：决定"从哪到哪该被压缩、摘要长什么样"，不碰任何东西——不修改 events，
 * 不调用 Session.append()。真正落地是 applyCompaction() 的事，两者分开是"设计两次"
 * 里"先决定要不要做，再决定怎么做"这条原则的具体应用：`planCompaction` 出来的结果
 * 可以先审查、先测试，确认合理了再交给 `applyCompaction` 真正执行。
 *
 * 今天只做确定性裁剪那一半（对照 DSH："先实现确定性裁剪，再实现模型摘要"）：保留
 * 最近 `keepRecentSurfaceEvents` 条 surface 事件，把更早的全部压缩成一句话摘要——
 * 直接把被压缩范围里每条文本消息的原文拼起来，不做任何有损压缩。exercise.md 会让你
 * 把这半句"拼接"换成真正调用一个（假的）摘要模型。
 */
export function planCompaction(
  events: readonly SessionEvent[],
  options: { readonly keepRecentSurfaceEvents: number },
): CompactionPlan | undefined {
  // 已经被更早一次压缩覆盖过的 seq 直接排除——不然对同一段历史重复规划，会算出
  // 两个互相重叠的区间（`deriveMessages` 按 fromSeq 去重，重叠区间共用 fromSeq 时
  // 会互相打架）。只在"还没被压缩过"的 surface 事件里找压缩候选。
  const existingRanges = collectCompactionRanges(events)
  const alreadyCompacted = (seq: number): boolean => existingRanges.some((range) => seq >= range.fromSeq && seq <= range.toSeq)

  const surface = events.filter(isSurfaceEvent).filter((event) => !alreadyCompacted(event.seq))
  if (surface.length <= options.keepRecentSurfaceEvents) return undefined // 历史还不够长，不用压缩

  const toCompact = surface.slice(0, surface.length - options.keepRecentSurfaceEvents)
  const fromSeq = toCompact[0]!.seq
  const toSeq = toCompact[toCompact.length - 1]!.seq

  const facts = toCompact
    .filter((event): event is Extract<SessionEvent, { type: 'user/message' | 'assistant/message' }> => event.type !== 'tool/result')
    .map((event) => extractText(event.message))
    .filter((line) => line.length > 0)

  const summaryText = `[compacted ${toCompact.length} earlier events] ${facts.join(' | ')}`
  return { fromSeq, toSeq, summary: { role: 'assistant', blocks: [{ type: 'text', text: summaryText }] } }
}

function isSurfaceEvent(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: 'user/message' | 'assistant/message' | 'tool/result' }> {
  return event.type === 'user/message' || event.type === 'assistant/message' || event.type === 'tool/result'
}

function extractText(message: Message): string {
  return message.blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
}

/**
 * 真正落地一份压缩计划：追加 compaction/start -> compaction/summary -> compaction/end
 * 三条事件。**不删除、不改写**被压缩范围里的原始事件——它们还在日志里，只是
 * `deriveMessages()` 从这一刻起会跳过它们、换成这条摘要。
 *
 * 注意这三次 `append()` **不是原子的**：如果中间一次抛出异常（比如摘要内容不是
 * 无损 JSON），前面已经写进去的 `compaction/start` 不会被撤销，Session 会带着一个
 * 永远等不到 `compaction/end` 的"开着的压缩"——这是留给 exercise.md 任务3 的坑，
 * 故意没有在这里先修好。
 */
export function applyCompaction(session: Session, plan: CompactionPlan): void {
  session.append('compaction/start', { fromSeq: plan.fromSeq, toSeq: plan.toSeq })
  session.append('compaction/summary', { message: plan.summary })
  session.append('compaction/end', {})
}
