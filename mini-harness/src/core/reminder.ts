import type { Agent } from './agent-handle.js'
import type { Message } from '../llm/types.js'

export interface Reminder {
  /** 取消这条还没触发的提醒——已经触发过的再调用是 no-op。 */
  readonly dispose: () => void
}

/**
 * "只负责重新送达事件"——大纲原话。这句话本身就是全部设计：`Reminder` 不是一个
 * 新的架构层,就是 Day6 `Agent.steer()` 套一层定时触发。到点了,把 `message` 作为
 * 一条引导消息插进 `Agent` 当前活动的下一个 step（`steer()` 已有的语义,今天没有
 * 新增任何行为）。故意不做成一个有自己状态机、自己生命周期概念的"子系统"——
 * 那会是过度设计：`setTimeout` + `dispose()` 已经完整覆盖了"定时提醒"需要的全部
 * 能力，没有更多东西值得抽象。
 */
export function scheduleReminder(agent: Agent, message: Message, delayMs: number): Reminder {
  const timer = setTimeout(() => agent.steer(message), delayMs)
  return {
    dispose: () => clearTimeout(timer),
  }
}
