import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditFileTool, createReadOnlyFsTools } from '../src/tools/fs-tools.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { PathEscapeError } from '../src/tools/workspace.js'

/**
 * Day15 故障注入 + 跨工具集成测试。每个用例都在系统临时目录下开一块独立地盘，
 * 不共用 tests/fixtures/workspace（那份是只读工具的静态签入 fixture，这里的用例
 * 需要真的建 symlink、真的改权限、真的写盘）。
 */
const tempDirs: string[] = []
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mini-harness-fs-integration-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true })
})

function registryFor(root: string): { read: ToolRegistry; edit: ToolRegistry } {
  const read = new ToolRegistry()
  for (const tool of createReadOnlyFsTools(root)) read.define(tool)
  const edit = new ToolRegistry()
  edit.define(createEditFileTool(root))
  return { read, edit }
}

function ctx(root: string) {
  return { signal: new AbortController().signal, cwd: root }
}

describe('symlink escape', () => {
  it('read_file refuses to follow a symlink that points outside the workspace', async () => {
    const outside = tempWorkspace()
    writeFileSync(join(outside, 'secret.txt'), 'top secret\n', 'utf8')

    const root = tempWorkspace()
    symlinkSync(join(outside, 'secret.txt'), join(root, 'looks-local.txt'))

    const { read } = registryFor(root)
    await expect(read.execute('read_file', { file_path: 'looks-local.txt' }, ctx(root))).rejects.toThrow(
      PathEscapeError,
    )
  })

  it('edit_file refuses to write through a symlinked directory that points outside the workspace', async () => {
    const outside = tempWorkspace()
    mkdirSync(join(outside, 'target-dir'))

    const root = tempWorkspace()
    symlinkSync(join(outside, 'target-dir'), join(root, 'looks-local-dir'))

    const { edit } = registryFor(root)
    await expect(
      edit.execute('edit_file', { file_path: 'looks-local-dir/new.txt', content: 'x' }, ctx(root)),
    ).rejects.toThrow(PathEscapeError)
  })

  it('a symlink that stays inside the workspace is fine', async () => {
    const root = tempWorkspace()
    mkdirSync(join(root, 'real-dir'))
    writeFileSync(join(root, 'real-dir', 'a.txt'), 'inside\n', 'utf8')
    symlinkSync(join(root, 'real-dir'), join(root, 'alias-dir'))

    const { read } = registryFor(root)
    const result = await read.execute('read_file', { file_path: 'alias-dir/a.txt' }, ctx(root))
    expect((result.value as { lines: string[] }).lines).toEqual(['inside', ''])
  })
})

describe('oversized and binary files', () => {
  it('read_file rejects a file larger than the size limit instead of reading it all into memory', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'huge.txt'), 'x'.repeat(3 * 1024 * 1024), 'utf8') // 3MB > 2MB 上限
    const { read } = registryFor(root)
    await expect(read.execute('read_file', { file_path: 'huge.txt' }, ctx(root))).rejects.toThrow(/exceeds/)
  })

  it('read_file rejects a binary file instead of returning garbled text', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]))
    const { read } = registryFor(root)
    await expect(read.execute('read_file', { file_path: 'image.bin' }, ctx(root))).rejects.toThrow(/binary/)
  })
})

describe('permission failure', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

  it.skipIf(isRoot)('edit_file reports a clear error instead of an uncaught exception when the directory is read-only', async () => {
    const root = tempWorkspace()
    const readonlyDir = join(root, 'locked')
    mkdirSync(readonlyDir)
    chmodSync(readonlyDir, 0o555) // r-xr-xr-x：目录本身不允许新建文件
    try {
      const { edit } = registryFor(root)
      await expect(
        edit.execute('edit_file', { file_path: 'locked/new.txt', content: 'x' }, ctx(root)),
      ).rejects.toThrow(/cannot write/)
    } finally {
      chmodSync(readonlyDir, 0o755) // 改回可写，afterEach 的 rmSync 才能真正删掉这个目录
    }
  })
})

describe('cross-tool integration: read_file → edit_file → read_file (hash handoff)', () => {
  it('the hash returned by read_file is exactly what a following edit_file call needs, and rotates after a successful edit', async () => {
    const root = tempWorkspace()
    writeFileSync(join(root, 'doc.md'), 'v1\n', 'utf8')
    const { read, edit } = registryFor(root)

    const firstRead = (await read.execute('read_file', { file_path: 'doc.md' }, ctx(root))).value as {
      contentHash: string
    }

    const editResult = (
      await edit.execute(
        'edit_file',
        { file_path: 'doc.md', content: 'v2\n', expectedHash: firstRead.contentHash },
        ctx(root),
      )
    ).value as { applied: boolean; newHash: string }
    expect(editResult.applied).toBe(true)

    const secondRead = (await read.execute('read_file', { file_path: 'doc.md' }, ctx(root))).value as {
      contentHash: string
      lines: string[]
    }
    expect(secondRead.lines).toEqual(['v2', ''])
    expect(secondRead.contentHash).toBe(editResult.newHash)
    expect(secondRead.contentHash).not.toBe(firstRead.contentHash)

    // 用第一次读到的旧 hash 再编辑一次——必须被拒绝：hash 已经因为上一次成功编辑转了一轮，
    // 不是"只测一遍两个工具各自都对"，而是真的把 hash 在两次调用之间传递、复用、验证。
    await expect(
      edit.execute('edit_file', { file_path: 'doc.md', content: 'v3\n', expectedHash: firstRead.contentHash }, ctx(root)),
    ).rejects.toThrow(/has changed since you last read it/)
  })
})
