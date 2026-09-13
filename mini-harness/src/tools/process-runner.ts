import { spawn } from 'node:child_process'

/**
 * 一次子进程调用的完整规格——显式到不留任何"隐式继承"的空子。
 *
 * 设计两次的记录：
 * - `env` 不是"过滤掉几个危险变量"的黑名单，是**白名单**——只有这里列出的键会出现在
 *   子进程环境里，`process.env` 里别的一切（包括调用这个工具的宿主进程自己持有的
 *   secret）默认不会被继承。唯一的例外是调用方没传 `env` 时，我们自己补一个只有
 *   `PATH` 的最小环境（没有 PATH，`ls`/`grep` 这类最基本的命令都找不到可执行文件，
 *   而 PATH 本身通常不被当作敏感信息）。
 * - `args` 是显式数组，不是一整条 shell 字符串——`spawn(command, args)` 不经过 shell
 *   解析，`;`/`|`/`$()`/`&&` 在这里都只是字面字符，不会被解释成命令拼接。曾经考虑过
 *   `shell: true`（换取"能跑管道/通配符"的灵活性），但那等于把"会不会被命令注入"
 *   这道题直接甩给了调用方拼字符串的细心程度——放弃。
 */
export interface SpawnSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdin?: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export interface ProcessRunResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly timedOut: boolean
  readonly aborted: boolean
}

export interface OutputSnapshot {
  readonly text: string
  readonly truncated: boolean
}

/**
 * 一个还在跑（或者刚跑完）的子进程句柄：`done` 跟旧版 `runProcess()` 的返回值一样，
 * 是"跑完之后的最终结果"；`stdoutSnapshot()`/`stderrSnapshot()` 是新加的——不用等
 * `done` resolve，随时可以问"现在为止收集到了什么"。Day17 的 `JobRuntime.poll()`
 * 需要的正是这个"进行中也能看一眼"的能力，`runProcess()`（只关心最终结果）不需要。
 */
export interface ManagedProcess {
  readonly pid: number | undefined
  stdoutSnapshot(): OutputSnapshot
  stderrSnapshot(): OutputSnapshot
  readonly done: Promise<ProcessRunResult>
  /** 跟超时/外部 abort 走的是同一条杀进程树逻辑——调用方主动喊停，语义上没有区别。 */
  cancel(): void
}

/**
 * 有上限的输出收集器：只在还有余量时才真正保留字节，超限之后继续吸收并丢弃后续数据
 * （而不是不再读取管道）——子进程的 stdout/stderr 是有缓冲区上限的管道，如果没人读，
 * 缓冲区写满之后子进程自己会被操作系统阻塞在 write() 调用上，"输出洪水"反而会变成
 * "进程卡死"。持续读、只是不再保留，才能让子进程按自己的节奏正常运行到超时/结束。
 */
class BoundedCollector {
  private readonly chunks: Buffer[] = []
  private bytes = 0
  truncated = false

  constructor(private readonly maxBytes: number) {}

  push(chunk: Buffer): void {
    if (this.truncated) return
    const room = this.maxBytes - this.bytes
    if (chunk.byteLength <= room) {
      this.chunks.push(chunk)
      this.bytes += chunk.byteLength
      return
    }
    if (room > 0) this.chunks.push(chunk.subarray(0, room))
    this.truncated = true
  }

  snapshot(): OutputSnapshot {
    return { text: Buffer.concat(this.chunks).toString('utf8'), truncated: this.truncated }
  }
}

/**
 * 真正 spawn 一次子进程，返回一个"还没等待完成"的句柄。两条独立的"该收手了"
 * 信号——超时和外部取消（现在还加了 `cancel()` 这第三条,三者共用同一套杀法）——
 * 都必须能杀掉**整棵进程树**，不只是这一个进程：`detached: true`（POSIX 上）让
 * 子进程成为一个新进程组的组长，它自己再 fork 出来的孙进程默认还在同一个组里，
 * `process.kill` 传一个负的 pid 杀的是整个组，而不是只有 `child.pid` 这一个进程。
 * 如果只调用 `child.kill()`，一个自己再 fork 了后台进程的命令，子孙进程会变成孤儿
 * 继续跑——这正是 study.md 要讲的"fork 子进程"故障场景。
 *
 * `runProcess()`（Day16 原有的、唯一的入口）现在只是对这个函数的一层等待包装——
 * 这是"深模块加新能力、不改已有窄接口"的一次实际演练：Day16 写的 18 条测试全部
 * 只认 `runProcess()` 这一个函数签名，这次重构一行都不用碰它们。
 */
export function spawnManaged(spec: SpawnSpec, signal: AbortSignal): ManagedProcess {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env as NodeJS.ProcessEnv,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const stdout = new BoundedCollector(spec.maxOutputBytes)
  const stderr = new BoundedCollector(spec.maxOutputBytes)
  let timedOut = false
  let aborted = false
  let settled = false

  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

  if (spec.stdin !== undefined) child.stdin?.write(spec.stdin)
  child.stdin?.end()

  const killTree = (signalName: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try {
      process.kill(process.platform === 'win32' ? child.pid : -child.pid, signalName)
    } catch {
      // 进程已经自己退出了：kill 一个不存在的 pid/进程组会抛 ESRCH，这是正常收尾路径。
    }
  }

  const timer = setTimeout(() => {
    timedOut = true
    killTree('SIGKILL')
  }, spec.timeoutMs)

  const onAbort = (): void => {
    aborted = true
    killTree('SIGKILL')
  }
  signal.addEventListener('abort', onAbort, { once: true })

  const done = new Promise<ProcessRunResult>((resolvePromise, reject) => {
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }

    child.on('error', (error) => settle(() => reject(error)))

    // 'close'（不是 'exit'）：等 stdout/stderr 管道真正关闭、所有已经排队的 'data'
    // 事件都处理完了才触发，保证 resolve 时 stdout/stderr 已经是完整收集到的内容。
    child.on('close', (exitCode, procSignal) => {
      settle(() => {
        const out = stdout.snapshot()
        const err = stderr.snapshot()
        resolvePromise({
          exitCode,
          signal: procSignal,
          stdout: out.text,
          stderr: err.text,
          stdoutTruncated: out.truncated,
          stderrTruncated: err.truncated,
          timedOut,
          aborted,
        })
      })
    })
  })

  return {
    pid: child.pid,
    stdoutSnapshot: () => stdout.snapshot(),
    stderrSnapshot: () => stderr.snapshot(),
    done,
    cancel: () => {
      aborted = true
      killTree('SIGKILL')
    },
  }
}

export function runProcess(spec: SpawnSpec, signal: AbortSignal): Promise<ProcessRunResult> {
  return spawnManaged(spec, signal).done
}
