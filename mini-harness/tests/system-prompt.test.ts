import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/core/system-prompt.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ToolDefinition } from '../src/tools/types.js'

function echoTool(): ToolDefinition<string> {
  return {
    name: 'echo',
    description: 'returns whatever text argument it was given',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => value },
    async execute() {
      return ''
    },
  }
}

function listFilesTool(): ToolDefinition<string> {
  return {
    name: 'list_files',
    description: 'lists files in a directory',
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => value },
    async execute() {
      return ''
    },
  }
}

describe('buildSystemPrompt', () => {
  it('includes identity, workspace, and every tool name + description', () => {
    const registry = new ToolRegistry()
    registry.define(echoTool())

    const prompt = buildSystemPrompt({
      identity: 'a read-only code investigator',
      workspaceRoot: '/repo',
      tools: registry.schemas(),
    })

    expect(prompt).toContain('a read-only code investigator')
    expect(prompt).toContain('/repo')
    expect(prompt).toContain('echo')
    expect(prompt).toContain('returns whatever text argument it was given')
  })

  it('says "(none)" when there are no tools, instead of an empty/misleading section', () => {
    const prompt = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: [] })
    expect(prompt).toContain('(none)')
  })

  it('includes taskContext only when provided', () => {
    const withContext = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: [], taskContext: 'find TODOs' })
    const withoutContext = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: [] })
    expect(withContext).toContain('find TODOs')
    expect(withoutContext).not.toContain('Task context')
  })

  it('a tool removed from the registry no longer appears once the prompt is reassembled from a fresh snapshot', () => {
    const registry = new ToolRegistry()
    registry.define(echoTool())
    registry.define(listFilesTool())

    const before = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: registry.schemas() })
    expect(before).toContain('list_files')

    registry.undefine('list_files')
    const after = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: registry.schemas() })
    expect(after).not.toContain('list_files')
    expect(after).toContain('echo') // 没被移除的工具还在，不是整段被清空了
  })

  it('renders a Policies section as a list when policies are provided', () => {
    const prompt = buildSystemPrompt({
      identity: 'x',
      workspaceRoot: '/repo',
      tools: [],
      policies: ['do not perform write operations', 'at most 10 rounds per investigation'],
    })

    expect(prompt).toContain('# Policies')
    expect(prompt).toContain('- do not perform write operations')
    expect(prompt).toContain('- at most 10 rounds per investigation')
  })

  it('omits the Policies section entirely when policies is absent or empty', () => {
    const withoutField = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: [] })
    const withEmptyArray = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: [], policies: [] })

    expect(withoutField).not.toContain('Policies')
    expect(withEmptyArray).not.toContain('Policies')
  })
})
