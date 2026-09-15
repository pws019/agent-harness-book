import { describe, expect, it } from 'vitest'
import { Agent } from '../src/core/agent-handle.js'
import { deriveMessages, type SessionEvent } from '../src/core/session.js'
import { Conversation } from '../src/client/conversation.js'
import { createFaultInjectingConnector } from '../src/client/fault-injecting-transport.js'
import { runReconnectingStream } from '../src/client/reconnecting-stream.js'
import { LlmAdapter } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ToolDefinition } from '../src/tools/types.js'

function noopTool(): ToolDefinition<string> {
  return {
    name: 'noop',
    description: 'does nothing, returns immediately',
    parameters: { type: 'object', additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => value },
    timeoutMs: 1_000,
    isConcurrencySafe: () => true,
    async execute() {
      return 'ok'
    },
  }
}

function toolCall(id: string, name: string): Message {
  return { role: 'assistant', blocks: [{ type: 'tool-call', id, name, arguments: '{}' }] }
}
function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

/** Calls `noop` a handful of times before finishing — enough real events (turn/step
 * boundaries + tool calls + results) to make gap/reorder/duplicate fault injection
 * meaningful, without needing a real model or a long-running test. */
class FewStepsAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly iterations: number) {
    super()
  }
  async *stream(): AsyncIterable<StreamChunk> {
    this.step += 1
    if (this.step <= this.iterations) {
      yield* streamFake({ message: toolCall(`call-${this.step}`, 'noop'), finishReason: { kind: 'tool-calls' } })
    } else {
      yield* streamFake({ message: assistantText('done'), finishReason: { kind: 'stop' } })
    }
  }
}

/** Runs a real Agent turn to completion and returns the resulting authoritative event log. */
async function recordRealSession(iterations: number): Promise<readonly SessionEvent[]> {
  const tools = new ToolRegistry()
  tools.define(noopTool())
  const agent = new Agent({ adapter: new FewStepsAdapter(iterations), tools, provider: 'demo', model: 'few-steps' })
  agent.send({ role: 'user', blocks: [{ type: 'text', text: 'go' }] })
  await agent.whenIdle()
  await agent.dispose()
  return agent.sessionEvents
}

describe('client reconnection: fault injection converges to the authoritative session state', () => {
  const seeds = [1, 2, 3, 4, 5, 17, 42, 1337]

  for (const seed of seeds) {
    it(`seed=${seed}: gaps, duplicates, reorders, and mid-stream disconnects all resolve to the same final messages`, async () => {
      const fullLog = await recordRealSession(12)
      const connector = createFaultInjectingConnector(fullLog, {
        seed,
        duplicateProbability: 0.15,
        reorderProbability: 0.15,
        dropProbability: 0.1,
        disconnectProbability: 0.05,
      })

      const conversation = new Conversation()
      const controller = new AbortController()
      await runReconnectingStream({ connector, conversation, retryDelayMs: 0, maxRetries: 50 }, controller.signal)

      expect(conversation.cursor).toBe(fullLog.at(-1)!.seq)
      expect(conversation.messages).toEqual(deriveMessages(fullLog))
    })
  }

  it('a connection that disconnects on literally every attempt eventually gives up rather than looping forever', async () => {
    const fullLog = await recordRealSession(2)
    const connector = createFaultInjectingConnector(fullLog, { seed: 1, disconnectProbability: 1 })
    const conversation = new Conversation()
    const controller = new AbortController()

    await expect(runReconnectingStream({ connector, conversation, retryDelayMs: 0, maxRetries: 3 }, controller.signal)).rejects.toThrow(
      /gave up reconnecting after 3 attempts/,
    )
  })

  it('aborting the signal stops the reconnect loop instead of retrying forever', async () => {
    const fullLog = await recordRealSession(2)
    const connector = createFaultInjectingConnector(fullLog, { seed: 1, disconnectProbability: 1 })
    const conversation = new Conversation()
    const controller = new AbortController()
    controller.abort()

    await expect(runReconnectingStream({ connector, conversation, retryDelayMs: 0 }, controller.signal)).resolves.toBeUndefined()
  })
})
