import type { SessionEvent } from '../core/session.js'

/**
 * 一次流式响应里，每一条换行分隔 JSON 消息的形状——四选一，封闭联合类型，
 * 跟 `SessionEvent`/`UserInteractionRequest` 同一套 `assertNever` 纪律。
 *
 * - `baseline`：这路连接刚建立（或者客户端带着 `?since=` 重新连上）时，把"到目前为止
 *   完整历史"一次性发过去——`snapshot` 直接复用 Day8 `SessionEvent[]`,不发明新的快照格式。
 * - `increment`：baseline 发完之后，新产生的每一条 `SessionEvent` 单独包一层再发一条。
 *   游标就是 `event.seq`（Day8 已经有,不重新发明）——客户端记住收到的最后一个 seq,
 *   断线重连时带着它去请求 baseline,就能只补"断线期间漏掉的那一段"。
 * - `terminal`：**应用层**的结束——这次连接对应的那个 turn 跑完了（正常完成/被取消/出错），
 *   HTTP 响应即将正常关闭,不代表连接出了问题。
 * - `transport-error`：**传输层**的结束——服务器因为某个跟 Agent 状态无关的原因（比如
 *   这个连接的积压缓冲超限）要强制关闭连接,客户端应该按"这次连接失败了,该重连"处理,
 *   不能当成"Agent 那边出错了"。
 *
 * `terminal` 和 `transport-error` 的区别正是原始大纲点名要区分的那两种"流结束"——
 * 一个是"事情做完了",一个是"管道本身断了",客户端对这两者的正确反应完全不同
 * （前者可以放心展示"完成"，后者应该重连）。
 */
export type StreamEnvelope =
  | { readonly kind: 'baseline'; readonly snapshot: readonly SessionEvent[] }
  | { readonly kind: 'increment'; readonly event: SessionEvent }
  | { readonly kind: 'terminal'; readonly reason: 'completed' | 'cancelled' | 'error'; readonly lastSeq: number }
  | { readonly kind: 'transport-error'; readonly message: string }

export function assertNeverEnvelope(value: never): never {
  throw new Error(`Unhandled StreamEnvelope variant: ${JSON.stringify(value)}`)
}

/** 换行分隔 JSON：每条 envelope 独占一行，客户端按 `\n` 切分、逐行 `JSON.parse()`。
 * 选它不选 SSE 的 `text/event-stream` 格式——少一层 `data: `/空行 framing 语法，
 * 客户端用一个普通的 `ReadableStream` + 按行切分就能读，不需要专门认识 SSE 这个
 * HTTP 之上再加一层的协议，对不熟悉后端协议栈的读者更容易顺着已有知识读懂。 */
export function encodeEnvelope(envelope: StreamEnvelope): string {
  return JSON.stringify(envelope) + '\n'
}

/** 解析一行——调用方负责先按 `\n` 切好行（处理半行留到下一次 chunk 再拼的情况不是这个
 * 函数的职责，那是"读流"这一层的事，见 `src/client/` Day23 会用到的解析逻辑）。 */
export function decodeEnvelopeLine(line: string): StreamEnvelope {
  return JSON.parse(line) as StreamEnvelope
}
