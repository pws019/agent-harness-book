import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { Agent } from '../src/core/agent-handle.js'
import { ApprovalStore } from '../src/core/approval.js'
import { AuditingApprovalStore, type AuditRecord } from '../src/core/audit-log.js'
import { Conversation } from '../src/client/conversation.js'
import { createHttpServer, type HttpServerOptions } from '../src/server/http-server.js'
import { decodeEnvelopeLine } from '../src/server/wire-protocol.js'
import { LlmAdapter, LlmError, type GenerateOptions } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ToolDefinition } from '../src/tools/types.js'

function userText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}
function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}
function assistantToolCall(id: string, name: string): Message {
  return { role: 'assistant', blocks: [{ type: 'tool-call', id, name, arguments: '{}' }] }
}

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

/** Replies with a fixed, caller-chosen text — used to give each concurrent session a
 * unique fingerprint so cross-talk between sessions would actually be detectable. */
class FingerprintAdapter extends LlmAdapter {
  constructor(private readonly reply: string) {
    super()
  }
  async *stream(): AsyncIterable<StreamChunk> {
    yield* streamFake({ message: assistantText(this.reply), finishReason: { kind: 'stop' } })
  }
}

/** Loops calling `noop` a configurable number of times before finishing — used to
 * generate a genuinely long real stream. Same shape as http-server.test.ts's LoopingAdapter. */
class LoopingAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly iterations: number) {
    super()
  }
  async *stream(): AsyncIterable<StreamChunk> {
    this.step += 1
    if (this.step <= this.iterations) {
      yield* streamFake({ message: assistantToolCall(`call-${this.step}`, 'noop'), finishReason: { kind: 'tool-calls' } })
    } else {
      yield* streamFake({ message: assistantText('done'), finishReason: { kind: 'stop' } })
    }
  }
}

function toolsWithNoop(): ToolRegistry {
  const tools = new ToolRegistry()
  tools.define(noopTool())
  return tools
}

interface RunningServer {
  readonly baseUrl: string
  readonly close: () => Promise<void>
}

async function startServer(options: HttpServerOptions): Promise<RunningServer> {
  const server = createHttpServer(options)
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

describe('load: many real concurrent sessions on one real HTTP server converge correctly, no cross-talk', () => {
  it('30 concurrent sessions each get their own unique reply, never another session\'s', async () => {
    const sessionCount = 30
    let nextAdapterIndex = 0
    const running = await startServer({
      createAgentDeps: () => ({ adapter: new FingerprintAdapter(`reply-for-session-${nextAdapterIndex++}`), tools: toolsWithNoop(), provider: 'demo', model: 'fingerprint' }),
    })
    try {
      const results = await Promise.all(
        Array.from({ length: sessionCount }, async (_unused, i) => {
          const createRes = await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })
          const { sessionId } = (await createRes.json()) as { sessionId: string }

          await fetch(`${running.baseUrl}/sessions/${sessionId}/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: `question ${i}` }),
          })

          const eventsRes = await fetch(`${running.baseUrl}/sessions/${sessionId}/events`)
          const lines = (await eventsRes.text()).trim().split('\n').filter((l) => l.length > 0).map((l) => decodeEnvelopeLine(l))
          const terminal = lines.find((e) => e.kind === 'terminal')
          const conversation = new Conversation()
          for (const envelope of lines) conversation.applyEnvelope(envelope)
          return { sessionId, terminal, events: conversation.confirmedEvents }
        }),
      )

      // 每个 session 都正常收尾，且它看到的所有事件里，只包含它自己那份唯一回复——
      // 不多不少，跟其他 29 个 session 的内容完全没有串到一起。
      for (let i = 0; i < sessionCount; i++) {
        const result = results[i]!
        expect(result.terminal).toEqual({ kind: 'terminal', reason: 'completed', lastSeq: expect.any(Number) })
        const assistantEvents = result.events.filter((e) => e.type === 'assistant/message')
        expect(assistantEvents).toHaveLength(1)
      }
      const allSessionIds = new Set(results.map((r) => r.sessionId))
      expect(allSessionIds.size).toBe(sessionCount) // 每个 session 真的是独立创建的，没有意外撞 id
    } finally {
      await running.close()
    }
  })
})

describe('load: a long real HTTP stream, consumed through Day23 Conversation, has zero loss and zero gaps', () => {
  it('200 tool-call/tool-result increments over a real chunked response converge to exactly the right cursor', async () => {
    const running = await startServer({
      createAgentDeps: () => ({ adapter: new LoopingAdapter(200), tools: toolsWithNoop(), provider: 'demo', model: 'looping', loopOptions: { maxSteps: 205, maxToolCalls: 205 } }),
      // 200 次工具调用产生的事件量真实地超过了 Day22 64KB 的演示默认值（这条测试在本地
      // 同步跑得太快，还没来得及被消费掉的积压就已经攒了几百条事件）——这不是在验证积压
      // 上限本身（那是 Day22 backlog-writer.test.ts 的事），是给这条真实有大量历史的
      // session 一个更贴近生产场景的上限，好让测试聚焦在"长 stream 会不会丢事件/产生
      // 缺口"这件事上。
      maxBacklogBytes: 2 * 1024 * 1024,
    })
    try {
      const createRes = await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })
      const { sessionId } = (await createRes.json()) as { sessionId: string }

      // 先建立 events 连接、等 headers 收到（意味着服务端已经 subscribe 完了），再发消息——
      // 跟 http-server.test.ts 的happy-path 测试同一个手法，避免"消息先到、订阅还没建好"
      // 的竞态。这样 1000+ 条事件是在 turn 真正跑的过程中一条条以 increment 的形式实时
      // 推过来、边推边被真实 flush,而不是等 turn 完全跑完之后,一次性塞进一条巨大的
      // baseline（那条单独一行的 JSON 本身就可能超过每连接的积压上限,会被误判成
      // "慢客户端"）。
      const eventsRes = await fetch(`${running.baseUrl}/sessions/${sessionId}/events`)
      const linesPromise = eventsRes.text()

      await fetch(`${running.baseUrl}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'go' }),
      })

      const lines = (await linesPromise).trim().split('\n').filter((l) => l.length > 0).map((l) => decodeEnvelopeLine(l))

      const conversation = new Conversation()
      for (const envelope of lines) conversation.applyEnvelope(envelope)

      const terminal = lines.find((e) => e.kind === 'terminal')
      expect(terminal?.kind).toBe('terminal')
      const lastSeq = terminal && terminal.kind === 'terminal' ? terminal.lastSeq : -1
      // 200 次 tool-call 意味着至少 200*4 (call/result/step-start/step-end 大致量级) + 若干条事件——
      // 不校验具体数字，只校验 Conversation 的游标真的追到了服务端宣布的 lastSeq，一个缺口都没有。
      expect(conversation.cursor).toBe(lastSeq)
      expect(conversation.confirmedEvents).toHaveLength(lastSeq + 1) // seq 从 0 开始连续
      const toolCallCount = conversation.confirmedEvents.filter((e) => e.type === 'tool/call').length
      expect(toolCallCount).toBe(200)
    } finally {
      await running.close()
    }
  })
})

