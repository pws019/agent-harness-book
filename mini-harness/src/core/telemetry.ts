import type { TokenUsage } from '../llm/types.js'
import type { Redactor } from './redact.js'
import type { SessionEvent } from './session.js'
import { TokenMeter, type TokenUsageTotals } from './token-meter.js'

/**
 * 两种要追踪延迟的活动——模型调用（一个 step 从开始到拿到 `assistant/message`
 * 花了多久）、工具调用（`tool/call` 到配对的 `tool/result` 花了多久）。判别联合，
 * 不是共用一个含糊的"activity"形状，跟 `SessionEvent`/`StreamEnvelope` 同一套纪律。
 */
export type TelemetryRecord =
  | {
      readonly kind: 'model-call'
      readonly turn: number
      readonly step: number
      /** 从 `step/start` 到 `assistant/message` 之间没有任何一条事件——说明这个 step
       * 是空的（比如被取消打断，见 `agent-handle.ts` "空消息不记"那条注释）,没有
       * 真正发生过一次模型调用,latency 是 `'unknown'`,不是硬编成 0。 */
      readonly latencyMs: number | 'unknown'
      readonly usage: TokenUsage | undefined
    }
  | {
      readonly kind: 'tool-call'
      readonly turn: number
      readonly step: number
      readonly callId: string
      readonly name: string
      readonly latencyMs: number | 'unknown'
      readonly isError: boolean
      /** 经过 `redactor`（如果给了）处理过的工具结果内容——这是唯一一处遥测会摸到
       * "工具真实输出了什么"的地方,也是唯一需要脱敏的地方（`SessionEvent` 其余字段
       * 只装凭据*引用*，不装真实值，见 Day20 `CredentialRef` 的设计）。 */
      readonly redactedContent: string
    }

/** 每 1000 个 token 的示例单价（美元）——**教学演示用，不对应任何真实 provider 的
 * 真实计费**，使用前先读 `modules/day28-telemetry-audit-eval/study.md` 的免责声明。 */
export interface CostRateTable {
  readonly inputPerKTokens: number
  readonly outputPerKTokens: number
}

export interface TelemetryReport {
  readonly records: readonly TelemetryRecord[]
  readonly totals: TokenUsageTotals
  readonly totalLatencyMs: number
  /** `costRates` 没给,或者累计 token 数是 `'unknown'`,结果都是 `'unknown'`——
   * 不会用一个已知的部分数字冒充"这就是总成本"。 */
  readonly estimatedCostUsd: number | 'unknown'
}

export interface DeriveTelemetryOptions {
  readonly redactor?: Redactor
  readonly costRates?: CostRateTable
}

/**
 * 从 `SessionEvent[]`（Day8 真源）派生出遥测报告——纯函数，不往 `ToolRegistry`/
 * `LlmAdapter` 里加任何钩子。延迟靠配对事件的 `time` 字段相减算：`step/start` 配
 * `assistant/message`（同一个 turn+step），`tool/call` 配 `tool/result`（同一个
 * callId）。这条信息本来就已经全部躺在事件日志里,跟 Day10 `projectSummary()`/
 * `deriveMessages()` 是同一个"从真源派生视图"的模式,不是重新采集一遍。
 */
export function deriveTelemetry(events: readonly SessionEvent[], options: DeriveTelemetryOptions = {}): TelemetryReport {
  const records: TelemetryRecord[] = []
  const meter = new TokenMeter()
  const stepStartedAt = new Map<string, number>()
  const toolCalledAt = new Map<string, { readonly time: number; readonly name: string }>()
  let totalLatencyMs = 0

  for (const event of events) {
    switch (event.type) {
      case 'step/start':
        stepStartedAt.set(`${event.turn}:${event.step}`, event.time)
        break
      case 'assistant/message': {
        const startedAt = stepStartedAt.get(`${event.turn}:${event.step}`)
        const latencyMs = startedAt !== undefined ? event.time - startedAt : 'unknown'
        if (typeof latencyMs === 'number') totalLatencyMs += latencyMs
        // 无条件调用 record()：省略的 usage 也要真的喂给 meter，让它按 TokenMeter 自己
        // 的纪律翻译成 'unknown'——只在 usage 存在时才调用会让"没上报"和"报了 0"完全
        // 没有区别，meter 的初始值本来就是 0，永远不会被推成 'unknown'。
        meter.record(event.usage)
        records.push({ kind: 'model-call', turn: event.turn, step: event.step, latencyMs, usage: event.usage })
        break
      }
      case 'tool/call':
        toolCalledAt.set(event.callId, { time: event.time, name: event.name })
        break
      case 'tool/result': {
        const called = toolCalledAt.get(event.callId)
        const latencyMs = called !== undefined ? event.time - called.time : 'unknown'
        if (typeof latencyMs === 'number') totalLatencyMs += latencyMs
        const content = options.redactor ? options.redactor(event.content) : event.content
        records.push({
          kind: 'tool-call',
          turn: event.turn,
          step: event.step,
          callId: event.callId,
          name: called?.name ?? '(unknown tool — no matching tool/call seen)',
          latencyMs,
          isError: event.isError,
          redactedContent: content,
        })
        break
      }
      default:
        break
    }
  }

  const totals = meter.totals()
  const estimatedCostUsd: number | 'unknown' =
    options.costRates && typeof totals.inputTokens === 'number' && typeof totals.outputTokens === 'number'
      ? (totals.inputTokens / 1000) * options.costRates.inputPerKTokens + (totals.outputTokens / 1000) * options.costRates.outputPerKTokens
      : 'unknown'

  return { records, totals, totalLatencyMs, estimatedCostUsd }
}
