import { encodeEnvelope, type StreamEnvelope } from './wire-protocol.js'

export interface BacklogWriterOptions {
  /** 这条连接允许"写出去但还没被真正 flush 掉"的字节上限。 */
  readonly maxBytes: number
  /** 真正把一行文本交给底层传输——`onFlushed` 必须在这一行真的被底层接受之后才调用
   * （对 `node:http` 来说就是 `res.write(line, onFlushed)` 的第二个参数），不能提前调用，
   * 否则 backlog 记账会失真。 */
  readonly write: (line: string, onFlushed: () => void) => void
  /** 超过上限时调用一次（只会调用一次——超限之后这个 writer 直接进入"已放弃"状态）。 */
  readonly onOverflow: () => void
}

/**
 * 把"这条连接还欠着多少字节没有真正发出去"这件事从 `node:http` 的真实 socket 上剥离出来，
 * 做成一个不依赖任何真实 IO 的纯逻辑单元——`http-server.ts` 用真实的 `res.write()` 接它，
 * 测试可以用一个完全受控的假 `write`（比如"永远不调用 onFlushed，模拟一个死活不读的慢客户端"）
 * 来确定性地验证"超过上限就报 `transport-error` 并且不再继续写"这条规则，不用依赖操作系统
 * 真实缓冲区大小这种平台相关、没法精确控制时机的东西。
 */
export function createBacklogWriter(options: BacklogWriterOptions): (envelope: StreamEnvelope) => boolean {
  let backlogBytes = 0
  let overflowed = false

  return (envelope: StreamEnvelope): boolean => {
    if (overflowed) return false
    const line = encodeEnvelope(envelope)
    const byteLength = Buffer.byteLength(line)
    if (backlogBytes + byteLength > options.maxBytes) {
      overflowed = true
      options.onOverflow()
      return false
    }
    backlogBytes += byteLength
    options.write(line, () => {
      backlogBytes -= byteLength
    })
    return true
  }
}
