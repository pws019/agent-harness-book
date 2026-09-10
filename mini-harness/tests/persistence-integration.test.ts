import { describe, expect, it } from 'vitest'
import { Agent } from '../src/core/agent-handle.js'
import { InMemoryRawStore, JsonlSessionStore } from '../src/core/persistence.js'
import { Session } from '../src/core/session.js'
import { LlmAdapter } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { FinishReason, Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'

function userText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

function assistantToolCall(id: string, name: string, args: unknown): Message {
  return { role: 'assistant', blocks: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] }
}

class ScriptedAdapter extends LlmAdapter {
  private call = 0
  constructor(private readonly script: readonly Message[]) {
    super()
  }
  async *stream(): AsyncIterable<StreamChunk> {
    const message = this.script[Math.min(this.call, this.script.length - 1)]!
    this.call += 1
    const hasToolCall = message.blocks.some((b) => b.type === 'tool-call')
    const finishReason: FinishReason = hasToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
    yield* streamFake({ message, finishReason })
  }
}

describe('Agent + SessionSink: live persistence mirrors every append', () => {
  it('the store ends up with exactly the same events as agent.sessionEvents, in order', async () => {
    const raw = new InMemoryRawStore()
    const store = JsonlSessionStore.create(raw)
    const agent = new Agent({
      adapter: new ScriptedAdapter([assistantText('ok')]),
      tools: new ToolRegistry(),
      provider: 'fake',
      model: 'x',
      sink: store,
    })

    agent.send(userText('hi'))
    await agent.whenIdle()

    const loaded = store.load()
    expect(loaded.truncated).toBe(false)
    expect(loaded.events).toEqual(agent.sessionEvents)
  })
})

describe('Agent.restore: resuming after a simulated crash', () => {
  it('closes a log that ends mid-tool-call, and a fresh turn continues the turn numbering', async () => {
    // 手工搭一份"看起来像真实崩溃"的日志：turn 开了、有一个 step、模型请求了一次工具调用，
    // 然后什么都没有了——没有 tool/result，没有 step/end，没有 turn/end。
    const crashed = new Session()
    crashed.append('turn/start', { turn: 0 })
    crashed.append('user/message', { turn: 0, message: userText('go') })
    crashed.append('step/start', { turn: 0, step: 1 })
    crashed.append('assistant/message', { turn: 0, step: 1, message: assistantToolCall('c1', 'echo', {}) })
    crashed.append('tool/call', { turn: 0, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })

    const agent = Agent.restore(
      {
        adapter: new ScriptedAdapter([assistantText('continuing')]),
        tools: new ToolRegistry(),
        provider: 'fake',
        model: 'x',
      },
      crashed.events,
    )

    expect(agent.sessionEvents.map((e) => e.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result', // 恢复时补写的合成结果
      'step/end',
      'turn/end',
    ])
    expect(agent.history).toEqual([
      userText('go'),
      assistantToolCall('c1', 'echo', {}),
      {
        role: 'tool',
        blocks: [{ type: 'tool-result', toolCallId: 'c1', content: 'turn ended before this call produced a result', isError: true }],
      },
    ])

    // 恢复之后的 Agent 必须能正常继续接受新消息，且新 turn 的编号接着来，不会跟已经
    // 关闭的那个 turn 0 撞车。
    agent.send(userText('are you still there?'))
    await agent.whenIdle()

    const turnStarts = agent.sessionEvents.filter((e) => e.type === 'turn/start') as ReadonlyArray<{ readonly turn: number }>
    expect(turnStarts.map((e) => e.turn)).toEqual([0, 1])
    expect(agent.records).toHaveLength(1) // 只有恢复后真正跑的这一个 turn 会进 records
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
  })

  it('restoring a cleanly-closed log (no crash) leaves it untouched and starts the next turn at the right number', async () => {
    const clean = new Session()
    clean.append('turn/start', { turn: 0 })
    clean.append('user/message', { turn: 0, message: userText('hi') })
    clean.append('step/start', { turn: 0, step: 1 })
    clean.append('assistant/message', { turn: 0, step: 1, message: assistantText('hello') })
    clean.append('step/end', { turn: 0, step: 1 })
    clean.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    const agent = Agent.restore(
      { adapter: new ScriptedAdapter([assistantText('again')]), tools: new ToolRegistry(), provider: 'fake', model: 'x' },
      clean.events,
    )

    expect(agent.sessionEvents).toEqual(clean.events) // 没有多写任何收尾事件
    expect(agent.history).toEqual([userText('hi'), assistantText('hello')])

    agent.send(userText('follow-up'))
    await agent.whenIdle()
    const turnStarts = agent.sessionEvents.filter((e) => e.type === 'turn/start') as ReadonlyArray<{ readonly turn: number }>
    expect(turnStarts.map((e) => e.turn)).toEqual([0, 1])
  })
})
