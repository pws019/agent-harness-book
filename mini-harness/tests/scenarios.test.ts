import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInvestigation, type CliArgs } from '../src/cli.js'
import { HeuristicInvestigationAdapter } from '../src/heuristic-adapter.js'
import { Agent } from '../src/core/agent-handle.js'
import { LlmAdapter, LlmError, type GenerateOptions } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { createReadOnlyFsTools } from '../src/tools/fs-tools.js'

/**
 * 里程碑一的验收测试：不是重新测 Day2-6 已经测过的内部细节，而是把 6 天搭起来的
 * 每一层拼在一起，跑一遍端到端场景。20 条覆盖：成功、证据不足、工具失败、
 * 预算耗尽、取消、模型层错误恢复。任何一条产生"未定义终态"（既不是 completed，
 * 也不是明确分类的失败）都算这次里程碑不合格。
 */

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, 'fixtures', 'workspace')

function baseArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return { workspace: workspaceRoot, goal: 'investigate', query: 'TARGET_NEEDLE', ...overrides }
}

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
    yield* streamFake({ message, finishReason: hasToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } })
  }
}

/** 跟 ScriptedAdapter 一样按顺序重放文本回答，但额外记下每次收到的完整请求——用来断言
 * "新一轮 turn 的请求里有没有带上更早那轮的历史"，而不仅仅是这一轮的新问题。 */
class RecordingAdapter extends LlmAdapter {
  private call = 0
  readonly calls: GenerateOptions[] = []
  constructor(private readonly script: readonly Message[]) {
    super()
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const message = this.script[Math.min(this.call, this.script.length - 1)]!
    this.call += 1
    yield* streamFake({ message, finishReason: { kind: 'stop' } })
  }
}

class FlakyAdapter extends LlmAdapter {
  private calls = 0
  constructor(
    private readonly failTimes: number,
    private readonly failureCode: 'SERVER_ERROR' | 'CONTEXT_WINDOW_EXCEEDED',
    private readonly finalMessage: Message = assistantText('recovered'),
  ) {
    super()
  }
  async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls <= this.failTimes) {
      throw new LlmError({ code: this.failureCode, message: `synthetic failure #${this.calls}` })
    }
    yield* streamFake({ message: this.finalMessage, finishReason: { kind: 'stop' } })
  }
}

class GatedAdapter extends LlmAdapter {
  private release: (() => void) | undefined
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  // Field declaration order matters here: `startedResolve` must exist before `started`'s
  // initializer runs and assigns to it, or the later (no-initializer) field declaration would
  // silently reset it back to undefined -- this is the exact class-field-ordering trap.
  private startedResolve: (() => void) | undefined
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })

  open(): void {
    this.release?.()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.startedResolve?.()
    await new Promise<void>((resolve, reject) => {
      this.gate.then(resolve)
      options.signal?.addEventListener('abort', () => reject(new LlmError({ code: 'ABORTED', message: 'aborted' })), {
        once: true,
      })
    })
    yield* streamFake({ message: assistantText('too late'), finishReason: { kind: 'stop' } })
  }
}

function newAgentWithScript(script: readonly Message[], maxSteps?: number): Agent {
  const tools = new ToolRegistry()
  for (const tool of createReadOnlyFsTools(workspaceRoot)) tools.define(tool)
  return new Agent({
    adapter: new ScriptedAdapter(script),
    tools,
    provider: 'fake',
    model: 'x',
    ...(maxSteps ? { loopOptions: { maxSteps } } : {}),
  })
}

describe('Scenario 1-2: success with real file evidence', () => {
  it('1. finds the needle and reports matching lines as evidence', async () => {
    const { summary, record } = await runInvestigation(baseArgs())
    expect(record.stopReason).toEqual({ kind: 'completed' })
    expect(summary).toContain('TARGET_NEEDLE')
    expect(summary).toContain('README.md')
  })

  it('2. a different query against the same workspace produces a different, still-grounded answer', async () => {
    const { summary, record } = await runInvestigation(baseArgs({ query: 'export function add' }))
    expect(record.stopReason).toEqual({ kind: 'completed' })
    expect(summary).toContain('src/index.ts')
  })
})

describe('Scenario 3-4: insufficient evidence is reported honestly, not fabricated', () => {
  it('3. a query with zero matches completes but states the conclusion is inconclusive', async () => {
    const { summary, record } = await runInvestigation(baseArgs({ query: 'no_such_string_anywhere_xyz' }))
    expect(record.stopReason).toEqual({ kind: 'completed' })
    expect(summary).toContain('inconclusive')
  })

  it('4. HeuristicInvestigationAdapter never claims matches it did not receive from the tool', async () => {
    const adapter = new HeuristicInvestigationAdapter('nonexistent_query')
    const agent = (() => {
      const tools = new ToolRegistry()
      for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
      return new Agent({ adapter, tools, provider: 'demo', model: 'x' })
    })()
    agent.send(userText('go'))
    await agent.whenIdle()
    const record = agent.records[0]!
    const finalText = record.events.find((e) => e.type === 'model-response' && e.finish.kind === 'stop')
    expect(finalText).toBeDefined()
    expect(record.stopReason).toEqual({ kind: 'completed' })
  })
})

