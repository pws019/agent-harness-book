import { describe, expect, it } from 'vitest'
import { runTurn, type AgentLoopEvent, type StopReason } from '../src/core/agent-loop.js'
import { LlmAdapter } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { FinishReason, Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ToolAbortedError, ToolTimeoutError, type ToolDefinition } from '../src/tools/types.js'

/** Replays a fixed script of assistant messages, one per call, regardless of what history says. */
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
    yield* streamFake({ message, seed: 1, finishReason })
  }

  get callCount(): number {
    return this.call
  }
}

function textMessage(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

function toolCallMessage(id: string, name: string, args: unknown): Message {
  return { role: 'assistant', blocks: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] }
}

/** 一个 step 里同时请求两个工具调用，用来验证"第一个调用中止后，第二个绝不会被执行"。 */
function twoToolCallMessage(): Message {
  return {
    role: 'assistant',
    blocks: [
      { type: 'tool-call', id: 'c1', name: 'flaky', arguments: '{}' },
      { type: 'tool-call', id: 'c2', name: 'echo', arguments: JSON.stringify({ text: 'should not run' }) },
    ],
  }
}

/** 一个 execute() 就直接抛给定错误的假工具，名字固定叫 'flaky'。 */
function flakyTool(error: Error): ToolDefinition<string> {
  return {
    name: 'flaky',
    description: 'always throws the given error, to simulate a tool that times out or gets aborted mid-execution',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => value },
    timeoutMs: 1_000,
    isConcurrencySafe: () => true,
    async execute(): Promise<string> {
      throw error
    },
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

async function collect(gen: AsyncGenerator<AgentLoopEvent, StopReason>): Promise<{ events: AgentLoopEvent[]; stopReason: StopReason }> {
  const events: AgentLoopEvent[] = []
  let result = await gen.next()
  while (!result.done) {
    events.push(result.value)
    result = await gen.next()
  }
  return { events, stopReason: result.value }
}

function newRegistryWithEcho(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.define(echoTool())
  return registry
}

function newRegistryWithEchoAndFlaky(error: Error): ToolRegistry {
  const registry = new ToolRegistry()
  registry.define(echoTool())
  registry.define(flakyTool(error))
  return registry
}

describe('runTurn: happy paths', () => {
  it('completes in a single step when the model answers with plain text', async () => {
    const adapter = new ScriptedAdapter([textMessage('the answer is 42')])
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'what is the answer?' }] }]
    const { events, stopReason } = await collect(
      runTurn(history, { adapter, tools: newRegistryWithEcho(), provider: 'fake', model: 'x' }),
    )

    expect(stopReason).toEqual({ kind: 'completed' })
    expect(events.filter((e) => e.type === 'step-start')).toHaveLength(1)
    expect(history).toHaveLength(2) // user message + the one assistant message
  })

  it('executes a tool call, feeds the result back, and completes on the next step', async () => {
    const adapter = new ScriptedAdapter([toolCallMessage('c1', 'echo', { text: 'hi' }), textMessage('done')])
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'echo hi' }] }]
    const { events, stopReason } = await collect(
      runTurn(history, { adapter, tools: newRegistryWithEcho(), provider: 'fake', model: 'x' }),
    )

    expect(stopReason).toEqual({ kind: 'completed' })
    const toolResultEvent = events.find((e) => e.type === 'tool-result')
    expect(toolResultEvent).toMatchObject({ type: 'tool-result', content: 'hi', isError: false })
    // history: user, assistant(tool-call), tool(result), assistant(text)
    expect(history).toHaveLength(4)
    expect(history[2]).toEqual({ role: 'tool', blocks: [{ type: 'tool-result', toolCallId: 'c1', content: 'hi', isError: false }] })
  })
})

describe('runTurn: fault injection on tool calls', () => {
  it('an unknown tool name produces an error tool-result instead of crashing the turn', async () => {
    const adapter = new ScriptedAdapter([toolCallMessage('c1', 'nonexistent_tool', {}), textMessage('done')])
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'go' }] }]
    const { events, stopReason } = await collect(
      runTurn(history, { adapter, tools: newRegistryWithEcho(), provider: 'fake', model: 'x' }),
    )

    expect(stopReason).toEqual({ kind: 'completed' })
    const toolResultEvent = events.find((e) => e.type === 'tool-result')
    expect(toolResultEvent).toMatchObject({ isError: true })
  })

  it('unparseable JSON arguments produce an error tool-result instead of crashing the turn', async () => {
    const malformed: Message = {
      role: 'assistant',
      blocks: [{ type: 'tool-call', id: 'c1', name: 'echo', arguments: '{not valid json' }],
    }
    const adapter = new ScriptedAdapter([malformed, textMessage('done')])
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'go' }] }]
    const { events, stopReason } = await collect(
      runTurn(history, { adapter, tools: newRegistryWithEcho(), provider: 'fake', model: 'x' }),
    )

    expect(stopReason).toEqual({ kind: 'completed' })
    const toolResultEvent = events.find((e) => e.type === 'tool-result')
    expect(toolResultEvent).toMatchObject({ isError: true, content: expect.stringContaining('invalid JSON') })
  })
})

