import type { SessionEvent } from './session.js'

/**
 * 大工具结果的外置存储。跟 Day4 `search_text` 的截断策略解决的是同一类问题——
 * "永不静默丢弃，只是不一次性都塞进主日志里"，只是这次的做法是把超长内容整个
 * 搬到别处，主日志里留一个可以按需换回来的引用，而不是截断内容本身。
 */
export interface SpillStore {
  /** 存一份内容，返回一个可以用来换回它的 id。 */
  put(content: string): string
  /** 换回内容；id 不存在返回 undefined，不抛异常（调用方决定怎么处理"找不到"）。 */
  get(id: string): string | undefined
}

export class InMemorySpillStore implements SpillStore {
  private readonly items = new Map<string, string>()
  private counter = 0

  put(content: string): string {
    const id = `spill-${this.counter++}`
    this.items.set(id, content)
    return id
  }

  get(id: string): string | undefined {
    return this.items.get(id)
  }
}

/**
 * 一次性的日志变换：把超过 `maxContentLength` 的 tool/result.content 搬进 `store`，
 * 原地换成一段说明"内容多长、去哪能找到完整内容"的占位文本。刻意做成一个独立的
 * 纯函数变换，而不是直接改 `Session`/`Agent`——今天这个能力还没有真实调用方需要它
 * 实时生效（YAGNI），先证明"分离引用和内容"这个机制本身是对的；等哪天真的需要
 * 在 Agent 写入的同时就 spill，再考虑把它接进 `Agent.appendEvent()` 那层。
 */
export function spillLargeToolResults(
  events: readonly SessionEvent[],
  store: SpillStore,
  maxContentLength: number,
): readonly SessionEvent[] {
  return events.map((event) => {
    if (event.type !== 'tool/result' || event.content.length <= maxContentLength) return event
    const id = store.put(event.content)
    return { ...event, content: `[output too large: ${event.content.length} chars, spilled as "${id}"]` }
  })
}
