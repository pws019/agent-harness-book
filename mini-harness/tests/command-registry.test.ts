import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalStore } from '../src/core/approval.js'
import { CommandNotFoundError, CommandRegistry, DuplicateCommandError, createProposeEditCommand } from '../src/core/command-registry.js'
import type { Command } from '../src/core/command-registry.js'

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'command-registry-test-'))
  tmpDirs.push(dir)
  return dir
}

function echoCommand(): Command<string, string> {
  return { name: 'echo', description: 'returns its input', execute: async (text) => text }
}

describe('CommandRegistry: human-triggered actions, distinct from model-triggered tools', () => {
  it('registers and executes a command by name', async () => {
    const registry = new CommandRegistry()
    registry.define(echoCommand())
    expect(await registry.execute('echo', 'hello')).toBe('hello')
  })

  it('registering the same name twice throws instead of silently overwriting', () => {
    const registry = new CommandRegistry()
    registry.define(echoCommand())
    expect(() => registry.define(echoCommand())).toThrow(DuplicateCommandError)
  })

  it('executing an unregistered command name throws instead of silently no-op-ing', async () => {
    const registry = new CommandRegistry()
    await expect(registry.execute('nope', undefined)).rejects.toThrow(CommandNotFoundError)
  })

  it('names() lists every registered command', () => {
    const registry = new CommandRegistry()
    registry.define(echoCommand())
    expect(registry.names()).toEqual(['echo'])
  })
})

describe('createProposeEditCommand: a real, non-hypothetical wrapper around Day21 proposeEdit()', () => {
  it('formalizing proposeEdit() as a Command does not change its behavior', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'TODO: fix bug\n')

    const registry = new CommandRegistry()
    registry.define(createProposeEditCommand())

    const outcome = await registry.execute('propose-edit', {
      root,
      filePath: 'notes.txt',
      find: 'TODO',
      replace: 'DONE',
      approvalStore: new ApprovalStore(),
      requestApproval: () => true,
    })

    expect(outcome).toMatchObject({ kind: 'applied' })
  })
})
