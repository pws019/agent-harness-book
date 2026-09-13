import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { JobRuntime } from '../src/core/job-runtime.js'
import { createJobTools } from '../src/tools/job-tools.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ToolArgsError, ToolExecutionError, type ToolExecutionContext } from '../src/tools/types.js'

const NODE = process.execPath

function ctx(): ToolExecutionContext {
  return { signal: new AbortController().signal, cwd: '.' }
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil: timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

const tmpDirs: string[] = []
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'job-tools-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

function newRegistry(root: string, runtime: JobRuntime): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of createJobTools(root, runtime)) registry.define(tool)
  return registry
}

describe('start_job / job_status / cancel_job: end to end through the registry', () => {
  it('starts a job, observes it complete, and reports the real exit code', async () => {
    const root = makeWorkspace()
    const runtime = new JobRuntime()
    const registry = newRegistry(root, runtime)

    const started = await registry.execute('start_job', { command: NODE, args: ['-e', 'console.log("hi")'] }, ctx())
    const jobId = (started.value as { jobId: string }).jobId
    expect(started.content).toContain(jobId)

    let status = ''
    await waitUntil(async () => {
      const result = await registry.execute('job_status', { jobId }, ctx())
      status = (result.value as { status: string }).status
      return !status.startsWith('running')
    })
    expect(status).toContain('exit code 0')

    const final = await registry.execute('job_status', { jobId }, ctx())
    expect(final.content).toContain('hi')
  })

  it('cancel_job stops a never-exiting job', async () => {
    const root = makeWorkspace()
    const runtime = new JobRuntime()
    const registry = newRegistry(root, runtime)

    const started = await registry.execute('start_job', { command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'] }, ctx())
    const jobId = (started.value as { jobId: string }).jobId

    const cancelResult = await registry.execute('cancel_job', { jobId }, ctx())
    expect(cancelResult.content).toContain(jobId)

    let status = ''
    await waitUntil(async () => {
      const result = await registry.execute('job_status', { jobId }, ctx())
      status = (result.value as { status: string }).status
      return status !== 'running'
    })
    expect(status).toBe('cancelled')
  })

  it('job_status/cancel_job on an unknown jobId surface as a normal tool error, not a raw internal exception', async () => {
    const root = makeWorkspace()
    const runtime = new JobRuntime()
    const registry = newRegistry(root, runtime)

    await expect(registry.execute('job_status', { jobId: 'no-such-job' }, ctx())).rejects.toThrow(ToolExecutionError)
    await expect(registry.execute('cancel_job', { jobId: 'no-such-job' }, ctx())).rejects.toThrow(ToolExecutionError)
  })
})

describe('start_job: argument validation and workspace boundaries', () => {
  it('rejects a call missing the required command field', async () => {
    const root = makeWorkspace()
    const runtime = new JobRuntime()
    const registry = newRegistry(root, runtime)
    await expect(registry.execute('start_job', {}, ctx())).rejects.toThrow(ToolArgsError)
  })

  it('rejects a cwd that escapes the workspace root', async () => {
    const root = makeWorkspace()
    const runtime = new JobRuntime()
    const registry = newRegistry(root, runtime)
    await expect(
      registry.execute('start_job', { command: NODE, args: ['-e', '1'], cwd: '../../etc' }, ctx()),
    ).rejects.toThrow(ToolExecutionError)
  })

  it('rejects a timeoutMs above the cap before ever starting the job', async () => {
    const root = makeWorkspace()
    const runtime = new JobRuntime()
    const registry = newRegistry(root, runtime)
    await expect(
      registry.execute('start_job', { command: NODE, args: ['-e', '1'], timeoutMs: 999_999_999_999 }, ctx()),
    ).rejects.toThrow(ToolExecutionError)
  })
})
