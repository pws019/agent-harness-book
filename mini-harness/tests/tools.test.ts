import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/tools/registry.js'
import { createReadOnlyFsTools } from '../src/tools/fs-tools.js'
import { ToolArgsError, ToolNotFoundError, ToolTimeoutError, type ToolDefinition } from '../src/tools/types.js'
import { PathEscapeError, resolveWithinRoot } from '../src/tools/workspace.js'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, 'fixtures', 'workspace')

function newRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  for (const tool of createReadOnlyFsTools(workspaceRoot)) registry.define(tool)
  return registry
}

function ctx(signal: AbortSignal = new AbortController().signal) {
  return { signal, cwd: workspaceRoot }
}

describe('ToolRegistry.schemas() never leaks implementation details to the model', () => {
  it('only exposes name/description/parameters', () => {
    const registry = newRegistry()
    const schemas = registry.schemas()
    expect(schemas.length).toBe(3)
    for (const schema of schemas) {
      expect(Object.keys(schema).sort()).toEqual(['description', 'name', 'parameters'])
    }
  })
})

describe('read_file: deep interface behavior', () => {
  it('reads a file with default offset/limit', async () => {
    const registry = newRegistry()
    const result = await registry.execute('read_file', { file_path: 'src/index.ts' }, ctx())
    const value = result.value as { totalLines: number; startLine: number }
    expect(value.startLine).toBe(1)
    expect(value.totalLines).toBeGreaterThan(0)
    expect(result.content).toContain('1\texport function add')
  })

  it('respects offset and limit', async () => {
    const registry = newRegistry()
    const result = await registry.execute('read_file', { file_path: 'src/index.ts', offset: 5, limit: 1 }, ctx())
    const value = result.value as { startLine: number; endLine: number; lines: string[] }
    expect(value.startLine).toBe(5)
    expect(value.endLine).toBe(5)
    expect(value.lines).toHaveLength(1)
  })

  it('reports a clear execution error for a missing file, not a crash', async () => {
    const registry = newRegistry()
    await expect(registry.execute('read_file', { file_path: 'does/not/exist.ts' }, ctx())).rejects.toThrow(
      /cannot read/,
    )
  })

  it('rejects a path that escapes the workspace root', async () => {
    const registry = newRegistry()
    await expect(
      registry.execute('read_file', { file_path: '../outside-secret.txt' }, ctx()),
    ).rejects.toThrow(PathEscapeError)
  })

  it('rejects unknown parameters because additionalProperties is false', async () => {
    const registry = newRegistry()
    await expect(
      registry.execute('read_file', { file_path: 'src/index.ts', bogus: true }, ctx()),
    ).rejects.toThrow(ToolArgsError)
  })

  it('rejects a missing required parameter', async () => {
    const registry = newRegistry()
    await expect(registry.execute('read_file', {}, ctx())).rejects.toThrow(ToolArgsError)
  })
})

describe('list_files', () => {
  it('lists entries sorted by name, skipping node_modules', async () => {
    const registry = newRegistry()
    const result = await registry.execute('list_files', {}, ctx())
    const value = result.value as { entries: { name: string; type: string }[] }
    const names = value.entries.map((e) => e.name)
    expect(names).toContain('README.md')
    expect(names).toContain('src')
    expect(names).not.toContain('node_modules')
  })

  it('lists a subdirectory', async () => {
    const registry = newRegistry()
    const result = await registry.execute('list_files', { path: 'src' }, ctx())
    const value = result.value as { entries: { name: string }[] }
    expect(value.entries.map((e) => e.name).sort()).toEqual(['index.ts', 'util.ts'])
  })

  it('rejects a path that escapes the workspace root', async () => {
    const registry = newRegistry()
    await expect(registry.execute('list_files', { path: '..' }, ctx())).rejects.toThrow(PathEscapeError)
  })
})

describe('search_text', () => {
  it('finds matches across files and skips node_modules', async () => {
    const registry = newRegistry()
    const result = await registry.execute('search_text', { query: 'TARGET_NEEDLE' }, ctx())
    const value = result.value as { matches: { path: string }[]; totalMatches: number }
    expect(value.totalMatches).toBeGreaterThanOrEqual(2)
    expect(value.matches.some((m) => m.path.includes('node_modules'))).toBe(false)
  })

  it('reports zero matches without error', async () => {
    const registry = newRegistry()
    const result = await registry.execute('search_text', { query: 'no such string anywhere' }, ctx())
    expect(result.content).toBe('no matches for "no such string anywhere"')
  })

  it('rejects a starting path that escapes the workspace root', async () => {
    const registry = newRegistry()
    await expect(registry.execute('search_text', { query: 'x', path: '..' }, ctx())).rejects.toThrow(
      PathEscapeError,
    )
  })
})

describe('ToolRegistry: pipeline behavior shared by all tools', () => {
  it('throws ToolNotFoundError for an unregistered tool name', async () => {
    const registry = newRegistry()
    await expect(registry.execute('delete_everything', {}, ctx())).rejects.toThrow(ToolNotFoundError)
  })

  it('enforces timeoutMs and reports ToolTimeoutError', async () => {
    const registry = new ToolRegistry()
    const slowTool: ToolDefinition<string> = {
      name: 'slow',
      description: 'never resolves within the timeout',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
      output: { schema: { type: 'string' }, render: (_a, v) => v },
      timeoutMs: 20,
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        return 'too late'
      },
    }
    registry.define(slowTool)
    await expect(registry.execute('slow', {}, ctx())).rejects.toThrow(ToolTimeoutError)
  })

  it('define() rejects a schema whose object nodes omit additionalProperties', () => {
    const registry = new ToolRegistry()
    const badTool: ToolDefinition<string> = {
      name: 'bad',
      description: 'forgot to declare additionalProperties',
      parameters: { type: 'object', required: [], properties: {} }, // missing additionalProperties on purpose
      output: { schema: { type: 'string' }, render: (_a, v) => v },
      async execute() {
        return 'unused'
      },
    }
    expect(() => registry.define(badTool)).toThrow(/additionalProperties/)
  })

  it('a signal aborted before dispatch prevents execute() from ever running', async () => {
    const registry = newRegistry()
    const controller = new AbortController()
    controller.abort()
    let ran = false
    const registry2 = new ToolRegistry()
    registry2.define<string>({
      name: 'noop',
      description: 'tracks whether it ran',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
      output: { schema: { type: 'string' }, render: (_a, v) => v },
      async execute() {
        ran = true
        return 'ran'
      },
    })
    await expect(registry2.execute('noop', {}, ctx(controller.signal))).rejects.toThrow()
    expect(ran).toBe(false)
  })
})

describe('resolveWithinRoot', () => {
  it('allows the root itself and nested paths', () => {
    expect(() => resolveWithinRoot(workspaceRoot, '.')).not.toThrow()
    expect(() => resolveWithinRoot(workspaceRoot, 'src/index.ts')).not.toThrow()
  })

  it('rejects any ../ traversal that ends up outside the root', () => {
    expect(() => resolveWithinRoot(workspaceRoot, '../outside-secret.txt')).toThrow(PathEscapeError)
    expect(() => resolveWithinRoot(workspaceRoot, 'src/../../outside-secret.txt')).toThrow(PathEscapeError)
  })
})