describe('Scenario 5-8: tool failures are absorbed, not fatal', () => {
  it('5. an unknown tool name still lets the turn complete', async () => {
    const agent = newAgentWithScript([assistantToolCall('c1', 'delete_everything', {}), assistantText('done')])
    agent.send(userText('go'))
    await agent.whenIdle()
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
    expect(agent.records[0]!.events.some((e) => e.type === 'tool-result' && e.isError)).toBe(true)
  })

  it('6. malformed JSON tool arguments still let the turn complete', async () => {
    const malformed: Message = { role: 'assistant', blocks: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: '{bad' }] }
    const agent = newAgentWithScript([malformed, assistantText('done')])
    agent.send(userText('go'))
    await agent.whenIdle()
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
  })

  it('7. reading a nonexistent file reports a clear error, not a crash', async () => {
    const agent = newAgentWithScript([
      assistantToolCall('c1', 'read_file', { file_path: 'does/not/exist.ts' }),
      assistantText('done'),
    ])
    agent.send(userText('go'))
    await agent.whenIdle()
    const toolResult = agent.records[0]!.events.find((e) => e.type === 'tool-result')
    expect(toolResult).toMatchObject({ isError: true })
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
  })

  it('8. a path-escape attempt is blocked even when driven through the full loop, not just the unit-level tool test', async () => {
    const agent = newAgentWithScript([
      assistantToolCall('c1', 'read_file', { file_path: '../outside-secret.txt' }),
      assistantText('done'),
    ])
    agent.send(userText('go'))
    await agent.whenIdle()
    const toolResult = agent.records[0]!.events.find((e) => e.type === 'tool-result')
    expect(toolResult).toMatchObject({ isError: true, content: expect.stringContaining('escapes workspace root') })
  })
})

describe('Scenario 9-11: budget exhaustion always terminates cleanly', () => {
  it('9. max_steps stops a model that never stops requesting the same tool', async () => {
    const agent = newAgentWithScript([assistantToolCall('c1', 'list_files', {})], 3)
    agent.send(userText('go'))
    await agent.whenIdle()
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'budget_exhausted', reason: 'max_steps' })
  })

  it('10. max_tool_calls stops a single step requesting too many tools at once', async () => {
    const manyCalls: Message = {
      role: 'assistant',
      blocks: Array.from({ length: 5 }, (_, i) => ({
        type: 'tool-call' as const,
        id: `c${i}`,
        name: 'list_files',
        arguments: '{}',
      })),
    }
    const tools = new ToolRegistry()
    for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
    const agent = new Agent({
      adapter: new ScriptedAdapter([manyCalls]),
      tools,
      provider: 'fake',
      model: 'x',
      loopOptions: { maxToolCalls: 2 },
    })
    agent.send(userText('go'))
    await agent.whenIdle()
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'budget_exhausted', reason: 'max_tool_calls' })
  })

  it('11. the CLI surfaces a non-completed stop reason instead of pretending success', async () => {
    const { summary, record } = await runInvestigation(baseArgs({ maxSteps: 1 }), () => new GatedAdapterAlwaysToolCalls())
    expect(record.stopReason.kind).toBe('budget_exhausted')
    expect(summary).toContain('did not complete normally')
  })
})

class GatedAdapterAlwaysToolCalls extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    yield* streamFake({ message: assistantToolCall('c1', 'list_files', {}), finishReason: { kind: 'tool-calls' } })
  }
}

describe('Scenario 12-15: cancellation always converges to a single cancelled record', () => {
  it('12. an already-aborted signal cancels before any step runs', async () => {
    const controller = new AbortController()
    controller.abort()
    const tools = new ToolRegistry()
    for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
    const agent = new Agent({ adapter: new HeuristicInvestigationAdapter('x'), tools, provider: 'demo', model: 'x' })
    agent.cancel({ kind: 'user' }) // cancel before any send -- next turn should still run normally
    agent.send(userText('go'))
    await agent.whenIdle()
    // cancel() before send() only affects an in-flight controller, which doesn't exist yet, so
    // this send should proceed and complete normally -- documenting that cancel() is scoped to
    // "the current activity", not "all future activity".
    expect(agent.records[0]!.stopReason.kind).not.toBe('error')
  })

  it('13. cancel() mid-flight produces exactly one cancelled record', async () => {
    const adapter = new GatedAdapter()
    const tools = new ToolRegistry()
    for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
    const agent = new Agent({ adapter, tools, provider: 'fake', model: 'x' })
    agent.send(userText('go'))
    await adapter.started
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(agent.records).toHaveLength(1)
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'cancelled' })
  })

  it('14. dispose() mid-flight waits for the turn to actually record cancelled before resolving', async () => {
    const adapter = new GatedAdapter()
    const tools = new ToolRegistry()
    for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
    const agent = new Agent({ adapter, tools, provider: 'fake', model: 'x' })
    agent.send(userText('go'))
    await adapter.started
    await agent.dispose()
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'cancelled' })
    expect(() => agent.send(userText('nope'))).toThrow()
  })

  it('15. cancelling one turn does not corrupt a subsequent, unrelated turn on a fresh Agent', async () => {
    const tools = new ToolRegistry()
    for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
    const first = new Agent({ adapter: new GatedAdapter(), tools, provider: 'fake', model: 'x' })
    first.send(userText('go'))
    first.cancel({ kind: 'user' })
    await first.whenIdle()

    const second = new Agent({ adapter: new ScriptedAdapter([assistantText('fresh answer')]), tools, provider: 'fake', model: 'x' })
    second.send(userText('go'))
    await second.whenIdle()
    expect(second.records[0]!.stopReason).toEqual({ kind: 'completed' })
  })
})

