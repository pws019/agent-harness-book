import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
  /**
   * 只保留前 `count` 行，物理丢弃后面的内容——`JsonlSessionStore.load()` 发现日志被
   * 写到一半（`truncated: true`）时会调用它，把那条没写完、没有结尾换行符的垃圾尾巴
   * 从"磁盘"上真正清掉。这不是可有可无的清理：如果不清掉，下一次 `appendLine()` 会
   * 直接把新的一行接在这条没有换行符结尾的垃圾后面，两条本该独立的行会粘成一行完全
   * 无法解析的乱码——这是我们在写 Day14 集成测试时真实碰到的一个坑，见
   * `modules/day14-milestone-two/README.md`。可选：只有支持物理截断的实现才需要提供，
   * 不提供的话 `load()` 就跳过这一步修复（比如某些只追加、不支持随机写的真实存储后端）。
   */
  truncateTo?(count: number): void
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

  truncateTo(count: number): void {
    this.lines.length = count
  }
}

/**
 * 真实文件版的 `RawStore`——Day7-13 一直只在内存里跑，Day14 的 CLI 第一次需要真的
 * 把一份调查会话存到磁盘上、下次启动时能续上。每次 `appendLine` 都同步写入并 flush
 * （`{flush: true}` 的效果由 `appendFileSync` 本身保证：它是同步系统调用，返回时数据
 * 已经交给了操作系统），不做内存缓冲——今天的目标是"正确优先"，不是"吞吐量优先"，
 * Day9 exercise 任务4 留的那道"flush 时机该放哪层"思考题，在这里可以看到一个具体的
 * （偏保守的）答案。
 */
export class FileRawStore implements RawStore {
  constructor(private readonly path: string) {}

  static exists(path: string): boolean {
    return existsSync(path)
  }

  appendLine(line: string): void {
    appendFileSync(this.path, `${line}\n`, 'utf8')
  }

  readLines(): readonly string[] {
    if (!existsSync(this.path)) return []
    const content = readFileSync(this.path, 'utf8')
    if (content.length === 0) return []
    const lines = content.split('\n')
    // 文件末尾正常会有一个尾随换行符，split 出来会多一个空字符串元素——不是一行"空事件"，
    // 是文件格式的产物，过滤掉。真正的半行损坏（没有换行符结尾）会是非空字符串，不受影响。
    return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
  }

  truncateTo(count: number): void {
    const kept = this.readLines().slice(0, count)
    writeFileSync(this.path, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
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

  /**
   * 加载整份日志。如果检测到最后一行是"写到一半"的（`truncated: true`），会顺手调用
   * `raw.truncateTo?.()` 把这条损坏的尾巴从底层物理清掉——不清掉的话，之后继续
   * `append()` 会把新事件直接接在这条没有换行符结尾的垃圾后面，两条本该独立的行会
   * 粘成一行、后面全部读不出来。见 `RawStore.truncateTo` 的文档注释。
   */
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
    if (truncated) {
      this.raw.truncateTo?.(1 + events.length) // 1 为 header 行
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
