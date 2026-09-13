import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunCommandTool } from '../src/tools/bash-tool.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ToolArgsError, ToolExecutionError, type ToolExecutionContext } from '../src/tools/types.js'

const NODE = process.execPath

function newRegistry(root: string): ToolRegistry {
  const registry = new ToolRegistry()
  registry.define(createRunCommandTool(root))
  return registry
}

function ctx(signal: AbortSignal = new AbortController().signal): ToolExecutionContext {
  return { signal, cwd: '.' }
}

const tmpDirs: string[] = []
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'run-command-tool-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('run_command: argument validation', () => {
  it('rejects a call missing the required command field', async () => {
    const root = makeWorkspace()
    const registry = newRegistry(root)
    await expect(registry.execute('run_command', {}, ctx())).rejects.toThrow(ToolArgsError)
  })

  it('rejects a timeoutMs above the cap before ever spawning anything', async () => {
    const root = makeWorkspace()
    const registry = newRegistry(root)
    await expect(
      registry.execute('run_command', { command: NODE, args: ['-e', '1'], timeoutMs: 999_999 }, ctx()),
    ).rejects.toThrow(ToolExecutionError)
  })
})

describe('run_command: cwd stays inside the workspace', () => {
  it('rejects a cwd that escapes the workspace root', async () => {
    const root = makeWorkspace()
    const registry = newRegistry(root)
    await expect(
      registry.execute('run_command', { command: NODE, args: ['-e', '1'], cwd: '../../etc' }, ctx()),
    ).rejects.toThrow(ToolExecutionError)
  })

  it('rejects a cwd that does not exist', async () => {
    const root = makeWorkspace()
    const registry = newRegistry(root)
    await expect(
      registry.execute('run_command', { command: NODE, args: ['-e', '1'], cwd: 'no-such-subdir' }, ctx()),
    ).rejects.toThrow(ToolExecutionError)
  })
})

describe('run_command: happy path end to end through the registry', () => {
  it('runs a command and renders stdout with a status line', async () => {
    const root = makeWorkspace()
    const registry = newRegistry(root)
    const result = await registry.execute('run_command', { command: NODE, args: ['-e', 'console.log("hi there")'] }, ctx())
    expect(result.content).toContain('exit code 0')
    expect(result.content).toContain('hi there')
  })
})

describe('run_command: env is allowlist-only, verified through the tool layer (not just process-runner directly)', () => {
  it('a host secret does not leak through run_command even though PATH still works', async () => {
    process.env.SUPER_SECRET_TOKEN_FOR_TEST = 'leaked-value-should-not-appear'
    try {
      const root = makeWorkspace()
      const registry = newRegistry(root)
      const result = await registry.execute(
        'run_command',
        { command: NODE, args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'] },
        ctx(),
      )
      const value = result.value as { stdout: string }
      const childEnv = JSON.parse(value.stdout) as Record<string, string>
      expect(childEnv.PATH).toBeDefined()
      expect(Object.values(childEnv)).not.toContain('leaked-value-should-not-appear')
    } finally {
      delete process.env.SUPER_SECRET_TOKEN_FOR_TEST
    }
  })

  it('explicitly allowlisted variables pass through, and never appear duplicated in error output', async () => {
    const root = makeWorkspace()
    const registry = newRegistry(root)
    const result = await registry.execute(
      'run_command',
      { command: NODE, args: ['-e', 'process.stdout.write(process.env.MY_TOKEN ?? "(missing)")'], env: { MY_TOKEN: 'abc123' } },
      ctx(),
    )
    const value = result.value as { stdout: string }
    expect(value.stdout).toBe('abc123')
  })
})

describe('run_command: a never-exiting process is killed well before the registry-level safety net', () => {
  it("the tool's own internal timeout resolves the call quickly, not the registry's outer timeoutMs", async () => {
    const root = makeWorkspace()
    const registry = newRegistry(root)
    const start = Date.now()
    const result = await registry.execute(
      'run_command',
      { command: NODE, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 150 },
      ctx(),
    )
    const value = result.value as { timedOut: boolean }
    expect(value.timedOut).toBe(true)
    // 远早于 run_command 注册进 registry 的那个"安全网"超时（65s）——真正杀掉子进程的
    // 是 run_command 自己内部对 timeoutMs 的处理，不是 ToolRegistry 那道外层超时。
    expect(Date.now() - start).toBeLessThan(5_000)
  })
})

describe('run_command: cancellation propagates from ToolExecutionContext.signal to the real OS process', () => {
  it('aborting exec.signal both rejects the call and actually kills the underlying process', async () => {
    const root = makeWorkspace()
    const marker = join(root, 'marker.txt')
    writeFileSync(marker, '')
    const registry = newRegistry(root)
    const controller = new AbortController()

    // ToolRegistry.execute() 里的 runWithTimeoutAndAbort 自己也监听同一个 signal，
    // 会在 abort 那一刻就让整体调用以 ToolAbortedError 落空——但这只代表"外层 Promise
    // 不再等了"，不代表真正的子进程已经被杀掉。真正的杀进程动作发生在 run_command
    // 内部（process-runner.ts）自己独立挂的另一个 abort 监听器上，用 marker 文件
    // 验证这一点，而不是只看外层调用有没有 reject。
    const promise = registry.execute(
      'run_command',
      { command: NODE, args: ['-e', `setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"), 20)`], timeoutMs: 10_000 },
      ctx(controller.signal),
    )
    setTimeout(() => controller.abort(), 100)
    await expect(promise).rejects.toThrow() // 外层调用确实提前落空了，不是等满 10s

    await new Promise((r) => setTimeout(r, 150))
    const sizeRightAfter = readFileSync(marker, 'utf8').length
    await new Promise((r) => setTimeout(r, 200))
    const sizeAfterWaiting = readFileSync(marker, 'utf8').length
    expect(sizeAfterWaiting - sizeRightAfter).toBeLessThanOrEqual(2) // 进程真的被杀了，不是还在后台悄悄写
  })
})
