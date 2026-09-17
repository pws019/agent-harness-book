import type { ContentBlock, Message } from '../llm/types.js'
import { collectCompactionRanges, isJsonValue, Session, SessionAppendError, type SessionEvent, type SessionSink } from './session.js'

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

  // 每一行都带上原始 role 前缀（user/assistant），不能只把文本无差别拼在一起——
  // 内容本身没删字不代表没丢信息，"这句话原本是谁说的"也是历史事实的一部分，
  // 混在一起拼接会把它悄悄丢掉，跟"确定性裁剪不做有损压缩"这条承诺对不上。
  const facts = toCompact
    .filter((event): event is Extract<SessionEvent, { type: 'user/message' | 'assistant/message' }> => event.type !== 'tool/result')
    .map((event) => ({ role: event.message.role, text: extractText(event.message) }))
    .filter(({ text }) => text.length > 0)
    .map(({ role, text }) => `${role}: ${text}`)

  const summaryText = `[compacted ${toCompact.length} earlier events]\n${facts.join('\n')}`
  // summary 整体包成一条 role: 'assistant' 的消息——不是因为内容真的是"模型说的"，
  // 是因为 Message.role 只有 user/assistant/tool 三种，没有"系统生成的摘要"这个选项。
  // 标成 assistant 让模型把它理解成"agent 自己对历史的一次陈述"；标成 user 会让模型
  // 误以为这一大段（包括原本是模型自己说的话）全是用户说的，在"这句话该归因给谁"
  // 这件事上制造混淆——上面按行保留的 role 前缀，就是用来弥补"外层包装必须二选一"
  // 这个限制、不让说话人身份彻底丢失的手段。
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
 * 这三次 `append()` 本身不是原子的：如果中间一次抛出异常，前面已经写进去的
 * `compaction/start` 不会被自动撤销。但把 `Session` 三次 `append()` 里唯一可能因为
 * "数据本身不合法"而失败的那一步（`compaction/summary` 的 `isJsonValue` 校验）挑出来，
 * 提前到任何一次 `append()` 被调用之前做一遍，就能保证：只要这次校验通过，后面三次
 * `append()` 全部只依赖状态机（调用顺序对不对），不会再因为 payload 内容失败——
 * 也就不会留下一个永远等不到 `compaction/end` 的"半开着的压缩"。这是"验证一次、
 * 再提交"（validate-then-commit），不是给 `Session` 添加撤销/回滚能力——`compaction/start`
 * 目前只有这一个调用方，把校验放在这唯一的入口最前面，跟教 `Session` 自己识别"半开
 * 压缩"这种更通用的兜底相比，今天的防护力是等价的，复杂度低得多。
 */
/** `sink` 是可选的（Day30 `Agent.compact()` 才第一次真正传它）——不给就是原来的
 * 行为，只改 `session` 内存里的日志；给了就跟 `closeDanglingActivity()`（Day9）
 * 同一个纪律，每一条追加的事件都顺手转发一份给 `sink`，不然通过 `Agent.compact()`
 * 触发的压缩只会进内存、不会镜像进持久化 store 或广播给正在监听的客户端。 */
export function applyCompaction(session: Session, plan: CompactionPlan, sink?: SessionSink): void {
  if (!isJsonValue(plan.summary)) {
    throw new SessionAppendError('compaction summary 不是无损 JSON，拒绝开始一次注定完成不了的压缩')
  }
  // 故意不写成 `sink?.append(session.append(...))`——可选链会连同它的参数表达式
  // 一起短路：`sink` 是 `undefined` 时,`session.append(...)` 根本不会被求值,
  // 这次压缩会悄悄变成完全没发生过。拆成两条语句,`session.append()` 永远真的执行。
  const start = session.append('compaction/start', { fromSeq: plan.fromSeq, toSeq: plan.toSeq })
  sink?.append(start)
  const summary = session.append('compaction/summary', { message: plan.summary })
  sink?.append(summary)
  const end = session.append('compaction/end', {})
  sink?.append(end)
}
