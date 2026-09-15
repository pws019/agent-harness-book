import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AgentDeps } from '../core/agent-handle.js'
import { projectSummary } from '../core/session-projection.js'
import type { Message } from '../llm/types.js'
import { createBacklogWriter } from './backlog-writer.js'
import { IdempotencyStore } from './idempotency-store.js'
import { SessionNotFoundError, SessionRegistry } from './session-registry.js'
import { encodeEnvelope } from './wire-protocol.js'

const DEFAULT_MAX_BACKLOG_BYTES = 64 * 1024

export interface HttpServerOptions {
  /** 每次 `POST /sessions` 都会调用一次，构造一份全新的 `AgentDeps`（不含 `sink`——
   * 那是 `SessionRegistry.create()` 自己接管的）。测试可以传一个返回 `HeuristicInvestigationAdapter`
   * 的工厂；真实部署换成别的 provider 也只需要换这一个函数，不用碰路由逻辑。 */
  readonly createAgentDeps: () => Omit<AgentDeps, 'sink'>
  /** 缺省（`undefined`）等于关闭鉴权——本地开发/测试用。给了就是一个共享 bearer token：
   * 谁拿着这个 token 谁就能操作任何 session，**不是**按用户区分权限的真授权模型，
   * 只是"有没有钥匙"这一道准入检查（诚实记录的缺口，见 study.md）。 */
  readonly bearerToken?: string
  /** 每条 `GET /events` 连接允许"写出去但还没被真正 flush 掉"的字节上限——不是"服务器
   * 总内存上限"，是"一个不肯读的慢客户端最多能让我们为它攒多少数据"。默认 64KB；
   * 测试可以传一个很小的值，不用真的撑爆操作系统的 socket 缓冲区就能确定性地触发。 */
  readonly maxBacklogBytes?: number
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${(error as Error).message}`))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function textToMessage(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

/**
 * 手写路由（不用框架）：这本身就是这一天的教学点——真正搞懂"HTTP 请求怎么被分发到
 * 具体处理逻辑"，比学会一个框架的 API 更接近这一天要讲的东西。暴露 create session、
 * send message（幂等）、cancel、inspect、events stream 五个操作，串起 `SessionRegistry`
 * （谁拥有 `Agent`）、`IdempotencyStore`（重复提交不重复触发副作用）、`StreamEnvelope`
 * （流协议的线格式）。
 */
export function createHttpServer(options: HttpServerOptions): Server {
  const registry = new SessionRegistry()
  const idempotency = new IdempotencyStore<{ readonly turnNumber: number }>()

  function checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!options.bearerToken) return true
    const header = req.headers.authorization
    if (header === `Bearer ${options.bearerToken}`) return true
    sendJson(res, 401, { error: 'missing or invalid bearer token' })
    return false
  }

  const server = createServer((req, res) => {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) ?? randomUUID()
    res.setHeader('X-Correlation-Id', correlationId)

    void handleRequest(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const message = error instanceof SessionNotFoundError ? error.message : `internal error: ${String(error)}`
      const status = error instanceof SessionNotFoundError ? 404 : 500
      sendJson(res, status, { error: message })
    })
  })

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkAuth(req, res)) return

    const url = new URL(req.url ?? '/', 'http://internal')
    const segments = url.pathname.split('/').filter(Boolean)

    // POST /sessions
    if (req.method === 'POST' && segments.length === 1 && segments[0] === 'sessions') {
      const id = registry.create(options.createAgentDeps())
      sendJson(res, 201, { sessionId: id })
      return
    }

    if (segments.length >= 2 && segments[0] === 'sessions' && segments[1] !== undefined) {
      const sessionId = segments[1]

      // POST /sessions/:id/messages
      if (req.method === 'POST' && segments.length === 3 && segments[2] === 'messages') {
        const body = (await readJsonBody(req)) as { readonly text?: string } | undefined
        if (!body?.text) {
          sendJson(res, 400, { error: 'missing required "text" field' })
          return
        }
        const idempotencyKey = req.headers['idempotency-key'] as string | undefined

        if (idempotencyKey) {
          if (!idempotency.claim(idempotencyKey)) {
            // 已经见过这个 key：不再调用 sendMessage()，直接把上次的结果原样返回。
            // 这个进程内的路由是同步执行到这里的（claim()/sendMessage() 之间没有
            // await），所以不存在"另一个请求正好卡在 in-flight"这个状态需要处理。
            const entry = idempotency.get(idempotencyKey)!
            const response = entry.status === 'completed' ? entry.response : { turnNumber: -1 }
            sendJson(res, 202, response)
            return
          }
          const turnNumber = registry.sendMessage(sessionId, textToMessage(body.text))
          const response = { turnNumber }
          idempotency.complete(idempotencyKey, response)
          sendJson(res, 202, response)
          return
        }

        const turnNumber = registry.sendMessage(sessionId, textToMessage(body.text))
        sendJson(res, 202, { turnNumber })
        return
      }

      // POST /sessions/:id/cancel
      if (req.method === 'POST' && segments.length === 3 && segments[2] === 'cancel') {
        registry.cancel(sessionId)
        sendJson(res, 200, { ok: true })
        return
      }

      // GET /sessions/:id
      if (req.method === 'GET' && segments.length === 2) {
        const agent = registry.get(sessionId)
        sendJson(res, 200, projectSummary(agent.sessionEvents))
        return
      }

      // GET /sessions/:id/events?since=<seq>
      if (req.method === 'GET' && segments.length === 3 && segments[2] === 'events') {
        handleEventsStream(sessionId, url, req, res)
        return
      }
    }

    sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
  }

  function handleEventsStream(sessionId: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
    const agent = registry.get(sessionId) // 先查一遍：session 不存在就让上面的 catch 处理 404，不用另开一条连接
    const sinceRaw = url.searchParams.get('since')
    const since = sinceRaw !== null ? Number(sinceRaw) : -1

    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Transfer-Encoding': 'chunked' })

    let closed = false

    const write = createBacklogWriter({
      maxBytes: options.maxBacklogBytes ?? DEFAULT_MAX_BACKLOG_BYTES,
      write: (line, onFlushed) => res.write(line, onFlushed),
      onOverflow: () => {
        closed = true
        unsubscribe()
        // 故意用 end() 而不是 destroy()：这次放弃是"讲完最后一句话再挂断"，不是硬拔线——
        // transport-error 这条消息本身就是为了让客户端知道"该重连了",直接砸断 socket
        // 会让这条诊断信息自己都发不完整,白白定义了一个客户端永远读不到的错误类型。
        try {
          res.end(encodeEnvelope({ kind: 'transport-error', message: 'per-connection backlog cap exceeded' }))
        } catch {
          res.destroy() // 连接已经坏到连 end() 都失败了，这时候才真的没有更好的选择
        }
      },
    })

    // 先订阅、再发 baseline——中间没有任何 await，不会被真实的新事件插队；但这个顺序
    // 也保证了 onOverflow() 里能拿到 unsubscribe（哪怕超限就发生在 baseline 这一次
    // write() 里也不会引用到还没赋值的变量）。
    const unsubscribe = registry.subscribe(sessionId, (event) => {
      if (closed) return // 已经因为 backlog 超限被放弃的连接，不用再继续处理后续事件
      write({ kind: 'increment', event })
      if (closed) return // write() 这一次调用本身就把 backlog 顶爆了——onOverflow 已经清理过，不用再走 terminal/res.end() 那一套正常收尾
      if (event.type === 'turn/end') {
        closed = true
        unsubscribe()
        write({ kind: 'terminal', reason: event.reason.kind === 'budget_exhausted' ? 'error' : event.reason.kind, lastSeq: event.seq })
        res.end()
      }
    })

    const snapshot = agent.sessionEvents.filter((event) => event.seq > since)
    write({ kind: 'baseline', snapshot })

    req.on('close', () => {
      closed = true
      unsubscribe()
    })
  }

  server.on('close', () => {
    void registry.disposeAll()
  })

  return server
}
