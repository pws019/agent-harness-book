import { describe, expect, it } from 'vitest'
import { closeDanglingActivity, deriveMessages, isJsonValue, Session, SessionAppendError } from '../src/core/session.js'
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

  it('accepts strictly increasing turn numbers across successive (closed) turns', () => {
    const session = new Session()
    expect(() => {
      session.append('turn/start', { turn: 0 })
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      session.append('turn/start', { turn: 5 }) // 允许跳号，只要求"严格更大"，不要求连续
      session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('rejects reusing a turn number that is less than or equal to a previously used one', () => {
    const session = new Session()
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    expect(() => session.append('turn/start', { turn: 2 })).toThrow(SessionAppendError) // 相等
    expect(() => session.append('turn/start', { turn: 1 })).toThrow(SessionAppendError) // 更小
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

describe('Session.danglingActivity', () => {
  it('is undefined before any turn starts and after a turn cleanly ends', () => {
    const session = new Session()
    expect(session.danglingActivity()).toBeUndefined()
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(session.danglingActivity()).toBeUndefined()
  })

  it('reports the open turn with no step while a turn is open but no step has started', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    expect(session.danglingActivity()).toEqual({ turn: 1, step: undefined, pendingCallIds: [] })
  })

  it('reports the open step and any unresolved callIds', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
    expect(session.danglingActivity()).toEqual({ turn: 1, step: 1, pendingCallIds: ['c1'] })
  })
})

describe('closeDanglingActivity', () => {
  it('does nothing when there is no dangling activity', () => {
    const session = new Session()
    closeDanglingActivity(session, { kind: 'cancelled' })
    expect(session.events).toHaveLength(0)
  })

  it('closes an open turn with no open step by writing just turn/end', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    closeDanglingActivity(session, { kind: 'cancelled' })
    expect(session.events.map((e) => e.type)).toEqual(['turn/start', 'turn/end'])
    expect(session.danglingActivity()).toBeUndefined()
  })

  it('writes a synthetic isError tool/result for every pending call, then step/end, then turn/end', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'echo', arguments: '{}' })

    closeDanglingActivity(session, { kind: 'cancelled' })

    const types = session.events.map((e) => e.type)
    expect(types).toEqual([
      'turn/start',
      'step/start',
      'tool/call',
      'tool/call',
      'tool/result',
      'tool/result',
      'step/end',
      'turn/end',
    ])
    const results = session.events.filter((e) => e.type === 'tool/result') as ReadonlyArray<{
      readonly callId: string
      readonly isError: boolean
    }>
    expect(results.map((r) => r.callId).sort()).toEqual(['c1', 'c2'])
    expect(results.every((r) => r.isError)).toBe(true)
  })
})

describe('Session.restoreFrom', () => {
  it('reproduces the exact same events, preserving original seq/time', () => {
    const original = new Session({ clock: () => 12345 })
    original.append('turn/start', { turn: 1 })
    original.append('user/message', { turn: 1, message: userText('hi') })
    original.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const restored = Session.restoreFrom(original.events)
    expect(restored.events).toEqual(original.events)
  })

  it('correctly recomputes danglingActivity for a log that ends mid-turn (simulated crash)', () => {
    const original = new Session()
    original.append('turn/start', { turn: 1 })
    original.append('step/start', { turn: 1, step: 1 })
    original.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })
    // 进程假装在这里被杀掉：没有 tool/result，没有 step/end，没有 turn/end。

    const restored = Session.restoreFrom(original.events)
    expect(restored.danglingActivity()).toEqual({ turn: 1, step: 1, pendingCallIds: ['c1'] })

    // 恢复之后应该能正常收尾，不会因为"日志末尾没关闭"这件事本身被判定为损坏。
    closeDanglingActivity(restored, { kind: 'cancelled' })
    expect(restored.danglingActivity()).toBeUndefined()
  })

  it('rejects a genuinely inconsistent event list (tool/result for a callId that was never called)', () => {
    const forged = Session.restoreFrom
    // 手工拼一份"看起来像"事件列表、但因果关系不对的日志：直接从 restoreFrom 的合法输入
    // 构造，再塞进一条从未被 tool/call 过的 tool/result。
    const bogusEvents = [
      { type: 'turn/start' as const, seq: 0, time: 0, turn: 1 },
      { type: 'step/start' as const, seq: 1, time: 0, turn: 1, step: 1 },
      { type: 'tool/result' as const, seq: 2, time: 0, turn: 1, step: 1, callId: 'ghost', content: 'x', isError: false },
    ]
    expect(() => forged(bogusEvents)).toThrow()
  })
})

