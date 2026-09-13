import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunCommandTool } from '../src/tools/bash-tool.js'
import { AllowlistCommandPolicy, FailClosedCommandPolicy, type CommandPolicy } from '../src/tools/command-policy.js'
import { JobRuntime } from '../src/core/job-runtime.js'
import { createJobTools } from '../src/tools/job-tools.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ToolExecutionError, type ToolExecutionContext } from '../src/tools/types.js'

const NODE = process.execPath

function ctx(): ToolExecutionContext {
  return { signal: new AbortController().signal, cwd: '.' }
}

const tmpDirs: string[] = []
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'command-policy-integration-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('run_command with a CommandPolicy: enforcement actually happens, not just decision', () => {
  it('denies a command the policy does not allow, before ever spawning it', async () => {
    const root = makeWorkspace()
    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root, new AllowlistCommandPolicy(['echo'])))

    await expect(registry.execute('run_command', { command: NODE, args: ['-e', '1'] }, ctx())).rejects.toThrow(
      ToolExecutionError,
    )
  })

  it('allows a command the policy explicitly permits', async () => {
    const root = makeWorkspace()
    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root, new AllowlistCommandPolicy([NODE])))

    const result = await registry.execute('run_command', { command: NODE, args: ['-e', 'console.log("ok")'] }, ctx())
    expect(result.content).toContain('ok')
  })

  it('with no policy at all, every command is allowed (today’s default — sandboxing is opt-in, not automatic)', async () => {
    const root = makeWorkspace()
    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root)) // 没传 policy

    const result = await registry.execute('run_command', { command: NODE, args: ['-e', 'console.log("ok")'] }, ctx())
    expect(result.content).toContain('ok')
  })

  it('fail-closed: a policy that throws while deciding denies the command instead of allowing it', async () => {
    const root = makeWorkspace()
    const brokenInner: CommandPolicy = {
      isAllowed() {
        throw new Error('policy config failed to load')
      },
    }
    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root, new FailClosedCommandPolicy(brokenInner)))

    await expect(registry.execute('run_command', { command: NODE, args: ['-e', '1'] }, ctx())).rejects.toThrow(
      ToolExecutionError,
    )
  })
})

describe('start_job with a CommandPolicy: the same enforcement applies to background jobs', () => {
  it('denies a disallowed command before a background process is ever started', async () => {
    const root = makeWorkspace()
    const runtime = new JobRuntime()
    const registry = new ToolRegistry()
    for (const tool of createJobTools(root, runtime, new AllowlistCommandPolicy(['echo']))) registry.define(tool)

    await expect(registry.execute('start_job', { command: NODE, args: ['-e', '1'] }, ctx())).rejects.toThrow(
      ToolExecutionError,
    )
  })
})