describe('runTurn: budgets always produce a single, unambiguous terminal state', () => {
  it('stops with budget_exhausted/max_steps when the model never stops requesting tool calls', async () => {
    const adapter = new ScriptedAdapter([toolCallMessage('c1', 'echo', { text: 'again' })]) // repeats forever
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'go' }] }]
    const { stopReason } = await collect(
      runTurn(history, { adapter, tools: newRegistryWithEcho(), provider: 'fake', model: 'x' }, { maxSteps: 3 }),
    )

    expect(stopReason).toEqual({ kind: 'budget_exhausted', reason: 'max_steps' })
  })

  it('stops with budget_exhausted/max_tool_calls when a single step requests too many tools', async () => {
    const manyCalls: Message = {
      role: 'assistant',
      blocks: Array.from({ length: 5 }, (_, i) => ({
        type: 'tool-call' as const,
        id: `c${i}`,
        name: 'echo',
        arguments: JSON.stringify({ text: String(i) }),
      })),
    }
    const adapter = new ScriptedAdapter([manyCalls])
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'go' }] }]
    const { stopReason } = await collect(
      runTurn(history, { adapter, tools: newRegistryWithEcho(), provider: 'fake', model: 'x' }, { maxToolCalls: 2 }),
    )

    expect(stopReason).toEqual({ kind: 'budget_exhausted', reason: 'max_tool_calls' })
  })

  it('every terminal path yields exactly one turn-end event carrying the same stopReason that is returned', async () => {
    const adapter = new ScriptedAdapter([toolCallMessage('c1', 'echo', { text: 'again' })])
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'go' }] }]
    const { events, stopReason } = await collect(
      runTurn(history, { adapter, tools: newRegistryWithEcho(), provider: 'fake', model: 'x' }, { maxSteps: 2 }),
    )

    const turnEndEvents = events.filter((e) => e.type === 'turn-end')
    expect(turnEndEvents).toHaveLength(1)
    expect((turnEndEvents[0] as { stopReason: StopReason }).stopReason).toEqual(stopReason)
  })
})

describe('runTurn: a timed-out or aborted tool call terminates the turn early', () => {
  it('ToolTimeoutError stops the turn as cancelled instead of producing an isError tool-result', async () => {
    const adapter = new ScriptedAdapter([twoToolCallMessage()])
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'go' }] }]
    const registry = newRegistryWithEchoAndFlaky(new ToolTimeoutError('fake timeout for testing'))
    const { events, stopReason } = await collect(
      runTurn(history, { adapter, tools: registry, provider: 'fake', model: 'x' }),
    )

    expect(stopReason).toEqual({ kind: 'cancelled' })

    // 只有一次 turn-end，且事件里的 stopReason 和 return 值一致（跟前面那条"unambiguous
    // terminal state"测试同一条不变式，但这里是靠工具中止触发的，不是预算耗尽）。
    const turnEndEvents = events.filter((e) => e.type === 'turn-end')
    expect(turnEndEvents).toHaveLength(1)
    expect((turnEndEvents[0] as { stopReason: StopReason }).stopReason).toEqual(stopReason)

    // 没有任何一条 isError 工具结果被伪造出来——中止就是中止，不装成一次失败的业务调用。
    expect(events.some((e) => e.type === 'tool-result')).toBe(false)

    // 第二个工具调用（echo）绝不会被尝试：既不会有它的 tool-call 事件，也不会有 tool-result。
    const secondCallEvents = events.filter(
      (e) => (e.type === 'tool-call' && e.toolCall.id === 'c2') || (e.type === 'tool-result' && e.toolCallId === 'c2'),
    )
    expect(secondCallEvents).toHaveLength(0)

    // history 里没有被塞进一条半成品的 tool 消息——still 只有 user + assistant 两条。
    expect(history).toHaveLength(2)
  })

  it('ToolAbortedError stops the turn as cancelled the same way ToolTimeoutError does', async () => {
    const adapter = new ScriptedAdapter([twoToolCallMessage()])
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'go' }] }]
    const registry = newRegistryWithEchoAndFlaky(new ToolAbortedError('fake aborted for testing'))
    const { stopReason } = await collect(runTurn(history, { adapter, tools: registry, provider: 'fake', model: 'x' }))

    expect(stopReason).toEqual({ kind: 'cancelled' })
  })
})

describe('runTurn: cancellation', () => {
  it('an already-aborted signal stops the turn before any step runs', async () => {
    const adapter = new ScriptedAdapter([textMessage('should not be reached')])
    const controller = new AbortController()
    controller.abort()
    const history: Message[] = [{ role: 'user', blocks: [{ type: 'text', text: 'go' }] }]
    const { events, stopReason } = await collect(
      runTurn(history, { adapter, tools: newRegistryWithEcho(), provider: 'fake', model: 'x' }, { signal: controller.signal }),
    )

    expect(stopReason).toEqual({ kind: 'cancelled' })
    expect(events.some((e) => e.type === 'step-start')).toBe(false)
    expect(adapter.callCount).toBe(0)
  })
})
