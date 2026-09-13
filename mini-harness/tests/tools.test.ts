import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/tools/registry.js'
import { createEditFileTool, createReadOnlyFsTools } from '../src/tools/fs-tools.js'
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

// edit_file 会真的写盘，不能共用只读工具那份签入 git 的 fixtures/workspace——每个用例
// 在系统临时目录下开一块自己的地盘，用完删掉，互不干扰也不留垃圾。
const tempDirs: string[] = []
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mini-harness-edit-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

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

describe('ToolRegistry.undefine', () => {
  it('removes a tool so it no longer appears in schemas() or has(), and returns whether it existed', () => {
    const registry = newRegistry()
    expect(registry.has('list_files')).toBe(true)

    expect(registry.undefine('list_files')).toBe(true)
    expect(registry.has('list_files')).toBe(false)
    expect(registry.schemas().some((s) => s.name === 'list_files')).toBe(false)

    expect(registry.undefine('list_files')).toBe(false) // 第二次撤销同一个名字：没东西可撤，返回 false
  })

  it('undefining one tool does not affect the others', () => {
    const registry = newRegistry()
    registry.undefine('list_files')
    expect(registry.schemas().map((s) => s.name).sort()).toEqual(['read_file', 'search_text'])
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

describe('edit_file: create / overwrite / dry-run', () => {
  function editRegistry(root: string): ToolRegistry {
    const registry = new ToolRegistry()
    registry.define(createEditFileTool(root))
    return registry
  }

  it('creates a brand-new file when expectedHash is omitted', async () => {
    const root = tempWorkspace()
    const registry = editRegistry(root)
    const result = await registry.execute('edit_file', { file_path: 'new.txt', content: 'hello\n' }, ctx())
    const value = result.value as { applied: boolean; previousHash: string | null; newHash: string }
    expect(value.applied).toBe(true)
    expect(value.previousHash).toBeNull()
    expect(value.newHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects creating a file that already exists without expectedHash', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'existing.txt'), 'old\n', 'utf8')
    const registry = editRegistry(root)
    await expect(
      registry.execute('edit_file', { file_path: 'existing.txt', content: 'new\n' }, ctx()),
    ).rejects.toThrow(/already exists/)
  })

  it('rejects expectedHash on a file that does not exist yet', async () => {
    const root = tempWorkspace()
    const registry = editRegistry(root)
    await expect(
      registry.execute('edit_file', { file_path: 'nope.txt', content: 'x', expectedHash: 'deadbeef' }, ctx()),
    ).rejects.toThrow(/does not exist yet/)
  })

  it('overwrites when expectedHash matches the current content', async () => {
    const root = tempWorkspace()
    const registry = editRegistry(root)
    const read = new ToolRegistry()
    for (const tool of createReadOnlyFsTools(root)) read.define(tool)
    writeFileSync(join(root, 'a.txt'), 'v1\n', 'utf8')

    const before = (await read.execute('read_file', { file_path: 'a.txt' }, { signal: new AbortController().signal, cwd: root }))
      .value as { contentHash: string }
    const result = await registry.execute(
      'edit_file',
      { file_path: 'a.txt', content: 'v2\n', expectedHash: before.contentHash },
      ctx(),
    )
    const value = result.value as { applied: boolean; diff: string }
    expect(value.applied).toBe(true)
    expect(value.diff).toBe('-v1\n+v2')
  })

  it('dryRun returns a diff without touching disk', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'a.txt'), 'v1\n', 'utf8')
    const registry = editRegistry(root)
    const read = new ToolRegistry()
    for (const tool of createReadOnlyFsTools(root)) read.define(tool)
    const before = (await read.execute('read_file', { file_path: 'a.txt' }, { signal: new AbortController().signal, cwd: root }))
      .value as { contentHash: string }

    const result = await registry.execute(
      'edit_file',
      { file_path: 'a.txt', content: 'v2\n', expectedHash: before.contentHash, dryRun: true },
      ctx(),
    )
    const value = result.value as { applied: boolean; newHash: string | null }
    expect(value.applied).toBe(false)
    expect(value.newHash).toBeNull()

    const stillOld = (await read.execute('read_file', { file_path: 'a.txt' }, { signal: new AbortController().signal, cwd: root }))
      .value as { lines: string[] }
    expect(stillOld.lines).toEqual(['v1', ''])
  })

  it('rejects an edit whose expectedHash no longer matches the file on disk (TOCTOU)', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'a.txt'), 'v1\n', 'utf8')
    const read = new ToolRegistry()
    for (const tool of createReadOnlyFsTools(root)) read.define(tool)
    const before = (await read.execute('read_file', { file_path: 'a.txt' }, { signal: new AbortController().signal, cwd: root }))
      .value as { contentHash: string }

    // 读完之后、编辑之前，文件被"别人"改了
    writeFileSync(join(root, 'a.txt'), 'concurrently changed\n', 'utf8')

    const registry = editRegistry(root)
    await expect(
      registry.execute('edit_file', { file_path: 'a.txt', content: 'v2\n', expectedHash: before.contentHash }, ctx()),
    ).rejects.toThrow(/has changed since you last read it/)

    const after = (await read.execute('read_file', { file_path: 'a.txt' }, { signal: new AbortController().signal, cwd: root }))
      .value as { lines: string[] }
    expect(after.lines).toEqual(['concurrently changed', ''])
  })

  it('refuses to write binary-looking content', async () => {
    const root = tempWorkspace()
    const registry = editRegistry(root)
    const binaryish = 'x\0y'
    await expect(
      registry.execute('edit_file', { file_path: 'bin.dat', content: binaryish }, ctx()),
    ).rejects.toThrow(/binary/)
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
