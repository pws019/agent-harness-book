import type { StreamEnvelope } from '../server/wire-protocol.js'
import type { Conversation } from './conversation.js'

/**
 * 建立一次连接、产出一串 envelope 的能力——一个接口，两种实现：`http-stream-connector.ts`
 * 打真实的 `GET /sessions/:id/events`；`fault-injecting-transport.ts`（仅测试用）在内存里
 * 重放一份录好的事件日志，故意制造缺口/重复/乱序/断线。`runReconnectingStream()` 本身
 * 完全不知道底下连的是真实 socket 还是假的重放器。
 */
export interface StreamConnector {
  /** `since` 是重连时要带的游标：第一次连接传 `undefined`（服务端理解成"给我完整历史"），
   * 之后每次都是 `conversation.cursor`——`Conversation` 自己算好的"确认连续"游标，
   * 不是"见过的最大 seq"（见 conversation.ts 的说明，这个区别正是缺口测试要验证的）。 */
  connect(since: number | undefined, signal: AbortSignal): AsyncIterable<StreamEnvelope>
}

export interface ReconnectingStreamOptions {
  readonly connector: StreamConnector
  readonly conversation: Conversation
  /** 每次因为 `transport-error`（或者连接本身抛异常）触发重连之前，等待这么久——
   * 避免转瞬间无限重试把对方打爆。默认 0，方便测试不用真的等。 */
  readonly retryDelayMs?: number
  /** 连续失败超过这个次数就放弃，不再无限重试下去。 */
  readonly maxRetries?: number
  /** 每应用完一条 envelope 就调用一次——给 UI 层一个"有新内容了"的钩子,不用自己
   * 轮询 `conversation.messages` 猜有没有变化。 */
  readonly onEnvelope?: () => void
}

export class StreamGaveUpError extends Error {
  constructor(attempts: number, cause: unknown) {
    super(`gave up reconnecting after ${attempts} attempts: ${String(cause)}`)
    this.name = 'StreamGaveUpError'
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * 跑一条"连接 -> 把每条 envelope 喂给 Conversation -> 连接断了就重连"的循环，直到：
 * 正常收到 `terminal`（这次任务真的做完了，不需要再连）、调用方 abort、或者连续失败
 * 次数超过 `maxRetries`（放弃，抛 `StreamGaveUpError`）。
 *
 * 重连时传给 `connector.connect()` 的 `since` 永远是 `conversation.cursor`——这保证了
 * study.md §3 讲的那条规则：请求的是"确认连续"的游标，不是"见过的最大 seq"，中间
 * 有缺口的话，重连会让服务端从缺口之前开始重发，缺口才真的能被补上。
 */
export async function runReconnectingStream(options: ReconnectingStreamOptions, signal: AbortSignal): Promise<void> {
  const { connector, conversation } = options
  const maxRetries = options.maxRetries ?? 5
  let attempt = 0

  while (!signal.aborted) {
    let terminalLastSeq: number | undefined
    let failure: unknown

    try {
      const since = conversation.cursor < 0 ? undefined : conversation.cursor
      for await (const envelope of connector.connect(since, signal)) {
        conversation.applyEnvelope(envelope)
        options.onEnvelope?.()
        if (envelope.kind === 'terminal') terminalLastSeq = envelope.lastSeq
        if (envelope.kind === 'transport-error') failure = new Error(envelope.message)
      }
    } catch (error) {
      if (signal.aborted) return
      failure = error
    }

    // 收到 terminal 不等于"真的同步完了"——如果这次连接里中途丢了一条（不是最后
    // 一条）事件，`terminal.lastSeq` 依然会被正常发出来，但 `conversation.cursor`
    // 会卡在缺口那里追不上。只有游标真的追到 `lastSeq` 才算数,不然会带着一个永远
    // 补不上的缺口提前收工——这是亲手跑故障注入测试才抓到的一个真实设计缺陷,
    // 不是从一开始就想到的。
    if (terminalLastSeq !== undefined && failure === undefined && conversation.cursor >= terminalLastSeq) return
    if (signal.aborted) return

    attempt += 1
    if (attempt > maxRetries) throw new StreamGaveUpError(attempt - 1, failure)
    await delay(options.retryDelayMs ?? 0, signal)
  }
}
