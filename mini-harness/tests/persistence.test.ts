import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileRawStore, InMemoryRawStore, JsonlSessionStore, SESSION_FORMAT_VERSION, SessionLoadError } from '../src/core/persistence.js'
import type { SessionEvent } from '../src/core/session.js'
import { Session } from '../src/core/session.js'
import type { Message } from '../src/llm/types.js'

function userText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

function buildEvents(): readonly SessionEvent[] {
  const session = new Session()
  session.append('turn/start', { turn: 1 })
  session.append('user/message', { turn: 1, message: userText('hi') })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session.events
}

describe('JsonlSessionStore: round trip', () => {
  it('writes a header line first, then one line per event, and loads back exactly what was written', () => {
    const raw = new InMemoryRawStore()
    const store = JsonlSessionStore.create(raw, { clock: () => 1000 })
    const events = buildEvents()
    for (const event of events) store.append(event)

    expect(raw.readLines()).toHaveLength(4) // 1 header + 3 events
    const loaded = store.load()
    expect(loaded.header).toEqual({ formatVersion: SESSION_FORMAT_VERSION, createdAt: 1000 })
    expect(loaded.events).toEqual(events)
    expect(loaded.truncated).toBe(false)
  })

  it('an empty store has no header and refuses to load', () => {
    const raw = new InMemoryRawStore()
    const store = JsonlSessionStore.open(raw)
    expect(() => store.load()).toThrow(SessionLoadError)
  })
})

describe('JsonlSessionStore: crash recovery semantics', () => {
  it('a corrupted LAST line is treated as "process was killed mid-write": dropped, truncated:true, everything before it kept', () => {
    const raw = new InMemoryRawStore()
    const store = JsonlSessionStore.create(raw)
    const events = buildEvents()
    for (const event of events) store.append(event)
    raw.corruptLine(3, '{"kind":"event","event":{"type":"turn/end"') // 模拟这一行只写了一半

    const loaded = store.load()
    expect(loaded.truncated).toBe(true)
    expect(loaded.events).toEqual(events.slice(0, 2)) // 最后一条 turn/end 被丢弃
  })

  it('a corrupted MIDDLE line means the whole log is untrustworthy: load() rejects, does not skip and continue', () => {
    const raw = new InMemoryRawStore()
    const store = JsonlSessionStore.create(raw)
    for (const event of buildEvents()) store.append(event)
    raw.corruptLine(2, '{"kind":"event","broken') // 中间那一行（不是最后一行）损坏

    expect(() => store.load()).toThrow(SessionLoadError)
  })

  it('rejects a header with an unsupported format version instead of trying to parse it anyway', () => {
    const raw = new InMemoryRawStore()
    raw.appendLine(JSON.stringify({ kind: 'header', header: { formatVersion: 999, createdAt: 0 } }))
    const store = JsonlSessionStore.open(raw)
    expect(() => store.load()).toThrow(SessionLoadError)
  })

  it('rejects a first line that is not a valid header, even if it happens to be valid JSON', () => {
    const raw = new InMemoryRawStore()
    raw.appendLine(JSON.stringify({ kind: 'event', event: { type: 'turn/start', seq: 0, time: 0, turn: 1 } }))
    const store = JsonlSessionStore.open(raw)
    expect(() => store.load()).toThrow(SessionLoadError)
  })

  it('a truncated tail is physically repaired by load(), so appending after resume produces a clean, separate line', () => {
    const raw = new InMemoryRawStore()
    const store = JsonlSessionStore.create(raw)
    const events = buildEvents()
    for (const event of events) store.append(event)
    raw.corruptLine(3, '{"kind":"event","event":{"type":"turn/end"') // 写到一半

    expect(raw.readLines()).toHaveLength(4) // header + 3 事件行（含那条损坏的）
    const loaded = store.load()
    expect(loaded.truncated).toBe(true)

    // load() 已经把损坏的尾巴物理丢掉了——底层现在只剩 header + 2 条完整事件。
    expect(raw.readLines()).toHaveLength(3)
    expect(raw.readLines().at(-1)).not.toContain('turn/end')

    // 恢复之后继续 append，不会跟任何垃圾粘在一起，重新 load() 能拿到干净、完整的结果。
    store.append(events[2]!)
    const reloaded = store.load()
    expect(reloaded.truncated).toBe(false)
    expect(reloaded.events).toEqual(events)
  })
})

describe('FileRawStore: the real thing, backed by an actual file on disk', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips through JsonlSessionStore exactly like the in-memory store does', () => {
    dir = mkdtempSync(join(tmpdir(), 'mini-harness-session-'))
    const path = join(dir, 'session.jsonl')
    const raw = new FileRawStore(path)
    const store = JsonlSessionStore.create(raw, { clock: () => 1000 })
    const events = buildEvents()
    for (const event of events) store.append(event)

    const reopened = JsonlSessionStore.open(new FileRawStore(path))
    const loaded = reopened.load()
    expect(loaded.truncated).toBe(false)
    expect(loaded.events).toEqual(events)
  })

  it('readLines() on a file that does not exist yet returns an empty array, not an error', () => {
    dir = mkdtempSync(join(tmpdir(), 'mini-harness-session-'))
    const raw = new FileRawStore(join(dir, 'never-created.jsonl'))
    expect(raw.readLines()).toEqual([])
  })

  it('a real file truncated mid-write (no trailing newline on the last line) is recovered the same way the in-memory fault-injection tests exercise', () => {
    dir = mkdtempSync(join(tmpdir(), 'mini-harness-session-'))
    const path = join(dir, 'session.jsonl')
    const raw = new FileRawStore(path)
    const store = JsonlSessionStore.create(raw)
    const events = buildEvents()
    for (const event of events) store.append(event)

    // 模拟"进程写到一半被杀"：直接在文件末尾追加一段不完整的 JSON，不带结尾换行符。
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"kind":"event","event":{"type":"turn/end"`)

    const loaded = JsonlSessionStore.open(new FileRawStore(path)).load()
    expect(loaded.truncated).toBe(true)
    expect(loaded.events).toEqual(events)
  })
})
