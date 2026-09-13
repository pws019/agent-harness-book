import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { contentHash, ensureNotBinaryOrThrow, simpleDiff, writeFileAtomic } from './file-io.js'
import { ToolExecutionError, type ToolDefinition } from './types.js'
import { resolveWithinRoot } from './workspace.js'

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.turbo'])
const MAX_LIST_ENTRIES = 200
const MAX_SEARCH_MATCHES = 50
const MAX_SEARCH_FILE_BYTES = 512 * 1024
/** `read_file`/`edit_file` 共用的整份文件大小上限——比 search_text 的逐文件跳过阈值更宽，
 * 因为这两个工具是模型主动挑中的单个目标文件，不是"顺手扫过去"。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024

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
  /** 当前磁盘内容的 sha256——`edit_file` 的 `expectedHash` 就是从这里抄回去的，见 Day15 study.md。 */
  readonly contentHash: string
}

export function createReadFileTool(root: string): ToolDefinition<ReadFileValue> {
  return {
    name: 'read_file',
    description:
      'Read a text file inside the workspace and return its content with line numbers. Defaults to the first 200 lines. The returned contentHash can be passed as edit_file\'s expectedHash.',
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
        required: ['path', 'startLine', 'endLine', 'totalLines', 'lines', 'contentHash'],
        properties: {
          path: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          totalLines: { type: 'integer' },
          lines: { type: 'array', items: { type: 'string' } },
          contentHash: { type: 'string' },
        },
      },
      render(_args, value) {
        const body = value.lines.map((line, i) => `${value.startLine + i}\t${line}`).join('\n')
        return `${value.path} (lines ${value.startLine}-${value.endLine} of ${value.totalLines} total, contentHash: ${value.contentHash}):\n${body}`
      },
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true,
    async execute(rawArgs) {
      const args = rawArgs as ReadFileArgs
      const target = resolveWithinRoot(root, args.file_path)
      let buffer: Buffer
      try {
        buffer = await readFile(target)
      } catch (error) {
        throw new ToolExecutionError(`cannot read "${args.file_path}": ${(error as Error).message}`)
      }
      if (buffer.byteLength > MAX_FILE_BYTES) {
        throw new ToolExecutionError(
          `refusing to read "${args.file_path}": ${buffer.byteLength} bytes exceeds the ${MAX_FILE_BYTES}-byte limit`,
        )
      }
      ensureNotBinaryOrThrow(buffer, args.file_path)
      const raw = buffer.toString('utf8')
      const allLines = raw.split('\n')
      const offset = Math.max(1, Math.floor(args.offset ?? 1))
      const limit = Math.max(1, Math.floor(args.limit ?? 200))
      const startLine = Math.min(offset, allLines.length + 1)
      const endLine = Math.min(startLine + limit - 1, allLines.length)
      const lines = startLine > endLine ? [] : allLines.slice(startLine - 1, endLine)
      return { path: args.file_path, startLine, endLine, totalLines: allLines.length, lines, contentHash: contentHash(raw) }
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
          // 已知缺口：跟下面 matches/totalMatches 的截断不一样，这里跳过文件是完全静默的——
          // totalMatches 根本不知道这个文件里本来有多少匹配，调用方也没法区分"真的没匹配"
          // 和"这个文件被跳过了，可能有匹配"。要修的话得给 SearchTextValue 加一个
          // skippedFiles 计数，并在 render() 里透出，目前还没做。
          if (buffer.byteLength > MAX_SEARCH_FILE_BYTES) continue // skip oversized/binary-ish files
          content = buffer.toString('utf8')
        } catch {
          continue // 读取失败（权限问题、编码错误等）——跟上面同样的静默跳过缺口
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

// ---------------------------------------------------------------------------
// edit_file: Day15 第一个写工具。一个深接口同时覆盖"新建"、"整份覆盖"、"预览不落盘"
// 三种意图，靠 expectedHash + dryRun 两个参数区分，而不是拆成三个各管一段的浅工具。
// ---------------------------------------------------------------------------

interface EditFileArgs {
  readonly file_path: string
  /** 目标文件应有的完整内容——不是 diff/patch，调用方（模型）负责给出改完之后的全文。 */
  readonly content: string
  /** 文件已存在时必须提供，且必须等于最近一次 read_file 返回的 contentHash，否则拒绝覆盖。 */
  readonly expectedHash?: string
  /** true 时只返回预览 diff，不写盘、不改变磁盘上的任何内容。 */
  readonly dryRun?: boolean
}

interface EditFileValue {
  readonly path: string
  readonly dryRun: boolean
  /** dryRun 或者被拒绝时是 false——只有真的写盘成功才是 true。 */
  readonly applied: boolean
  readonly diff: string
  /** 编辑前磁盘上的内容 hash；文件原本不存在时是 null。 */
  readonly previousHash: string | null
  /** 写盘之后的新内容 hash；dryRun 或者失败时是 null。 */
  readonly newHash: string | null
}

export function createEditFileTool(root: string): ToolDefinition<EditFileValue> {
  return {
    name: 'edit_file',
    description:
      'Create or overwrite a text file with full new content. Editing an existing file requires expectedHash from a prior read_file call — a mismatch means the file changed since you last read it, and the edit is rejected rather than silently overwriting. Set dryRun to preview a diff without writing.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_path', 'content'],
      properties: {
        file_path: { type: 'string', description: 'Path relative to the workspace root.' },
        content: { type: 'string', description: 'The full desired content of the file after this edit.' },
        expectedHash: {
          type: 'string',
          description: "The file's contentHash as last seen via read_file. Required when the file already exists.",
        },
        dryRun: { type: 'boolean', description: 'If true, only return a preview diff; do not write to disk.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'dryRun', 'applied', 'diff', 'previousHash', 'newHash'],
        properties: {
          path: { type: 'string' },
          dryRun: { type: 'boolean' },
          applied: { type: 'boolean' },
          diff: { type: 'string' },
          previousHash: { type: 'string', description: 'null when the file did not previously exist' },
          newHash: { type: 'string', description: 'null when dryRun or the edit was rejected' },
        },
      },
      render(_args, value) {
        const header = value.applied
          ? `wrote ${value.path} (newHash: ${value.newHash})`
          : `dry run for ${value.path} (no changes written)`
        return `${header}\n${value.diff}`
      },
    },
    timeoutMs: 5_000,
    // 写操作不可以跟任何兄弟调用并发执行——目前 registry/agent-loop 还没有真正读取
    // isConcurrencySafe() 去做并发调度（这个字段从 Day4 定义到现在都没有消费者），
    // 但语义上该怎么标就怎么标，等调度器接上的那天不用回头再改。
    isConcurrencySafe: () => false,
    async execute(rawArgs) {
      const args = rawArgs as EditFileArgs
      const target = resolveWithinRoot(root, args.file_path)
      const dryRun = args.dryRun ?? false

      let previousContent: string | null = null
      let previousHash: string | null = null
      try {
        const buffer = await readFile(target)
        if (buffer.byteLength > MAX_FILE_BYTES) {
          throw new ToolExecutionError(
            `refusing to edit "${args.file_path}": existing file is ${buffer.byteLength} bytes, exceeding the ${MAX_FILE_BYTES}-byte limit`,
          )
        }
        ensureNotBinaryOrThrow(buffer, args.file_path)
        previousContent = buffer.toString('utf8')
        previousHash = contentHash(previousContent)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        // 文件不存在——把它当成"从空内容开始编辑"，previousContent/previousHash 保持 null。
      }

      if (previousContent === null) {
        if (args.expectedHash !== undefined) {
          throw new ToolExecutionError(
            `"${args.file_path}" does not exist yet; omit expectedHash to create it (do not guess a hash for a file you haven't read)`,
          )
        }
      } else if (args.expectedHash === undefined) {
        throw new ToolExecutionError(
          `"${args.file_path}" already exists; call read_file first and pass its contentHash as expectedHash before editing`,
        )
      } else if (args.expectedHash !== previousHash) {
        throw new ToolExecutionError(
          `"${args.file_path}" has changed since you last read it (expected ${args.expectedHash}, found ${previousHash}); re-read before editing`,
        )
      }

      const newBuffer = Buffer.from(args.content, 'utf8')
      if (newBuffer.byteLength > MAX_FILE_BYTES) {
        throw new ToolExecutionError(
          `refusing to write "${args.file_path}": new content is ${newBuffer.byteLength} bytes, exceeding the ${MAX_FILE_BYTES}-byte limit`,
        )
      }
      ensureNotBinaryOrThrow(newBuffer, `${args.file_path} (new content)`)

      const diff = simpleDiff(previousContent ?? '', args.content)

      if (dryRun) {
        return { path: args.file_path, dryRun: true, applied: false, diff, previousHash, newHash: null }
      }

      try {
        writeFileAtomic(target, args.content)
      } catch (error) {
        throw new ToolExecutionError(`cannot write "${args.file_path}": ${(error as Error).message}`)
      }
      return { path: args.file_path, dryRun: false, applied: true, diff, previousHash, newHash: contentHash(args.content) }
    },
  }
}
