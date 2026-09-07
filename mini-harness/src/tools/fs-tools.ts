import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { ToolExecutionError, type ToolDefinition } from './types.js'
import { resolveWithinRoot } from './workspace.js'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.turbo'])
const MAX_LIST_ENTRIES = 200
const MAX_SEARCH_MATCHES = 50
const MAX_SEARCH_FILE_BYTES = 512 * 1024

// ---------------------------------------------------------------------------
// read_file: 深工具的示范——一次调用完成"打开+定位+读取"，模型只给意图层面的参数。
// ---------------------------------------------------------------------------

interface ReadFileArgs {
  readonly file_path: string
  readonly offset?: number
  readonly limit?: number
}

interface ReadFileValue {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly totalLines: number
  readonly lines: readonly string[]
}

export function createReadFileTool(root: string): ToolDefinition<ReadFileValue> {
  return {
    name: 'read_file',
    description:
      'Read a text file inside the workspace and return its content with line numbers. Defaults to the first 200 lines.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
      properties: {
        file_path: { type: 'string', description: 'Path relative to the workspace root.' },
        offset: { type: 'integer', description: '1-based first line to return. Defaults to 1.' },
        limit: { type: 'integer', description: 'Maximum number of lines to return. Defaults to 200.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'startLine', 'endLine', 'totalLines', 'lines'],
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          totalLines: { type: 'integer' },
          lines: { type: 'array', items: { type: 'string' } },
        },
      },
      render(_args, value) {
        const body = value.lines.map((line, i) => `${value.startLine + i}\t${line}`).join('\n')
        return `${value.path} (lines ${value.startLine}-${value.endLine} of ${value.totalLines} total):\n${body}`
      },
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    async execute(rawArgs) {
      const args = rawArgs as ReadFileArgs
      const target = resolveWithinRoot(root, args.file_path)
      let raw: string
      try {
        raw = await readFile(target, 'utf8')
      } catch (error) {
        throw new ToolExecutionError(`cannot read "${args.file_path}": ${(error as Error).message}`)
      }
      const allLines = raw.split('\n')
      const offset = Math.max(1, Math.floor(args.offset ?? 1))
      const limit = Math.max(1, Math.floor(args.limit ?? 200))
      const startLine = Math.min(offset, allLines.length + 1)
      const endLine = Math.min(startLine + limit - 1, allLines.length)
      const lines = startLine > endLine ? [] : allLines.slice(startLine - 1, endLine)
      return { path: args.file_path, startLine, endLine, totalLines: allLines.length, lines }
    },
  }
}

// ---------------------------------------------------------------------------
// list_files: 列出目录内容，带输出上限保护。
// ---------------------------------------------------------------------------

interface ListFilesArgs {
  readonly path?: string
}

interface ListFilesEntry {
  readonly name: string
  readonly type: 'file' | 'dir'
}

interface ListFilesValue {
  readonly path: string
  readonly entries: readonly ListFilesEntry[]
  readonly truncated: boolean
}

export function createListFilesTool(root: string): ToolDefinition<ListFilesValue> {
  return {
    name: 'list_files',
    description: `List immediate entries of a directory inside the workspace. Caps output at ${MAX_LIST_ENTRIES} entries.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace root. Defaults to root.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'entries', 'truncated'],
        properties: {
          path: { type: 'string' },
          entries: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          truncated: { type: 'boolean' },
        },
      },
      render(_args, value) {
        const lines = value.entries.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name))
        const suffix = value.truncated ? `\n... truncated at ${MAX_LIST_ENTRIES} entries` : ''
        return `${value.path || '.'}:\n${lines.join('\n')}${suffix}`
      },
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    async execute(rawArgs) {
      const args = rawArgs as ListFilesArgs
      const relPath = args.path ?? ''
      const target = resolveWithinRoot(root, relPath)
      let dirents
      try {
        dirents = await readdir(target, { withFileTypes: true })
      } catch (error) {
        throw new ToolExecutionError(`cannot list "${relPath}": ${(error as Error).message}`)
      }
      const sorted = dirents
        .filter((d) => !SKIP_DIRS.has(d.name))
        .map((d): ListFilesEntry => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const truncated = sorted.length > MAX_LIST_ENTRIES
      return { path: relPath, entries: sorted.slice(0, MAX_LIST_ENTRIES), truncated }
    },
  }
}

// ---------------------------------------------------------------------------
// search_text: 递归文本搜索（grep 的极简版），永远不静默丢弃超限结果。
// ---------------------------------------------------------------------------

interface SearchTextArgs {
  readonly query: string
  readonly path?: string
}

interface SearchMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

interface SearchTextValue {
  readonly query: string
  readonly matches: readonly SearchMatch[]
  readonly totalMatches: number
  readonly truncated: boolean
}

async function* walk(root: string, dir: string): AsyncGenerator<string> {
  const absoluteDir = join(root, dir)
  let dirents
  try {
    dirents = await readdir(absoluteDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const dirent of dirents) {
    if (SKIP_DIRS.has(dirent.name)) continue
    const childRel = join(dir, dirent.name)
    if (dirent.isDirectory()) {
      yield* walk(root, childRel)
    } else if (dirent.isFile()) {
      yield childRel
    }
  }
}

export function createSearchTextTool(root: string): ToolDefinition<SearchTextValue> {
  return {
    name: 'search_text',
    description: `Search for a plain-text substring across files in the workspace. Caps output at ${MAX_SEARCH_MATCHES} matches; reports how many more exist instead of dropping them silently.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Plain substring to search for (not a regex).' },
        path: { type: 'string', description: 'Subdirectory to search within, relative to the workspace root.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'matches', 'totalMatches', 'truncated'],
        properties: {
          query: { type: 'string' },
          matches: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          totalMatches: { type: 'integer' },
          truncated: { type: 'boolean' },
        },
      },
      render(_args, value) {
        if (value.matches.length === 0) return `no matches for "${value.query}"`
        const lines = value.matches.map((m) => `${m.path}:${m.line}: ${m.text}`)
        const suffix = value.truncated
          ? `\n... showing ${value.matches.length} of ${value.totalMatches} matches, truncated`
          : ''
        return lines.join('\n') + suffix
      },
    },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      const args = rawArgs as SearchTextArgs
      const startRel = args.path ?? ''
      resolveWithinRoot(root, startRel) // throws on escape before we even start walking

      const matches: SearchMatch[] = []
      let totalMatches = 0
      for await (const relPath of walk(root, startRel)) {
        if (exec.signal.aborted) throw new ToolExecutionError('search aborted')
        const absolutePath = join(root, relPath)
        let content: string
        try {
          const buffer = await readFile(absolutePath)
          if (buffer.byteLength > MAX_SEARCH_FILE_BYTES) continue // skip oversized/binary-ish files
          content = buffer.toString('utf8')
        } catch {
          continue
        }
        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.includes(args.query)) {
            totalMatches += 1
            if (matches.length < MAX_SEARCH_MATCHES) {
              matches.push({ path: relative(root, absolutePath), line: i + 1, text: lines[i]!.trim() })
            }
          }
        }
      }
      return { query: args.query, matches, totalMatches, truncated: totalMatches > matches.length }
    },
  }
}

export function createReadOnlyFsTools(root: string): readonly ToolDefinition<unknown>[] {
  return [
    createReadFileTool(root) as ToolDefinition<unknown>,
    createListFilesTool(root) as ToolDefinition<unknown>,
    createSearchTextTool(root) as ToolDefinition<unknown>,
  ]
}