describe('closeDanglingActivity: sink forwarding', () => {
  // 真实踩到的坑：closeDanglingActivity 第一版直接调 session.append()，没有把收尾产生的
  // 事件转发给 sink——内存里的 Session 是对的，但镜像到持久化 store 的那份从最后一条
  // 事件开始就漏掉了。这条测试锁死"传了 sink 就一定会收到收尾事件"这个行为。
  it('forwards every event it writes to the given sink, not just to the session', () => {
    const session = new Session()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'echo', arguments: '{}' })

    const sunk: string[] = []
    closeDanglingActivity(session, { kind: 'cancelled' }, { append: (event) => sunk.push(event.type) })

    expect(sunk).toEqual(['tool/result', 'step/end', 'turn/end'])
  })

  it('forwards nothing when there is no dangling activity to close', () => {
    const session = new Session()
    const sunk: string[] = []
    closeDanglingActivity(session, { kind: 'cancelled' }, { append: (event) => sunk.push(event.type) })
    expect(sunk).toEqual([])
  })
})

describe('Session.append: compaction/* pairing and range validity', () => {
  function seeded(): Session {
    const session = new Session()
    session.append('turn/start', { turn: 0 })
    session.append('user/message', { turn: 0, message: userText('hi') })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    return session // 3 events, seqs 0,1,2
  }

  it('accepts a well-formed compaction/start -> compaction/summary -> compaction/end triple', () => {
    const session = seeded()
    expect(() => {
      session.append('compaction/start', { fromSeq: 0, toSeq: 1 })
      session.append('compaction/summary', { message: assistantText('summary') })
      session.append('compaction/end', {})
    }).not.toThrow()
  })

  it('rejects a range whose toSeq does not exist yet in the log', () => {
    const session = seeded()
    expect(() => session.append('compaction/start', { fromSeq: 0, toSeq: 99 })).toThrow(SessionAppendError)
  })

  it('rejects an inverted range (toSeq before fromSeq)', () => {
    const session = seeded()
    expect(() => session.append('compaction/start', { fromSeq: 2, toSeq: 0 })).toThrow(SessionAppendError)
  })

  it('rejects a second compaction/start while one is already open', () => {
    const session = seeded()
    session.append('compaction/start', { fromSeq: 0, toSeq: 1 })
    expect(() => session.append('compaction/start', { fromSeq: 0, toSeq: 2 })).toThrow(SessionAppendError)
  })

  it('rejects compaction/summary or compaction/end without an open compaction/start', () => {
    const session = seeded()
    expect(() => session.append('compaction/summary', { message: assistantText('x') })).toThrow(SessionAppendError)
    expect(() => session.append('compaction/end', {})).toThrow(SessionAppendError)
  })
})

describe('deriveMessages: compaction replaces the covered range with its summary', () => {
  it('a compacted range collapses into one summary message at its original position', () => {
    const session = new Session()
    session.append('turn/start', { turn: 0 })
    session.append('user/message', { turn: 0, message: userText('old question') }) // seq 1
    session.append('step/start', { turn: 0, step: 1 })
    session.append('assistant/message', { turn: 0, step: 1, message: assistantText('old answer') }) // seq 3
    session.append('step/end', { turn: 0, step: 1 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', { turn: 1, message: userText('recent question') })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    session.append('compaction/start', { fromSeq: 1, toSeq: 3 })
    session.append('compaction/summary', { message: assistantText('summary of turn 0') })
    session.append('compaction/end', {})

    expect(deriveMessages(session.events)).toEqual([assistantText('summary of turn 0'), userText('recent question')])
  })

  it('an unclosed compaction (no compaction/end yet) leaves the original events untouched', () => {
    const session = new Session()
    session.append('turn/start', { turn: 0 })
    session.append('user/message', { turn: 0, message: userText('hi') })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    session.append('compaction/start', { fromSeq: 0, toSeq: 2 })
    session.append('compaction/summary', { message: assistantText('half-done summary') })
    // 没有 compaction/end -- 这次压缩没有真正生效。

    expect(deriveMessages(session.events)).toEqual([userText('hi')])
  })
})
