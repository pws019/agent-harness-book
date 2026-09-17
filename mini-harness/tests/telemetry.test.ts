import { describe, expect, it } from 'vitest'
import { Agent } from '../src/core/agent-handle.js'
import { createRedactor } from '../src/core/redact.js'
import { deriveTelemetry } from '../src/core/telemetry.js'
import { InMemoryCredentialStore } from '../src/core/credentials.js'
import type { WorkspaceContext } from '../src/core/workspace-context.js'
import { LlmAdapter } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { FinishReason, Message, StreamChunk } from '../src/llm/types.js'
import { createRunCommandTool } from '../src/tools/bash-tool.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ToolDefinition } from '../src/tools/types.js'

const NODE = process.execPath

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
  constructor(private readonly script: readonly { readonly message: Message; readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } }[]) {
    super()
  }
  async *stream(): AsyncIterable<StreamChunk> {
    const entry = this.script[Math.min(this.call, this.script.length - 1)]!
    this.call += 1
    const finishReason: FinishReason = entry.message.blocks.some((b) => b.type === 'tool-call') ? { kind: 'tool-calls' } : { kind: 'stop' }
    yield* streamFake({ message: entry.message, usage: entry.usage, finishReason })
  }
}

/** 一个会真实花一点时间的工具——保证配对出来的延迟不是巧合的 0ms,是真的量出来的。 */
function slowEchoTool(): ToolDefinition<string> {
  return {
    name: 'slow_echo',
    description: 'waits a few ms, then echoes back its text argument',
    parameters: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
    output: { schema: { type: 'string' }, render: (_args, value) => value },
    timeoutMs: 2_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return (args as { text: string }).text
    },
  }
}

describe('deriveTelemetry(): a pure projection over SessionEvent[], no hooks in ToolRegistry/LlmAdapter', () => {
  it('pairs step/start with assistant/message, and tool/call with tool/result, to compute real latencies', async () => {
    const tools = new ToolRegistry()
    tools.define(slowEchoTool())
    const adapter = new ScriptedAdapter([
      { message: assistantToolCall('call-1', 'slow_echo', { text: 'hi' }), usage: { inputTokens: 10, outputTokens: 2 } },
      { message: assistantText('done'), usage: { inputTokens: 12, outputTokens: 1 } },
    ])
    const agent = new Agent({ adapter, tools, provider: 'fake', model: 'x' })
    agent.send(userText('go'))
    await agent.whenIdle()

    const report = deriveTelemetry(agent.sessionEvents)

    const modelCalls = report.records.filter((r) => r.kind === 'model-call')
    const toolCalls = report.records.filter((r) => r.kind === 'tool-call')
    expect(modelCalls).toHaveLength(2)
    expect(toolCalls).toHaveLength(1)

    for (const record of modelCalls) expect(record.latencyMs).not.toBe('unknown')
    // 工具真的 setTimeout 了 5ms，配对出来的延迟应该确实 >= 5（不是巧合的 0）。
    expect(toolCalls[0]!.latencyMs).not.toBe('unknown')
    expect(toolCalls[0]!.latencyMs as number).toBeGreaterThanOrEqual(5)
    expect(toolCalls[0]!.name).toBe('slow_echo')
    expect(toolCalls[0]!.isError).toBe(false)

    expect(report.totals.inputTokens).toBe(22)
    expect(report.totals.outputTokens).toBe(3)
    expect(report.totalLatencyMs).toBeGreaterThanOrEqual(5)
  })

  it('unreported usage makes totals — and therefore cost — unknown, not silently 0', async () => {
    const agent = new Agent({ adapter: new ScriptedAdapter([{ message: assistantText('no usage reported') }]), tools: new ToolRegistry(), provider: 'fake', model: 'x' })
    agent.send(userText('go'))
    await agent.whenIdle()

    const report = deriveTelemetry(agent.sessionEvents, { costRates: { inputPerKTokens: 1, outputPerKTokens: 2 } })
    expect(report.totals.inputTokens).toBe('unknown')
    expect(report.estimatedCostUsd).toBe('unknown')
  })

  it('estimatedCostUsd is computed from known totals against the given (illustrative) rate table', async () => {
    const agent = new Agent({
      adapter: new ScriptedAdapter([{ message: assistantText('done'), usage: { inputTokens: 1000, outputTokens: 500 } }]),
      tools: new ToolRegistry(),
      provider: 'fake',
      model: 'x',
    })
    agent.send(userText('go'))
    await agent.whenIdle()

    const report = deriveTelemetry(agent.sessionEvents, { costRates: { inputPerKTokens: 3, outputPerKTokens: 15 } })
    // 1000 input tokens * $3/1K + 500 output tokens * $15/1K = $3 + $7.5 = $10.5
    expect(report.estimatedCostUsd).toBeCloseTo(10.5, 6)
  })

  it('estimatedCostUsd stays unknown when no cost rate table is given at all', async () => {
    const agent = new Agent({
      adapter: new ScriptedAdapter([{ message: assistantText('done'), usage: { inputTokens: 10, outputTokens: 1 } }]),
      tools: new ToolRegistry(),
      provider: 'fake',
      model: 'x',
    })
    agent.send(userText('go'))
    await agent.whenIdle()

    expect(deriveTelemetry(agent.sessionEvents).estimatedCostUsd).toBe('unknown')
  })
})

describe('deriveTelemetry() + redact(): a real secret that leaks into a real tool result gets scrubbed', () => {
  it('a command that accidentally echoes a workspace credential has it redacted in the telemetry report, but not in the raw SessionEvent log', async () => {
    const credentials = new InMemoryCredentialStore()
    credentials.set('demo-secret', 'sk-real-secret-value')
    const workspace: WorkspaceContext = { root: '.', credentials, envCredentials: { DEMO_SECRET: { id: 'demo-secret' } } }

    const tools = new ToolRegistry()
    tools.define(createRunCommandTool('.', undefined, workspace))

    const adapter = new ScriptedAdapter([
      { message: assistantToolCall('call-1', 'run_command', { command: NODE, args: ['-e', 'process.stdout.write(process.env.DEMO_SECRET ?? "")'] }) },
      { message: assistantText('ran it') },
    ])
    const agent = new Agent({ adapter, tools, provider: 'fake', model: 'x' })
    agent.send(userText('run the command'))
    await agent.whenIdle()

    // 原始事件日志里，密钥明文确实在——这是工具真实输出的一部分，SessionEvent 不做任何脱敏。
    const rawToolResult = agent.sessionEvents.find((e) => e.type === 'tool/result')
    expect(rawToolResult && (rawToolResult as { content: string }).content).toContain('sk-real-secret-value')

    const redactor = createRedactor(['sk-real-secret-value'])
    const report = deriveTelemetry(agent.sessionEvents, { redactor })
    const toolCall = report.records.find((r) => r.kind === 'tool-call')
    expect(toolCall!.redactedContent).not.toContain('sk-real-secret-value')
    expect(toolCall!.redactedContent).toContain('[REDACTED]')
  })
})
