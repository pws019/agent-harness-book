import { describe, expect, it } from 'vitest'
import { deriveMessages, isJsonValue, Session, SessionAppendError } from '../src/core/session.js'
import type { Message } from '../src/llm/types.js'

function userText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

function assistantToolCall(id: string, name: string, args: unknown): Message {
  return { role: 'assistant', blocks: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] }
}

describe('isJsonValue', () => {
  it('accepts null, primitives, and arbitrarily nested plain objects/arrays', () => {
    expect(isJsonValue(null)).toBe(true)
    expect(isJsonValue('x')).toBe(true)
    expect(isJsonValue(true)).toBe(true)
    expect(isJsonValue(0)).toBe(true)
    expect(isJsonValue([1, 'a', { b: [null, { c: 2 }] }])).toBe(true)
  })

  it('rejects undefined, NaN/Infinity, functions, symbols, bigint, and class instances', () => {
    expect(isJsonValue(undefined)).toBe(false)
    expect(isJsonValue(Number.NaN)).toBe(false)
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false)
    expect(isJsonValue(() => {})).toBe(false)
    expect(isJsonValue(Symbol('x'))).toBe(false)
    expect(isJsonValue(10n)).toBe(false)
    expect(isJsonValue(new Map())).toBe(false)
    expect(isJsonValue(new Date())).toBe(false)
  })

  it('rejects a nested violation, not just a top-level one', () => {
    expect(isJsonValue({ ok: 'fine', nested: { bad: undefined } })).toBe(false)
    expect(isJsonValue([1, 2, () => {}])).toBe(false)
  })
})

describe('Session.append: seq/time bookkeeping', () => {
  it('assigns contiguous seq starting at 0 and calls the injected clock', () => {
    let now = 1000
    const session = new Session({ clock: () => now })
    const e0 = session.append('turn/start', { turn: 1 })
    now = 1001
    const e1 = session.append('user/message', { turn: 1, message: userText('hi') })
    expect(e0.seq).toBe(0)
    expect(e1.seq).toBe(1)
    expect(e0.time).toBe(1000)
    expect(e1.time).toBe(1001)
    expect(session.events).toHaveLength(2)
  })

  it('rejects a payload that is not lossless JSON, before writing anything', () => {
    const session = new Session()
    expect(() =>
      session.append('tool/result', {
        turn: 1,
        step: 1,
        callId: 'c1',
        content: 'x',
        // @ts-expect-error deliberately invalid for the test
        isError: undefined,
      }),
    ).toThrow(SessionAppendError)
    expect(session.events).toHaveLength(0)
  })
})

describe('Session.append: turn/step/tool-call pairing invariants', () => {
  it('rejects turn/end that does not match the currently open turn', () => {
    const session = new Session()
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).toThrow(SessionAppendError)
  })

  it('rejects a second turn/start while one is already open', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    expect(() => session.append('turn/start', { turn: 2 })).toThrow(SessionAppendError)
  })

  it('rejects step/start outside any open turn, and step/start for the wrong turn', () => {
    const session = new Session()
    expect(() => session.append('step/start', { turn: 1, step: 1 })).toThrow(SessionAppendError)
    session.append('turn/start', { turn: 1 })
    expect(() => session.append('step/start', { turn: 2, step: 1 })).toThrow(SessionAppendError)
  })

  it('rejects turn/end while a step is still open', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).toThrow(SessionAppendError)
  })

  it('rejects step/end while a tool/call has no matching tool/result yet', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
    expect(() => session.append('step/end', { turn: 1, step: 1 })).toThrow(SessionAppendError)
  })

  it('rejects tool/result whose callId does not match a pending tool/call in this step', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    expect(() =>
      session.append('tool/result', { turn: 1, step: 1, callId: 'ghost', content: 'x', isError: false }),
    ).toThrow(SessionAppendError)
  })

  it('rejects resolving the same callId twice', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, callId: 'c1', content: 'ok', isError: false })
    expect(() =>
      session.append('tool/result', { turn: 1, step: 1, callId: 'c1', content: 'ok again', isError: false }),
    ).toThrow(SessionAppendError)
  })

  it('rejects a duplicate tool/call callId within the same step', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
    expect(() =>
      session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{"x":1}' }),
    ).toThrow(SessionAppendError)
  })

  it('accepts a fully well-formed turn: one step, one tool call, clean close', () => {
    const session = new Session()
    expect(() => {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('user/message', { turn: 1, message: userText('go') })
      session.append('assistant/message', { turn: 1, step: 1, message: assistantToolCall('c1', 'echo', {}) })
      session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
      session.append('tool/result', { turn: 1, step: 1, callId: 'c1', content: 'ok', isError: false })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()
    expect(session.events).toHaveLength(8)
  })
})

describe('deriveMessages', () => {
  it('projects a two-step turn (tool call then completion) into the same shape Agent.history expects', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { turn: 1, message: userText('list src/auth') })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: assistantToolCall('c1', 'list_files', { path: 'src/auth' }),
    })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'list_files', arguments: '{"path":"src/auth"}' })
    session.append('tool/result', { turn: 1, step: 1, callId: 'c1', content: 'index.ts\nmiddleware.ts', isError: false })
    session.append('step/end', { turn: 1, step: 1 })

    session.append('step/start', { turn: 1, step: 2 })
    session.append('assistant/message', { turn: 1, step: 2, message: assistantText('done') })
    session.append('step/end', { turn: 1, step: 2 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const messages = deriveMessages(session.events)
    expect(messages).toEqual([
      userText('list src/auth'),
      assistantToolCall('c1', 'list_files', { path: 'src/auth' }),
      { role: 'tool', blocks: [{ type: 'tool-result', toolCallId: 'c1', content: 'index.ts\nmiddleware.ts', isError: false }] },
      assistantText('done'),
    ])
  })

  it('batches multiple tool/result events in the same step into one tool message, not one per result', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        blocks: [
          { type: 'tool-call', id: 'c1', name: 'echo', arguments: '{}' },
          { type: 'tool-call', id: 'c2', name: 'echo', arguments: '{}' },
        ],
      },
    })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'echo', arguments: '{}' })
    session.append('tool/result', { turn: 1, step: 1, callId: 'c1', content: 'a', isError: false })
    session.append('tool/result', { turn: 1, step: 1, callId: 'c2', content: 'b', isError: false })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const messages = deriveMessages(session.events)
    const toolMessages = messages.filter((m) => m.role === 'tool')
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.blocks).toHaveLength(2)
  })

  it('is a pure function: replaying the same log twice yields deeply equal results', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { turn: 1, message: userText('hi') })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantText('hello') })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const first = deriveMessages(session.events)
    const second = deriveMessages(session.events)
    expect(first).toEqual(second)
    expect(first).not.toBe(second) // pure function, not a cached/shared reference
  })

  it('ignores boundary and tool/call events entirely -- only surface events become messages', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { turn: 1, message: userText('hi') })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'cancelled' } })

    expect(deriveMessages(session.events)).toEqual([userText('hi')])
  })
})
