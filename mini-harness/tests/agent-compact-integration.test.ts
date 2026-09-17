import { describe, expect, it } from 'vitest'
import { Agent } from '../src/core/agent-handle.js'
import { deriveMessages } from '../src/core/session.js'
import { LlmAdapter } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'

/**
 * Day13 `planCompaction()`/`applyCompaction()` 从写出来那天起就是两个从没被 `Agent`
 * 真正调用过的纯函数——`Agent.compact()`（Day30）是第一次把它们接进一个真实
 * `Agent` 实例。这条测试专门测这条接缝本身，不是重新测 `planCompaction`/
 * `applyCompaction` 各自的逻辑（那是 `tests/compaction.test.ts` 的事）。
 */

function userText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}
function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

class SimpleReplyAdapter extends LlmAdapter {
  private turn = 0
  async *stream(): AsyncIterable<StreamChunk> {
    this.turn += 1
    yield* streamFake({ message: assistantText(`reply ${this.turn}`), finishReason: { kind: 'stop' } })
  }
}

describe('Agent.compact(): the missing caller for Day13 planCompaction()/applyCompaction()', () => {
  it('returns undefined and appends nothing when there is not enough history yet', async () => {
    const agent = new Agent({ adapter: new SimpleReplyAdapter(), tools: new ToolRegistry(), provider: 'demo', model: 'x' })
    agent.send(userText('hi'))
    await agent.whenIdle()

    const eventCountBefore = agent.sessionEvents.length
    const plan = agent.compact({ keepRecentSurfaceEvents: 100 })
    expect(plan).toBeUndefined()
    expect(agent.sessionEvents.length).toBe(eventCountBefore)
  })

  it('compacts real history produced by real turns, and deriveMessages() reflects the summary in place', async () => {
    const agent = new Agent({ adapter: new SimpleReplyAdapter(), tools: new ToolRegistry(), provider: 'demo', model: 'x' })
    for (let i = 0; i < 5; i++) {
      agent.send(userText(`question ${i}`))
      await agent.whenIdle()
    }

    const plan = agent.compact({ keepRecentSurfaceEvents: 2 })
    expect(plan).toBeDefined()

    const messages = deriveMessages(agent.sessionEvents)
    // 摘要（1条） + 最后保留的 2 个 surface 事件（user+assistant）
    expect(messages).toHaveLength(3)
    expect(agent.sessionEvents.some((e) => e.type === 'compaction/start')).toBe(true)
  })

  it('every compaction event is forwarded to deps.sink, not just appended to the in-memory session', async () => {
    const forwarded: string[] = []
    const agent = new Agent({
      adapter: new SimpleReplyAdapter(),
      tools: new ToolRegistry(),
      provider: 'demo',
      model: 'x',
      sink: { append: (event) => forwarded.push(event.type) },
    })
    for (let i = 0; i < 5; i++) {
      agent.send(userText(`question ${i}`))
      await agent.whenIdle()
    }
    forwarded.length = 0 // 只关心 compact() 这一步转发了什么，把前面几轮 turn 产生的记录清掉

    const plan = agent.compact({ keepRecentSurfaceEvents: 2 })
    expect(plan).toBeDefined()
    expect(forwarded).toEqual(['compaction/start', 'compaction/summary', 'compaction/end'])
  })

  it('compacting a disposed agent throws instead of silently mutating a session nobody is watching anymore', async () => {
    const agent = new Agent({ adapter: new SimpleReplyAdapter(), tools: new ToolRegistry(), provider: 'demo', model: 'x' })
    agent.send(userText('hi'))
    await agent.whenIdle()
    await agent.dispose()

    expect(() => agent.compact({ keepRecentSurfaceEvents: 0 })).toThrow('disposed')
  })
})
