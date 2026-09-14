import { spawnManaged, type SpawnSpec } from '../tools/process-runner.js'

export type JobStatus =
  | { readonly kind: 'running' }
  | { readonly kind: 'completed'; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string }

export interface JobSnapshot {
  readonly id: string
  readonly status: JobStatus
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly elapsedMs: number
}

export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown job: "${id}"`)
    this.name = 'JobNotFoundError'
  }
}

interface JobRecord {
  readonly controller: AbortController
  readonly process: ReturnType<typeof spawnManaged>
  readonly startedAt: number
  status: JobStatus
  /** 进入终态那一刻冻结的 Date.now()——一旦写入就不再变，poll() 用它代替"现在"来算 elapsedMs。 */
  endedAt?: number
}

/**
 * 后台任务：跟 Day4-16 的工具调用不一样,一个工具调用的生命周期是"这次 execute()
 * 跑完就结束"，Job 的生命周期跨越多次 `poll()`——`start()` 立刻返回,不等子进程
 * 跑完。真正杀进程的能力全部借用 Day16 的 `spawnManaged()`,这里只负责"记住有
 * 哪些 Job、每个现在是什么状态"这层簿记。
 *
 * `cancel()`/`dispose()` 幂等的心智模型完全照抄 Day6 的 `Agent.dispose()`：
 * 对已经是终态的 Job 再调用一次,不重复触发任何副作用。
 */
export class JobRuntime {
  private readonly jobs = new Map<string, JobRecord>()
  private nextId = 0

  start(spec: SpawnSpec): string {
    const id = `job-${this.nextId++}`
    const controller = new AbortController()
    const proc = spawnManaged(spec, controller.signal)
    const record: JobRecord = { controller, process: proc, startedAt: Date.now(), status: { kind: 'running' } }
    this.jobs.set(id, record)

    // 不 await：这正是"start() 立刻返回"的字面实现。跑完之后再回来更新这条记录的
    // status——`record` 是同一个对象引用，Map 里存的那份会跟着一起变。
    proc.done.then(
      (result) => {
        record.status = result.aborted
          ? { kind: 'cancelled' }
          : { kind: 'completed', exitCode: result.exitCode, signal: result.signal }
        record.endedAt = Date.now()
      },
      (error: unknown) => {
        record.status = { kind: 'error', message: error instanceof Error ? error.message : String(error) }
        record.endedAt = Date.now()
      },
    )

    return id
  }

  poll(id: string): JobSnapshot {
    const record = this.getOrThrow(id)
    const stdout = record.process.stdoutSnapshot()
    const stderr = record.process.stderrSnapshot()
    return {
      id,
      status: record.status,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      elapsedMs: (record.endedAt ?? Date.now()) - record.startedAt,
    }
  }

  /** 对一个不存在的 id 调用是调用方的 bug，直接抛错；对同一个已知 Job 重复取消是幂等 no-op。 */
  cancel(id: string): void {
    const record = this.getOrThrow(id)
    if (record.status.kind !== 'running') return
    record.controller.abort()
  }

  /**
   * 幂等释放：不存在/已经释放过的 id 直接 no-op（不抛错——这是"创建者拥有清理
   * 责任"的字面意思：dispose 应该总是安全的,不需要调用方先确认这个 id 还在不在）。
   * 如果 Job 还在跑，dispose 会先取消它，不留下一个继续运行但没人再管的子进程。
   */
  dispose(id: string): void {
    const record = this.jobs.get(id)
    if (!record) return
    if (record.status.kind === 'running') record.controller.abort()
    this.jobs.delete(id)
  }

  private getOrThrow(id: string): JobRecord {
    const record = this.jobs.get(id)
    if (!record) throw new JobNotFoundError(id)
    return record
  }
}
