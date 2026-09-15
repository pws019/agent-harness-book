import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpServer, type HttpServerOptions } from '../src/server/http-server.js'
import { LlmAdapter, LlmError, type GenerateOptions } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { AgentDeps } from '../src/core/agent-handle.js'
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

/** Answers instantly with a fixed text — no tool calls, one step, one turn. */
class InstantAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    yield* streamFake({ message: assistantText('done'), finishReason: { kind: 'stop' } })
  }
}

/** Stays genuinely suspended mid-request until aborted — for the cancel-propagation test.
 * Same shape as tests/agent-handle.test.ts's GatedAdapter. */
class GatedAdapter extends LlmAdapter {
  private release: (() => void) | undefined
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  private startedResolve: (() => void) | undefined
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.startedResolve?.()
    await new Promise<void>((resolve, reject) => {
      this.gate.then(resolve)
      options.signal?.addEventListener('abort', () => reject(new LlmError({ code: 'ABORTED', message: 'aborted mid-flight' })))
    })
    yield* streamFake({ message: assistantText('should not get here'), finishReason: { kind: 'stop' } })
  }
}

/** Loops calling `noop` many times before finishing — used to burst enough small
 * events quickly for the backlog-cap integration test. */
class LoopingAdapter extends LlmAdapter {
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}

const servers: RunningServer[] = []
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close()
})

async function readLines(res: Response): Promise<readonly unknown[]> {
  const text = await res.text()
  return text
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe('http-server: end-to-end happy path over a real socket', () => {
  it('create -> send -> stream events -> baseline + increments + terminal', async () => {
    const running = await startServer({ createAgentDeps: () => ({ adapter: new InstantAdapter(), tools: toolsWithNoop(), provider: 'demo', model: 'instant' }) })
    servers.push(running)

    const createRes = await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })
    expect(createRes.status).toBe(201)
    const { sessionId } = (await createRes.json()) as { sessionId: string }

    // 先建立 events 连接、等 headers 收到（意味着服务端已经 subscribe 完了），再发消息——
    // 避免"消息先到、订阅还没建好"的竞态。
    const eventsRes = await fetch(`${running.baseUrl}/sessions/${sessionId}/events`)
    expect(eventsRes.status).toBe(200)
    const linesPromise = readLines(eventsRes)

    const sendRes = await fetch(`${running.baseUrl}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(sendRes.status).toBe(202)

    const lines = (await linesPromise) as Array<{ kind: string }>
    expect(lines[0]?.kind).toBe('baseline')
    expect(lines.some((l) => l.kind === 'increment')).toBe(true)
    const terminal = lines.find((l) => l.kind === 'terminal') as { kind: string; reason: string } | undefined
    expect(terminal?.reason).toBe('completed')
  })

  it('GET /sessions/:id returns a projection summary', async () => {
    const running = await startServer({ createAgentDeps: () => ({ adapter: new InstantAdapter(), tools: toolsWithNoop(), provider: 'demo', model: 'instant' }) })
    servers.push(running)
    const { sessionId } = (await (await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })).json()) as { sessionId: string }
    const res = await fetch(`${running.baseUrl}/sessions/${sessionId}`)
    expect(res.status).toBe(200)
    const summary = (await res.json()) as { turnCount: number }
    expect(summary.turnCount).toBe(0)
  })

  it('an unknown session id 404s instead of hanging or crashing the server', async () => {
    const running = await startServer({ createAgentDeps: () => ({ adapter: new InstantAdapter(), tools: toolsWithNoop(), provider: 'demo', model: 'instant' }) })
    servers.push(running)
    const res = await fetch(`${running.baseUrl}/sessions/does-not-exist`)
    expect(res.status).toBe(404)
  })
})

describe('http-server: idempotency — repeated Idempotency-Key never starts a second task', () => {
  it('two concurrent POST /messages with the same key only call Agent.send() once', async () => {
    const running = await startServer({ createAgentDeps: () => ({ adapter: new InstantAdapter(), tools: toolsWithNoop(), provider: 'demo', model: 'instant' }) })
    servers.push(running)
    const { sessionId } = (await (await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })).json()) as { sessionId: string }

    const post = () =>
      fetch(`${running.baseUrl}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'dedupe-me' },
        body: JSON.stringify({ text: 'hello' }),
      })

    const [r1, r2] = await Promise.all([post(), post()])
    const [b1, b2] = (await Promise.all([r1.json(), r2.json()])) as [{ turnNumber: number }, { turnNumber: number }]

    expect(b1.turnNumber).toBe(1)
    expect(b2.turnNumber).toBe(1) // 同一个 key 拿到同一个结果，不是各自触发了一次 send()
  })

  it('two different keys are two genuinely separate sends', async () => {
    const running = await startServer({ createAgentDeps: () => ({ adapter: new InstantAdapter(), tools: toolsWithNoop(), provider: 'demo', model: 'instant' }) })
    servers.push(running)
    const { sessionId } = (await (await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })).json()) as { sessionId: string }

    const post = (key: string) =>
      fetch(`${running.baseUrl}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ text: 'hello' }),
      })

    const b1 = (await (await post('k1')).json()) as { turnNumber: number }
    const b2 = (await (await post('k2')).json()) as { turnNumber: number }
    expect(b1.turnNumber).toBe(1)
    expect(b2.turnNumber).toBe(2)
  })
})

describe('http-server: cancellation reaches the real Agent', () => {
  it('POST /cancel while a turn is genuinely mid-flight produces a cancelled terminal, not completed', async () => {
    const adapter = new GatedAdapter()
    const running = await startServer({ createAgentDeps: () => ({ adapter, tools: toolsWithNoop(), provider: 'demo', model: 'gated' }) })
    servers.push(running)
    const { sessionId } = (await (await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })).json()) as { sessionId: string }

    const eventsRes = await fetch(`${running.baseUrl}/sessions/${sessionId}/events`)
    const linesPromise = readLines(eventsRes)

    await fetch(`${running.baseUrl}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })
    await adapter.started // 确认真的已经卡在 stream() 里面了，不是提前 cancel 了一个还没开始的 turn

    await fetch(`${running.baseUrl}/sessions/${sessionId}/cancel`, { method: 'POST' })

    const lines = (await linesPromise) as Array<{ kind: string; reason?: string }>
    const terminal = lines.find((l) => l.kind === 'terminal')
    expect(terminal?.reason).toBe('cancelled')
  })
})

