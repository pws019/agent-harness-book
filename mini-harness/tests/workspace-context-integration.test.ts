import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunCommandTool } from '../src/tools/bash-tool.js'
import { InMemoryCredentialStore } from '../src/core/credentials.js'
import type { WorkspaceContext } from '../src/core/workspace-context.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ToolExecutionContext } from '../src/tools/types.js'

const NODE = process.execPath

function ctx(): ToolExecutionContext {
  return { signal: new AbortController().signal, cwd: '.' }
}

const tmpDirs: string[] = []
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-context-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('run_command + WorkspaceContext: credentials resolve into the child env without the model ever handling the raw value', () => {
  it('a credential configured on the workspace shows up in the spawned process env', async () => {
    const root = makeWorkspace()
    const credentials = new InMemoryCredentialStore()
    credentials.set('openai-api-key', 'sk-real-secret-value')
    const workspace: WorkspaceContext = { root, credentials, envCredentials: { OPENAI_API_KEY: { id: 'openai-api-key' } } }

    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root, undefined, workspace))

    const result = await registry.execute(
      'run_command',
      { command: NODE, args: ['-e', 'process.stdout.write(process.env.OPENAI_API_KEY ?? "(missing)")'] },
      ctx(),
    )
    expect(result.content).toContain('sk-real-secret-value')
  })

  it('the model cannot override a workspace-configured credential by passing its own env value with the same name', async () => {
    const root = makeWorkspace()
    const credentials = new InMemoryCredentialStore()
    credentials.set('openai-api-key', 'sk-real-secret-value')
    const workspace: WorkspaceContext = { root, credentials, envCredentials: { OPENAI_API_KEY: { id: 'openai-api-key' } } }

    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root, undefined, workspace))

    const result = await registry.execute(
      'run_command',
      {
        command: NODE,
        args: ['-e', 'process.stdout.write(process.env.OPENAI_API_KEY ?? "(missing)")'],
        env: { OPENAI_API_KEY: 'model-supplied-fake-value' }, // 模型自己想传一个同名变量
      },
      ctx(),
    )
    expect(result.content).toContain('sk-real-secret-value') // workspace 配置的凭据赢了，不是模型传的那个
    expect(result.content).not.toContain('model-supplied-fake-value')
  })

  it('with no workspace configured, run_command behaves exactly as before (no credential injected)', async () => {
    const root = makeWorkspace()
    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root)) // 没传 workspace

    const result = await registry.execute(
      'run_command',
      { command: NODE, args: ['-e', 'process.stdout.write(process.env.OPENAI_API_KEY ?? "(missing)")'] },
      ctx(),
    )
    expect(result.content).toContain('(missing)')
  })
})
