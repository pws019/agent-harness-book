import { deriveMessages, type SessionEvent } from '../core/session.js'
import type { Message } from '../llm/types.js'
import { assertNeverEnvelope, type StreamEnvelope } from '../server/wire-protocol.js'

/**
 * 客户端这边"到目前为止真正见过、并且确认没有缺口"的事件历史。故障注入要挡的
 * 四种情况——重复、乱序、缺口、断线期间任务结束——在这里各自对应一个具体机制：
 *
 * - **重复**：`events` 是按 `seq` 建索引的 `Map`，同一个 `seq` 写两次，第二次只是把
 *   一份完全相同的数据原样覆盖一遍，不会产生副作用（`SessionEvent` 本身是不可变的，
 *   同一个 `seq` 对应的内容不会变）。
 * - **乱序**：`Map` 的写入顺序不影响最终查出来的内容——`confirmedEvents` 读取时会
 *   按 `seq` 数值重新排序，不看事件到达的先后。
 * - **缺口**：`highestContiguousSeq` 只会在"下一个 seq 也已经到齐"的时候才前进
 *   （`advanceContiguous()`）——如果 `seq=5` 迟迟没到，哪怕 `seq=6/7/8` 已经到了，
 *   `confirmedEvents`/`messages` 也只会算到 `seq=4` 为止，不会把 6/7/8 提前派生进去，
 *   更不会因为中间缺了一段就让 `deriveMessages()`（Day8）在不完整的日志上算出错误结果。
 * - **断线期间任务结束**：`terminal`/`transport-error` 这两种 envelope 不改变
 *   `events`/`highestContiguousSeq`——它们是连接层面的信号，交给 `reconnecting-stream.ts`
 *   处理"要不要重连"，`Conversation` 只关心事件本身,不关心"这次连接是怎么结束的"。
 */
export class Conversation {
  private readonly events = new Map<number, SessionEvent>()
  private highestContiguousSeq = -1

  applyEnvelope(envelope: StreamEnvelope): void {
    switch (envelope.kind) {
      case 'baseline':
        for (const event of envelope.snapshot) this.events.set(event.seq, event)
        this.advanceContiguous()
        return
      case 'increment':
        this.events.set(envelope.event.seq, envelope.event)
        this.advanceContiguous()
        return
      case 'terminal':
      case 'transport-error':
        return
      default:
        assertNeverEnvelope(envelope)
    }
  }

  private advanceContiguous(): void {
    while (this.events.has(this.highestContiguousSeq + 1)) {
      this.highestContiguousSeq += 1
    }
  }

  /** 确认连续、没有缺口的那一段事件——跳过任何还没补齐的空洞之后的所有内容，
   * 哪怕那部分内容其实已经到了（存在 `events` 里，只是还没轮到它们"生效"）。 */
  get confirmedEvents(): readonly SessionEvent[] {
    const result: SessionEvent[] = []
    for (let seq = 0; seq <= this.highestContiguousSeq; seq++) {
      result.push(this.events.get(seq)!)
    }
    return result
  }

  /** 从确认连续的那段事件派生出的完整对话——直接复用 Day8 `deriveMessages()`，
   * 不重新发明一套"客户端要怎么把事件拼成消息"的逻辑。 */
  get messages(): readonly Message[] {
    return deriveMessages(this.confirmedEvents)
  }

  /** 断线重连时应该带上的游标——是"确认连续"的那个 seq，不是"见过的最大 seq"。
   * 如果后者更大（说明中间有缺口，只是缺口后面的部分提前到了），用它去重连反而会
   * 让服务端以为缺口那部分已经不需要补了,永远补不上。 */
  get cursor(): number {
    return this.highestContiguousSeq
  }
}