describe('http-server: auth is a shared-secret admission check, not a real authz model', () => {
  it('rejects requests with no/wrong bearer token', async () => {
    const running = await startServer({
      createAgentDeps: () => ({ adapter: new InstantAdapter(), tools: toolsWithNoop(), provider: 'demo', model: 'instant' }),
      bearerToken: 'secret-token',
    })
    servers.push(running)

    const noAuth = await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })
    expect(noAuth.status).toBe(401)

    const wrongAuth = await fetch(`${running.baseUrl}/sessions`, { method: 'POST', headers: { authorization: 'Bearer wrong' } })
    expect(wrongAuth.status).toBe(401)
  })

  it('accepts the correct bearer token — this proves admission, not per-session authorization', async () => {
    const running = await startServer({
      createAgentDeps: () => ({ adapter: new InstantAdapter(), tools: toolsWithNoop(), provider: 'demo', model: 'instant' }),
      bearerToken: 'secret-token',
    })
    servers.push(running)
    const res = await fetch(`${running.baseUrl}/sessions`, { method: 'POST', headers: { authorization: 'Bearer secret-token' } })
    expect(res.status).toBe(201)
  })
})

describe('http-server: a slow client cannot make the server buffer unbounded memory for it', () => {
  it('exceeding the per-connection backlog cap sends a transport-error and closes the connection', async () => {
    const running = await startServer({
      createAgentDeps: () => ({ adapter: new LoopingAdapter(2_000), tools: toolsWithNoop(), provider: 'demo', model: 'looping' }),
      maxBacklogBytes: 500, // 故意设得很小——几个事件就能撑爆，不用真的喂几百 KB
    })
    servers.push(running)
    const { sessionId } = (await (await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })).json()) as { sessionId: string }

    const eventsRes = await fetch(`${running.baseUrl}/sessions/${sessionId}/events`)
    const linesPromise = readLines(eventsRes)

    await fetch(`${running.baseUrl}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    })

    const lines = (await linesPromise) as Array<{ kind: string }>
    expect(lines.some((l) => l.kind === 'transport-error')).toBe(true)
    // 连接被强制放弃了——不应该看到一条正常的 terminal（那是"跑完了"，不是这次真实发生的"被放弃了"）。
    expect(lines.some((l) => l.kind === 'terminal')).toBe(false)
  })
})

describe('http-server: correlation id', () => {
  it('echoes a client-supplied X-Correlation-Id back, and invents one if the client did not send one', async () => {
    const running = await startServer({ createAgentDeps: () => ({ adapter: new InstantAdapter(), tools: toolsWithNoop(), provider: 'demo', model: 'instant' }) })
    servers.push(running)

    const withId = await fetch(`${running.baseUrl}/sessions`, { method: 'POST', headers: { 'x-correlation-id': 'my-id-123' } })
    expect(withId.headers.get('x-correlation-id')).toBe('my-id-123')

    const withoutId = await fetch(`${running.baseUrl}/sessions`, { method: 'POST' })
    expect(withoutId.headers.get('x-correlation-id')).toBeTruthy()
  })
})