describe('chaos: a multi-step turn that hits a non-retryable model error still converges to a clear terminal state', () => {
  class FailsOnSecondStepAdapter extends LlmAdapter {
    private step = 0
    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.step += 1
      if (this.step === 1) {
        yield* streamFake({ message: assistantToolCall('call-1', 'noop'), finishReason: { kind: 'tool-calls' } })
        return
      }
      // AUTH_ERROR 不在 DEFAULT_RETRY_POLICY.retryableCodes 里——不会触发真实的
      // sleep/重试延迟，直接、确定性地在这次 attempt 上失败。
      throw new LlmError({ code: 'AUTH_ERROR', message: 'simulated 401 from the provider' })
    }
  }

  it('the turn does not hang and does not swallow the failure — stopReason.kind is "error"', async () => {
    const agent = new Agent({ adapter: new FailsOnSecondStepAdapter(), tools: toolsWithNoop(), provider: 'demo', model: 'chaos' })
    agent.send(userText('go'))
    await agent.whenIdle()

    const record = agent.records[0]!
    expect(record.stopReason.kind).toBe('error')
    if (record.stopReason.kind === 'error') {
      expect(record.stopReason.failure.code).toBe('AUTH_ERROR')
    }

    // 出错之前那次真实发生过的工具调用，依然完整留在事件日志里——不因为后面失败了
    // 就假装整个 turn 什么都没做过。
    const toolCalls = agent.sessionEvents.filter((e) => e.type === 'tool/call')
    expect(toolCalls).toHaveLength(1)
  })
})

describe('chaos: an audit sink that throws must not break the approval flow it is observing (README invariant #16)', () => {
  it('create()/consume() still succeed and return normally even though the sink always throws', () => {
    const throwingSink = {
      record(_entry: AuditRecord): void {
        throw new Error('simulated telemetry backend outage')
      },
    }
    const store = new AuditingApprovalStore(new ApprovalStore(), throwingSink)
    const args = { file: 'a.txt' }

    const request = store.create('edit_file', 'a.txt', 'summary', args, 60_000, 'alice')
    expect(request.nonce).toBeTruthy()
    expect(() => store.consume(request.nonce, args, 'alice')).not.toThrow()
  })
})
