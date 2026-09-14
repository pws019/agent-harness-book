import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JobNotFoundError, JobRuntime } from '../src/core/job-runtime.js'
import type { SpawnSpec } from '../src/tools/process-runner.js'

const NODE = process.execPath

function spec(overrides: Partial<SpawnSpec> & { readonly args: readonly string[] }): SpawnSpec {
  return {
    command: NODE,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 5_000,
    maxOutputBytes: 200_000,
    ...overrides,
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const tmpDirs: string[] = []
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-runtime-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('JobRuntime: start() returns immediately, does not wait for completion', () => {
  it('poll() right after start() shows running, before the process could plausibly have finished', async () => {
    const runtime = new JobRuntime()
    const id = runtime.start(spec({ args: ['-e', 'setInterval(() => {}, 1000)'] }))
    expect(runtime.poll(id).status).toEqual({ kind: 'running' })
    runtime.dispose(id) // 收尾，不留下一个真的永不退出的进程
  })
})

describe('JobRuntime: poll() reflects live progress, then a single terminal state', () => {
  it('stdout accumulates while running, and status becomes completed with the real exit code', async () => {
    const runtime = new JobRuntime()
    const id = runtime.start(spec({ args: ['-e', 'console.log("hello from job")'] }))

    await waitUntil(() => runtime.poll(id).status.kind !== 'running')

    const snapshot = runtime.poll(id)
    expect(snapshot.status).toEqual({ kind: 'completed', exitCode: 0, signal: null })
    expect(snapshot.stdout).toContain('hello from job')

    // 终态只出现一次：再 poll 几次，结果必须完全一样，不会"抖动"回 running 或变成别的状态。
    expect(runtime.poll(id).status).toEqual(snapshot.status)
  })

  it('a command that fails to spawn ends up in an error status, not stuck running forever', async () => {
    const runtime = new JobRuntime()
    const id = runtime.start(spec({ command: '/no/such/executable-xyz', args: [] }))
    await waitUntil(() => runtime.poll(id).status.kind !== 'running')
    expect(runtime.poll(id).status.kind).toBe('error')
  })
})

describe('JobRuntime: elapsedMs tracks running time, then freezes at the terminal moment', () => {
  it('elapsedMs grows across successive poll() calls while the job is still running', async () => {
    const runtime = new JobRuntime()
    const id = runtime.start(spec({ args: ['-e', 'setInterval(() => {}, 1000)'] }))

    const first = runtime.poll(id).elapsedMs
    await new Promise((r) => setTimeout(r, 30))
    const second = runtime.poll(id).elapsedMs

    expect(second).toBeGreaterThan(first)
    runtime.dispose(id)
  })

  it('elapsedMs is frozen once the job reaches a terminal state, not still counting up on later poll() calls', async () => {
    const runtime = new JobRuntime()
    const id = runtime.start(spec({ args: ['-e', 'console.log("done")'] }))
    await waitUntil(() => runtime.poll(id).status.kind !== 'running')

    const rightAfter = runtime.poll(id).elapsedMs
    await new Promise((r) => setTimeout(r, 100))
    const muchLater = runtime.poll(id).elapsedMs

    expect(muchLater).toBe(rightAfter)
  })
})

describe('JobRuntime: cancel() actually kills the underlying process tree', () => {
  it('a never-exiting job is truly dead after cancel(), verified via a marker file (not just the status flag)', async () => {
    const dir = makeTmpDir()
    const marker = join(dir, 'marker.txt')
    writeFileSync(marker, '')
    const runtime = new JobRuntime()
    const id = runtime.start(
      spec({ args: ['-e', `setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"), 20)`] }),
    )

    await waitUntil(() => readFileSync(marker, 'utf8').length > 0) // 先确认它真的在写
    runtime.cancel(id)
    await waitUntil(() => runtime.poll(id).status.kind !== 'running')
    expect(runtime.poll(id).status).toEqual({ kind: 'cancelled' })

    const sizeRightAfter = readFileSync(marker, 'utf8').length
    await new Promise((r) => setTimeout(r, 150))
    const sizeAfterWaiting = readFileSync(marker, 'utf8').length
    expect(sizeAfterWaiting - sizeRightAfter).toBeLessThanOrEqual(2) // 没有继续在后台写了
  })

  it('cancelling an already-terminal job is a no-op, not an error', async () => {
    const runtime = new JobRuntime()
    const id = runtime.start(spec({ args: ['-e', 'console.log("done")'] }))
    await waitUntil(() => runtime.poll(id).status.kind !== 'running')
    expect(() => runtime.cancel(id)).not.toThrow()
    expect(runtime.poll(id).status).toEqual({ kind: 'completed', exitCode: 0, signal: null }) // 没被 cancel() 覆盖成 cancelled
  })

  it('cancel()/poll() on an unknown id throw JobNotFoundError', () => {
    const runtime = new JobRuntime()
    expect(() => runtime.cancel('no-such-job')).toThrow(JobNotFoundError)
    expect(() => runtime.poll('no-such-job')).toThrow(JobNotFoundError)
  })
})

describe('JobRuntime: dispose() is idempotent and cleans up a still-running job', () => {
  it('disposing a running job kills it (creator owns cleanup, even without an explicit cancel() first)', async () => {
    const dir = makeTmpDir()
    const marker = join(dir, 'marker.txt')
    writeFileSync(marker, '')
    const runtime = new JobRuntime()
    const id = runtime.start(
      spec({ args: ['-e', `setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"), 20)`] }),
    )
    await waitUntil(() => readFileSync(marker, 'utf8').length > 0)

    runtime.dispose(id)
    await new Promise((r) => setTimeout(r, 100)) // 给 kill 信号一点时间真正生效

    const sizeRightAfter = readFileSync(marker, 'utf8').length
    await new Promise((r) => setTimeout(r, 150))
    const sizeAfterWaiting = readFileSync(marker, 'utf8').length
    expect(sizeAfterWaiting - sizeRightAfter).toBeLessThanOrEqual(2)

    expect(() => runtime.poll(id)).toThrow(JobNotFoundError) // 记录本身也真的被清掉了
  })

  it('calling dispose() twice, or on an id that never existed, never throws', () => {
    const runtime = new JobRuntime()
    const id = runtime.start(spec({ args: ['-e', 'console.log("x")'] }))
    expect(() => runtime.dispose(id)).not.toThrow()
    expect(() => runtime.dispose(id)).not.toThrow() // 第二次：已经不在了，no-op
    expect(() => runtime.dispose('never-existed')).not.toThrow()
  })
})
