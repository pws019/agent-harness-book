import type { SessionEvent } from './session.js'

/**
 * "假磁盘"——真实场景下 `appendLine`/`readLines` 会去操作一个真实文件，MiniHarness 里
 * 用一个可注入的接口，测试用内存实现，方便直接构造"半行 JSON""磁盘写失败"这类故障，
 * 不需要真的碰文件系统。
 */
export interface RawStore {
  /** 追加一行原始文本（不含末尾换行符）。允许抛异常，模拟一次磁盘写失败。 */
  appendLine(line: string): void
  /** 读出目前为止写入的所有原始行，按写入顺序。 */
  readLines(): readonly string[]
}

/** 内存实现：`corruptLine` 是刻意留的"改坏某一行"接口，用来在测试里模拟磁盘损坏/写到一半。 */
export class InMemoryRawStore implements RawStore {
  private readonly lines: string[] = []

  appendLine(line: string): void {
    this.lines.push(line)
  }

  readLines(): readonly string[] {
    return [...this.lines]
  }

  /** 把第 `index` 行（从0开始）替换成任意文本，模拟这一行在磁盘上已经损坏或者只写了一半。 */
  corruptLine(index: number, text: string): void {
    if (index < 0 || index >= this.lines.length) {
      throw new RangeError(`no line at index ${index}`)
    }
    this.lines[index] = text
  }
}

export const SESSION_FORMAT_VERSION = 1

export interface SessionHeader {
  readonly formatVersion: number
  readonly createdAt: number
}

export class SessionLoadError extends Error {}

interface HeaderLine {
  readonly kind: 'header'
  readonly header: SessionHeader
}

interface EventLine {
  readonly kind: 'event'
  readonly event: SessionEvent
}

/**
 * 把 Session 的事件日志逐行写成 JSONL：第一行是 header，后面每行是一条事件。
 *
 * 崩溃恢复语义（`load()`）：
 * - 最后一行解析失败——判定为"写到一半进程被杀"，丢弃这一行，用之前所有完整行加载，
 *   `truncated: true` 告诉调用方"这次是从一次中断恢复的，不是干净关闭的"。
 * - 中间某一行解析失败——判定整份日志损坏，直接拒绝加载，不做"尽量抢救"，因为中间
 *   缺一行会让后面所有 seq 对不上、tool/call 和 tool/result 配对可能因此错位，没有
 *   办法安全地跳过它继续读。
 * - header 的 `formatVersion` 跟当前代码不匹配——拒绝加载，不尝试"兼容性硬解析"。
 */
export class JsonlSessionStore {
  private constructor(private readonly raw: RawStore) {}

  /** 初始化一个全新的空 session：写入 header 作为第一行。 */
  static create(raw: RawStore, options: { readonly clock?: () => number } = {}): JsonlSessionStore {
    const header: SessionHeader = { formatVersion: SESSION_FORMAT_VERSION, createdAt: (options.clock ?? Date.now)() }
    const line: HeaderLine = { kind: 'header', header }
    raw.appendLine(JSON.stringify(line))
    return new JsonlSessionStore(raw)
  }

  /** 打开一个已经写过 header 的既有 store（比如恢复流程里，先 load() 校验完再继续写）。 */
  static open(raw: RawStore): JsonlSessionStore {
    return new JsonlSessionStore(raw)
  }

  append(event: SessionEvent): void {
    const line: EventLine = { kind: 'event', event }
    this.raw.appendLine(JSON.stringify(line))
  }

  load(): { readonly header: SessionHeader; readonly events: readonly SessionEvent[]; readonly truncated: boolean } {
    const lines = this.raw.readLines()
    if (lines.length === 0) {
      throw new SessionLoadError('empty store: no header line')
    }

    const header = parseHeaderLine(lines[0]!)
    if (header.formatVersion !== SESSION_FORMAT_VERSION) {
      throw new SessionLoadError(
        `unsupported session format version ${header.formatVersion} (this build only reads version ${SESSION_FORMAT_VERSION})`,
      )
    }

    const events: SessionEvent[] = []
    let truncated = false
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!
      const isLastLine = i === lines.length - 1
      let parsed: EventLine
      try {
        parsed = JSON.parse(line) as EventLine
      } catch (error) {
        if (isLastLine) {
          truncated = true
          break
        }
        throw new SessionLoadError(`corrupted event at line ${i + 1}: ${(error as Error).message}`)
      }
      events.push(parsed.event)
    }
    return { header, events, truncated }
  }
}

function parseHeaderLine(line: string): SessionHeader {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (error) {
    throw new SessionLoadError(`corrupted header line: ${(error as Error).message}`)
  }
  const record = parsed as Partial<HeaderLine>
  if (record.kind !== 'header' || !record.header) {
    throw new SessionLoadError('first line is not a valid session header')
  }
  return record.header
}
