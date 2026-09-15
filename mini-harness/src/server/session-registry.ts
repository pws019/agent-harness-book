import { randomUUID } from 'node:crypto'
import { Agent, type AgentDeps } from '../core/agent-handle.js'
import type { SessionEvent } from '../core/session.js'
import type { Message } from '../llm/types.js'

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown session: "${id}"`)
    this.name = 'SessionNotFoundError'
  }
}

type EventListener = (event: SessionEvent) => void

interface SessionEntry {
  readonly agent: Agent
  /** 这个 session 真正调用过几次 `agent.send()`——不是"收到过几次 HTTP 请求"。
   * `Idempotency-Key` 命中缓存的那些请求不会让这个数字增加，靠这个数字本身就能
   * 在测试里断言"重复提交没有真的启动第二个任务"，不需要额外的 spy。 */
  sendCallCount: number
  readonly listeners: Set<EventListener>
}

/**
 * 每个 session 的生命周期所有者：一个进程内的 `Map<sessionId, Agent>`。HTTP 层
 * （`http-server.ts`）不直接持有 `Agent`，只通过这一层间接操作——这是 Day9
 * `Agent.appendEvent()` 翻译层的同一种思路：一层薄薄的转发，把"这个事件发生了，
 * 所有正在监听的地方都要知道"这件事集中到一处（这里是广播给正在挂着的
 * `GET /events` 连接）。`create()` 给每个 session 装一个自定义的 `SessionSink`——
 * 不写盘（Day9/14 的 `JsonlSessionStore` 是另一条独立的持久化路径，这里没有接），
 * 只是把每条事件转发给当前订阅的监听器，`append()` 本身不做任何过滤/缓冲。
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>()

  create(deps: Omit<AgentDeps, 'sink'>): string {
    const id = randomUUID()
    const listeners = new Set<EventListener>()
    const agent = new Agent({
      ...deps,
      sink: {
        append: (event) => {
          for (const listener of listeners) listener(event)
        },
      },
    })
    this.sessions.set(id, { agent, sendCallCount: 0, listeners })
    return id
  }

  private entry(id: string): SessionEntry {
    const entry = this.sessions.get(id)
    if (!entry) throw new SessionNotFoundError(id)
    return entry
  }

  get(id: string): Agent {
    return this.entry(id).agent
  }

  /** 真正调用一次 `agent.send()`，返回这个 session 目前为止调用过几次——
   * 幂等去重靠的就是"这个数字有没有变化"，不是靠比较响应内容。 */
  sendMessage(id: string, message: Message): number {
    const entry = this.entry(id)
    entry.agent.send(message)
    entry.sendCallCount += 1
    return entry.sendCallCount
  }

  cancel(id: string): void {
    this.entry(id).agent.cancel({ kind: 'user' })
  }

  /** 订阅这个 session 之后产生的每一条新事件；返回的函数用来取消订阅——
   * `GET /events` 连接断开时必须调用它，不然监听器集合会无限增长（同一类
   * "谁分配谁释放"纪律，Day6/17 已经反复讲过）。 */
  subscribe(id: string, listener: EventListener): () => void {
    const entry = this.entry(id)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  async dispose(id: string): Promise<void> {
    const entry = this.sessions.get(id)
    if (!entry) return
    await entry.agent.dispose()
    this.sessions.delete(id)
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.dispose(id)))
  }
}
