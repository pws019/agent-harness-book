import { describe, expect, it } from 'vitest'
import { Session } from '../src/core/session.js'
import { InMemorySpillStore, spillLargeToolResults } from '../src/core/spill.js'
import type { Message } from '../src/llm/types.js'

function userText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

describe('InMemorySpillStore', () => {
  it('put/get round-trips content by id, and unknown ids return undefined', () => {
    const store = new InMemorySpillStore()
    const id = store.put('a very long tool output')
    expect(store.get(id)).toBe('a very long tool output')
    expect(store.get('nonexistent')).toBeUndefined()
  })

  it('gives every put() call a distinct id, even for identical content', () => {
    const store = new InMemorySpillStore()
    const id1 = store.put('same content')
    const id2 = store.put('same content')
    expect(id1).not.toBe(id2)
  })
})

describe('spillLargeToolResults', () => {
  function buildEvents(shortContent: string, longContent: string) {
    const session = new Session()
    session.append('turn/start', { turn: 0 })
    session.append('user/message', { turn: 0, message: userText('go') })
    session.append('step/start', { turn: 0, step: 1 })
    session.append('tool/call', { turn: 0, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
    session.append('tool/result', { turn: 0, step: 1, callId: 'c1', content: shortContent, isError: false })
    session.append('tool/call', { turn: 0, step: 1, callId: 'c2', name: 'search_text', arguments: '{}' })
    session.append('tool/result', { turn: 0, step: 1, callId: 'c2', content: longContent, isError: false })
    session.append('step/end', { turn: 0, step: 1 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    return session.events
  }

  it('leaves content at or under the threshold untouched, replaces content over it with a placeholder', () => {
    const longContent = 'x'.repeat(500)
    const events = buildEvents('short', longContent)
    const store = new InMemorySpillStore()

    const spilled = spillLargeToolResults(events, store, 100)
    const results = spilled.filter((e) => e.type === 'tool/result') as ReadonlyArray<{
      readonly callId: string
      readonly content: string
    }>

    expect(results.find((r) => r.callId === 'c1')!.content).toBe('short') // 没超阈值，原样不动
    const spilledResult = results.find((r) => r.callId === 'c2')!
    expect(spilledResult.content).not.toBe(longContent)
    expect(spilledResult.content).toContain('500 chars')
  })

  it('the full original content can be read back from the store using the id embedded in the placeholder', () => {
    const longContent = 'the real, full tool output that is too big to keep inline'.repeat(10)
    const events = buildEvents('short', longContent)
    const store = new InMemorySpillStore()

    const spilled = spillLargeToolResults(events, store, 50)
    const placeholder = (spilled.find((e) => e.type === 'tool/result' && e.callId === 'c2') as { content: string }).content
    const id = /spilled as "([^"]+)"/.exec(placeholder)?.[1]
    expect(id).toBeDefined()
    expect(store.get(id!)).toBe(longContent)
  })

  it('does not mutate the original events array', () => {
    const events = buildEvents('short', 'y'.repeat(200))
    const store = new InMemorySpillStore()
    const originalContents = events.filter((e) => e.type === 'tool/result').map((e) => (e as { content: string }).content)

    spillLargeToolResults(events, store, 50)

    const stillOriginal = events.filter((e) => e.type === 'tool/result').map((e) => (e as { content: string }).content)
    expect(stillOriginal).toEqual(originalContents)
  })
})
