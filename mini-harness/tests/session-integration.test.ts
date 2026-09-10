import { describe, expect, it } from 'vitest'
import { Agent } from '../src/core/agent-handle.js'
import { deriveMessages } from '../src/core/session.js'
import { LlmAdapter, type GenerateOptions } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { FinishReason, Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ToolTimeoutError, type ToolDefinition } from '../src/tools/types.js'

/**
 * 验证 Day9 的核心承诺：`Agent.history` 现在确实是从 `sessionEvents` 派生出来的，
 * 不是另一份可能漂移的数组；以及"异常终止"时 Session 的开闭配对不变式不会被打破。
 */

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

function echoTool(): ToolDefinition<string> {
  return {
    name: 'echo',
    description: 'returns whatever text argument it was given',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => value },
    timeoutMs: 1_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return (args as { text: string }).text
    },
  }
}

function flakyTimeoutTool(): ToolDefinition<never> {
  return {
    name: 'flaky',
    description: 'always throws ToolTimeoutError, to simulate a tool that never produces a result',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    output: { schema: { type: 'string' }, render: () => '' },
    timeoutMs: 1_000,
    isConcurrencySafe: () => true,
    async execute(): Promise<never> {
      throw new ToolTimeoutError('fake timeout for testing')
    },
  }
}

function newAgent(adapter: LlmAdapter, tools = new ToolRegistry()): Agent {
  return new Agent({ adapter, tools, provider: 'fake', model: 'x' })
}

describe('Agent.history is derived from sessionEvents, not a separately maintained array', () => {
  it('a single-step text turn produces the expected event shape and a matching derived history', async () => {
    const agent = newAgent(new ScriptedAdapter([assistantText('42')]))
    agent.send(userText('what is the answer?'))
    await agent.whenIdle()

    expect(agent.sessionEvents.map((e) => e.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(agent.history).toEqual(deriveMessages(agent.sessionEvents))
    expect(agent.history).toEqual([userText('what is the answer?'), assistantText('42')])
  })

  it('a multi-step tool-call turn logs tool/call and tool/result, grouped correctly on derivation', async () => {
    const tools = new ToolRegistry()
    tools.define(echoTool())
    const agent = newAgent(new ScriptedAdapter([assistantToolCall('c1', 'echo', { text: 'hi' }), assistantText('done')]), tools)

    agent.send(userText('echo hi'))
    await agent.whenIdle()

    const types = agent.sessionEvents.map((e) => e.type)
    expect(types).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    expect(agent.history).toEqual([
      userText('echo hi'),
      assistantToolCall('c1', 'echo', { text: 'hi' }),
      { role: 'tool', blocks: [{ type: 'tool-result', toolCallId: 'c1', content: 'hi', isError: false }] },
      assistantText('done'),
    ])
  })

  it('turn numbers increment across successive send() calls, and each carries the right history', async () => {
    const agent = newAgent(new ScriptedAdapter([assistantText('first'), assistantText('second')]))
    agent.send(userText('one'))
    await agent.whenIdle()
    agent.send(userText('two'))
    await agent.whenIdle()

    const turnStarts = agent.sessionEvents.filter((e) => e.type === 'turn/start')
    expect(turnStarts.map((e) => (e as { turn: number }).turn)).toEqual([0, 1])
    expect(agent.history).toHaveLength(4)
  })
})

describe('Agent.history survives abnormal turn termination without breaking Session invariants', () => {
  it('a tool timeout mid-step still produces a well-formed, closed event log', async () => {
    const tools = new ToolRegistry()
    tools.define(flakyTimeoutTool())
    const agent = newAgent(new ScriptedAdapter([assistantToolCall('c1', 'flaky', {})]), tools)

    agent.send(userText('go'))
    // 不应该抛出任何异常——如果 drain() 的异常终止补写逻辑漏了什么，Session.append() 会在
    // 内部抛 SessionAppendError，whenIdle() 背后的 drain() promise 会带着这个异常 reject。
    await expect(agent.whenIdle()).resolves.toBeUndefined()

    expect(agent.sessionEvents.map((e) => e.type)).toEqual([
      'turn/start',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result', // 补写的合成结果，不是 flaky 工具真的产出的
      'step/end',
      'turn/end',
    ])
    const syntheticResult = agent.sessionEvents.find((e) => e.type === 'tool/result') as
      | { readonly callId: string; readonly isError: boolean; readonly content: string }
      | undefined
    expect(syntheticResult).toMatchObject({ callId: 'c1', isError: true })
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'cancelled' })

    const turnEnd = agent.sessionEvents.find((e) => e.type === 'turn/end')
    expect(turnEnd).toMatchObject({ reason: { kind: 'cancelled' } })
  })

  it('an already-aborted signal (no step ever started) logs only turn/start, user/message, turn/end', async () => {
    const controller = new AbortController()
    controller.abort()
    const agent = new Agent({
      adapter: new ScriptedAdapter([assistantText('should not be reached')]),
      tools: new ToolRegistry(),
      provider: 'fake',
      model: 'x',
      loopOptions: {},
    })
    agent.cancel({ kind: 'user' }) // nothing running yet -- this is a no-op, just resets baseline
    agent.send(userText('go'))
    agent.cancel({ kind: 'user' }) // now genuinely cancels the turn that's about to start
    await agent.whenIdle()

    expect(agent.sessionEvents.map((e) => e.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(agent.history).toEqual([userText('go')])
  })
})

describe('steer() messages are logged into the session as user/message events', () => {
  it('a steered message appears in sessionEvents at the step boundary where it landed', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let startedResolve: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve
    })

    class GatedThenToolCallAdapter extends LlmAdapter {
      private calls = 0
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        this.calls += 1
        if (this.calls === 1) {
          startedResolve?.()
          await gate
          yield* streamFake({ message: assistantToolCall('c1', 'echo', {}), finishReason: { kind: 'tool-calls' } })
          return
        }
        yield* streamFake({ message: assistantText('done'), finishReason: { kind: 'stop' } })
      }
    }

    const tools = new ToolRegistry()
    tools.define(echoTool())
    const agent = newAgent(new GatedThenToolCallAdapter(), tools)

    agent.send(userText('go'))
    await started
    agent.steer(userText('steered note'))
    release?.()
    await agent.whenIdle()

    const userMessages = agent.sessionEvents.filter((e) => e.type === 'user/message')
    expect(userMessages).toHaveLength(2)
    expect((userMessages[1] as { message: Message }).message).toEqual(userText('steered note'))

    // pollSteering() 在 agent-loop.ts 里是紧跟 step-start 之后、请求模型之前调用的（Day6
    // study.md 第3节），所以引导消息应该正好夹在 step/start(2) 和这个 step 的
    // assistant/message 之间——不是在 step/start(2) 之前。
    expect(agent.sessionEvents.map((e) => e.type)).toEqual([
      'turn/start',
      'user/message', // 'go'
      'step/start', // step 1
      'assistant/message', // tool-call c1
      'tool/call',
      'tool/result',
      'step/end',
      'step/start', // step 2
      'user/message', // 'steered note' -- 引导消息落在这里
      'assistant/message', // 'done'
      'step/end',
      'turn/end',
    ])
  })
})