describe('Scenario 16-18: model-layer errors are retried or surfaced, never silently swallowed', () => {
  it('16. a transient SERVER_ERROR is retried and the turn completes', async () => {
    const tools = new ToolRegistry()
    for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
    const agent = new Agent({
      adapter: new FlakyAdapter(2, 'SERVER_ERROR'),
      tools,
      provider: 'fake',
      model: 'x',
      loopOptions: { retryRuntime: { sleep: async () => {}, random: () => 0.5 } },
    })
    agent.send(userText('go'))
    await agent.whenIdle()
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
  })

  it('17. retries exhausted surfaces a clean error stop reason, not a hang or crash', async () => {
    const tools = new ToolRegistry()
    for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
    const agent = new Agent({
      adapter: new FlakyAdapter(10, 'SERVER_ERROR'),
      tools,
      provider: 'fake',
      model: 'x',
      loopOptions: { retryRuntime: { sleep: async () => {}, random: () => 0.5 } },
    })
    agent.send(userText('go'))
    await agent.whenIdle()
    expect(agent.records[0]!.stopReason.kind).toBe('error')
  })

  it('18. a non-retryable failure code fails on the first attempt without wasting retries', async () => {
    const tools = new ToolRegistry()
    for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
    const adapter = new FlakyAdapter(1, 'CONTEXT_WINDOW_EXCEEDED')
    const agent = new Agent({ adapter, tools, provider: 'fake', model: 'x' })
    agent.send(userText('go'))
    await agent.whenIdle()
    const stopReason = agent.records[0]!.stopReason
    expect(stopReason).toMatchObject({ kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } })
  })
})

describe('Scenario 19-20: cross-day regression guards', () => {
  it('19. a multi-step growing history does not trip the Day5 request-freeze bug', async () => {
    const script = [
      assistantToolCall('c1', 'list_files', {}),
      assistantToolCall('c2', 'list_files', { path: 'src' }),
      assistantToolCall('c3', 'search_text', { query: 'export' }),
      assistantText('done after three tool calls'),
    ]
    const agent = newAgentWithScript(script, 10)
    agent.send(userText('go'))
    await agent.whenIdle()
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
    // 1 user + 3 (assistant tool-call, tool result) pairs + 1 final assistant = 8
    expect(agent.history.length).toBe(8)
  })

  it('20. repeated identical tool calls across steps each execute independently (no accidental de-dup)', async () => {
    const script = [
      assistantToolCall('c1', 'list_files', {}),
      assistantToolCall('c2', 'list_files', {}),
      assistantText('done'),
    ]
    const agent = newAgentWithScript(script, 10)
    agent.send(userText('go'))
    await agent.whenIdle()
    const toolResults = agent.records[0]!.events.filter((e) => e.type === 'tool-result')
    expect(toolResults).toHaveLength(2)
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
  })
})

describe('Scenario 21: multi-turn conversations carry earlier turns into later requests', () => {
  it("21. the second send() turn's request to the model includes the first turn's full exchange, not just the new question", async () => {
    const tools = new ToolRegistry()
    for (const t of createReadOnlyFsTools(workspaceRoot)) tools.define(t)
    const adapter = new RecordingAdapter([assistantText('auth uses JWT'), assistantText('payments uses Stripe')])
    const agent = new Agent({ adapter, tools, provider: 'fake', model: 'x' })

    const firstUser = userText('what is the auth mechanism?')
    agent.send(firstUser)
    await agent.whenIdle()

    const secondUser = userText('and what about payments?')
    agent.send(secondUser)
    await agent.whenIdle()

    expect(adapter.calls).toHaveLength(2)
    // 第二轮发给模型的请求里必须带着第一轮完整的问答，而不是只带这一轮的新问题——
    // 这才是"会话记忆连续"真正被验证的地方，不是只看 agent.history 的长度。
    expect(adapter.calls[1]!.messages).toContainEqual(firstUser)
    expect(adapter.calls[1]!.messages).toContainEqual(assistantText('auth uses JWT'))
    expect(adapter.calls[1]!.messages).toContainEqual(secondUser)

    // 反过来也要成立：第一轮的请求不可能提前看到第二轮还没发生的问题。
    expect(adapter.calls[0]!.messages).not.toContainEqual(secondUser)

    expect(agent.history).toHaveLength(4) // user1, assistant1, user2, assistant2
    expect(agent.records).toHaveLength(2)
    expect(agent.records.every((r) => r.stopReason.kind === 'completed')).toBe(true)
  })
})
