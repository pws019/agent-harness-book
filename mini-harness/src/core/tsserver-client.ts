import { spawn, type ChildProcess } from 'node:child_process'
import { killProcessTree } from '../tools/process-runner.js'

export interface TsserverResponse {
  readonly success: boolean
  readonly command: string
  readonly body?: unknown
  readonly message?: string
}

export class TsserverExitedError extends Error {
  constructor() {
    super('tsserver process exited before responding')
    this.name = 'TsserverExitedError'
  }
}

export class TsserverTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`tsserver did not respond to "${command}" within ${timeoutMs}ms`)
    this.name = 'TsserverTimeoutError'
  }
}

/**
 * 一个真实语言服务进程的客户端——不是抄近道用进程内 TypeScript Compiler API,而是
 * 真的 spawn `tsserver`（`typescript` 自带,零新依赖）、走它自己的协议。协议细节是
 * 实测确认的,不是凭 LSP 规范猜的：
 *
 * - **请求**：一行 JSON（`{seq, type:'request', command, arguments}`）+ 换行符,写进
 *   stdin,不需要 header。
 * - **响应/事件**：`Content-Length: N\r\n\r\n` + 精确 N 字节 JSON——这是 LSP 用的同一种
 *   header framing。tsserver 的协议比 LSP 规范还早,两者不是谁抄谁,只是撞上了同一个
 *   解法：消息体本身可能包含任意字符,"先声明精确字节数、再按字节数切"才是可靠的
 *   分帧方式,不能像 Day22 `wire-protocol.ts` 那样简单按换行切分（那个场景下消息体
 *   保证不跨行）。
 * - 服务器会在响应之外主动推送 **event** 消息（比如 `projectLoadingStart`）——必须
 *   正确跳过它们,只把 `type === 'response'` 且 `request_seq` 匹配的消息喂给等待中
 *   的请求。
 *
 * 进程本身用裸的 `child_process.spawn()`,不是 Day16/17 的 `spawnManaged()`——原因
 * 见 `killProcessTree()` 的文档注释：`spawnManaged()` 是"一次性收集完整输出、等进程
 * 退出"这个形状,tsserver 是"长期存活、按需读写"这个形状,两者从根本上不兼容,硬套
 * 会让代码更难读，只复用真正通用的"杀整棵进程树"这一小块逻辑。
 */
export class TsserverClient {
  private readonly child: ChildProcess
  private buffer = ''
  private nextSeq = 0
  private readonly pending = new Map<number, { resolve: (res: TsserverResponse) => void; reject: (err: Error) => void }>()
  private exited = false

  constructor(binaryPath = 'node_modules/.bin/tsserver') {
    this.child = spawn(binaryPath, [], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    this.child.on('exit', () => {
      this.exited = true
      for (const { reject } of this.pending.values()) reject(new TsserverExitedError())
      this.pending.clear()
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.slice(0, headerEnd)
      const match = /Content-Length: (\d+)/.exec(header)
      if (!match) return // 不完整/不认识的头，等更多数据到达
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return // 消息体还没收全，等下一个 chunk
      const body = this.buffer.slice(bodyStart, bodyStart + length)
      this.buffer = this.buffer.slice(bodyStart + length)
      this.handleMessage(JSON.parse(body))
    }
  }

  private handleMessage(msg: { readonly type: string; readonly request_seq?: number }): void {
    if (msg.type !== 'response' || msg.request_seq === undefined) return // 跳过 event 消息
    const waiter = this.pending.get(msg.request_seq)
    if (!waiter) return
    this.pending.delete(msg.request_seq)
    waiter.resolve(msg as unknown as TsserverResponse)
  }

  /** 发一个请求、等对应的响应。`timeoutMs` 防的是"tsserver 卡死、永远不回复"——
   * 跟 Day16 `run_command` 的超时是同一个纪律：不能因为下游卡住就让调用方永远挂着。 */
  request(command: string, args: unknown, timeoutMs = 5_000): Promise<TsserverResponse> {
    if (this.exited) return Promise.reject(new TsserverExitedError())
    const seq = this.nextSeq++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new TsserverTimeoutError(command, timeoutMs))
      }, timeoutMs)
      this.pending.set(seq, {
        resolve: (res) => {
          clearTimeout(timer)
          resolve(res)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
      this.child.stdin?.write(`${JSON.stringify({ seq, type: 'request', command, arguments: args })}\n`)
    })
  }

  async open(file: string): Promise<void> {
    await this.request('open', { file })
  }

  /** 1-indexed 行/列——跟 tsserver 协议本身的约定一致,不做 0-index 转换。 */
  async definition(file: string, line: number, offset: number): Promise<readonly unknown[]> {
    const res = await this.request('definition', { file, line, offset })
    return (res.body as readonly unknown[] | undefined) ?? []
  }

  async references(file: string, line: number, offset: number): Promise<readonly unknown[]> {
    const res = await this.request('references', { file, line, offset })
    const body = res.body as { readonly refs?: readonly unknown[] } | undefined
    return body?.refs ?? []
  }

  dispose(): void {
    if (this.exited) return
    killProcessTree(this.child, 'SIGKILL')
  }
}
