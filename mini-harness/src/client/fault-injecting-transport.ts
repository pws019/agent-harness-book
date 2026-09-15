import { mulberry32 } from '../llm/fake-adapter.js'
import type { SessionEvent } from '../core/session.js'
import type { StreamEnvelope } from '../server/wire-protocol.js'
import type { StreamConnector } from './reconnecting-stream.js'

export interface FaultInjectionOptions {
  /** 跟 Day2/3 `FakeAdapterOptions.seed` 同一个 `mulberry32` 种子 PRNG——同一个种子
   * 每次跑出同样的故障序列，测试结果可复现，不是"随便加点随机性意思意思"。 */
  readonly seed: number
  /** 每条事件被复制发两遍的概率（模拟重复投递）。 */
  readonly duplicateProbability?: number
  /** 每条事件跟下一条调换发送顺序的概率（模拟乱序到达）。 */
  readonly reorderProbability?: number
  /** 每条事件被直接跳过的概率（模拟丢包——制造一个 `Conversation` 需要补的缺口）。 */
  readonly dropProbability?: number
  /** 这次连接提前被掐断（发一条 `transport-error` 然后终止）的概率，每条事件发送前判一次。 */
  readonly disconnectProbability?: number
}

/**
 * 一个完全不碰真实网络的 `StreamConnector`：拿一份"录好的、真实跑出来的完整事件日志"
 * 当作权威真相，`connect(since)` 重放 `seq > since` 的那部分，重放过程中按种子 PRNG
 * 故意制造缺口/重复/乱序/断线——`tests/client-reconnection.test.ts` 用它跑几百轮不同
 * 的故障组合，断言 `Conversation` 最终收敛到的状态跟这份"录好的真相"完全一致，不需要
 * 起任何真实 socket（真实 socket 的故障注入已经在 Day22 `tests/http-server.test.ts`
 * 里用真实 IO 验证过，这里要验证的是合并算法本身，两者关注点不同）。
 *
 * 每次 `connect()` 都是"一次新的连接"——`disconnectProbability` 触发时只是提前终止
 * 这次重放,调用方（`runReconnectingStream`）会用新的 `since` 重新调用 `connect()`,
 * 这正是在模拟"断线后重连"这件事本身。
 */
export function createFaultInjectingConnector(fullLog: readonly SessionEvent[], options: FaultInjectionOptions): StreamConnector {
  const rand = mulberry32(options.seed)

  return {
    async *connect(since): AsyncIterable<StreamEnvelope> {
      const startAfter = since ?? -1
      const queue = fullLog.filter((event) => event.seq > startAfter)

      yield { kind: 'baseline', snapshot: [] } // 这个假连接器把所有内容都当 increment 发，baseline 永远空

      const lastEvent = fullLog.at(-1)
      let deliveredFinalEvent = false

      while (queue.length > 0) {
        if (rand() < (options.disconnectProbability ?? 0)) {
          yield { kind: 'transport-error', message: 'fault-injected disconnect' }
          return
        }
        if (rand() < (options.dropProbability ?? 0)) {
          queue.shift()
          continue
        }
        if (queue.length > 1 && rand() < (options.reorderProbability ?? 0)) {
          const [first, second] = queue
          queue[0] = second!
          queue[1] = first!
        }
        const event = queue.shift()!
        yield { kind: 'increment', event }
        if (event.seq === lastEvent?.seq) deliveredFinalEvent = true
        if (rand() < (options.duplicateProbability ?? 0)) {
          yield { kind: 'increment', event }
        }
      }

      // 发 terminal 的条件是"这条最后的事件已经确认到达过"——可能是这次连接里
      // 刚送到（deliveredFinalEvent），也可能是调用方带着已经追上了的 since 重连进来
      // （queue 从一开始就是空的，这次根本没有新东西要发）。只看 deliveredFinalEvent
      // 会漏掉后一种情况：数据其实已经在更早的连接里齐了，但这次 queue 是空的、
      // deliveredFinalEvent 永远是 false，于是 terminal 永远发不出去，重连会死循环。
      const alreadyCaughtUp = lastEvent !== undefined && startAfter >= lastEvent.seq
      if ((deliveredFinalEvent || alreadyCaughtUp) && lastEvent?.type === 'turn/end') {
        yield {
          kind: 'terminal',
          reason: lastEvent.reason.kind === 'budget_exhausted' ? 'error' : lastEvent.reason.kind,
          lastSeq: lastEvent.seq,
        }
      }
    },
  }
}
