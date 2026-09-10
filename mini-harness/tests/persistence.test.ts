import { describe, expect, it } from 'vitest'
import { InMemoryRawStore, JsonlSessionStore, SESSION_FORMAT_VERSION, SessionLoadError } from '../src/core/persistence.js'
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
})
