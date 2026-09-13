import { describe, expect, it } from 'vitest'
import { deriveTitle, projectSummary, queryEvents } from '../src/core/session-projection.js'
import { Session } from '../src/core/session.js'
import type { Message } from '../src/llm/types.js'

function userText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

describe('projectSummary', () => {
  it('counts turns and tool calls by name, and remembers the last stop reason', () => {
    const session = new Session()
    session.append('turn/start', { turn: 0 })
    session.append('user/message', { turn: 0, message: userText('go') })
    session.append('step/start', { turn: 0, step: 1 })
    session.append('tool/call', { turn: 0, step: 1, callId: 'c1', name: 'list_files', arguments: '{}' })
    session.append('tool/result', { turn: 0, step: 1, callId: 'c1', content: 'ok', isError: false })
    session.append('tool/call', { turn: 0, step: 1, callId: 'c2', name: 'search_text', arguments: '{}' })
    session.append('tool/result', { turn: 0, step: 1, callId: 'c2', content: 'ok', isError: false })
    session.append('step/end', { turn: 0, step: 1 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    session.append('turn/start', { turn: 1 })
    session.append('user/message', { turn: 1, message: userText('again') })
    session.append('turn/end', { turn: 1, reason: { kind: 'cancelled' } })

    expect(projectSummary(session.events)).toEqual({
      turnCount: 2,
      toolCallCount: 2,
      toolCallCountByName: { list_files: 1, search_text: 1 },
      previousStopReason: { kind: 'completed' },
      lastStopReason: { kind: 'cancelled' },
    })
  })

  it('reads as an empty projection on a fresh, empty log', () => {
    expect(projectSummary([])).toEqual({
      turnCount: 0,
      toolCallCount: 0,
      toolCallCountByName: {},
      previousStopReason: undefined,
      lastStopReason: undefined,
    })
  })

  it('previousStopReason surfaces a crash even after the recovery turn completes normally', () => {
    // 真实场景：turn 1 崩溃、closeDanglingActivity 补写 cancelled，紧接着同一次进程调用
    // 里的新 turn 2 正常跑完——这时 lastStopReason 已经是 completed，看不出崩溃过；
    // 只有 previousStopReason（倒数第二个 turn/end）还留着 cancelled 这个痕迹。
    const session = new Session()
    session.append('turn/start', { turn: 0 })
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })

    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'cancelled' } })

    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const summary = projectSummary(session.events)
    expect(summary.lastStopReason).toEqual({ kind: 'completed' })
    expect(summary.previousStopReason).toEqual({ kind: 'cancelled' })
  })

  it('toolCallCount is the unnamed total, independent of how many distinct tool names appear', () => {
    const session = new Session()
    session.append('turn/start', { turn: 0 })
    session.append('step/start', { turn: 0, step: 1 })
    session.append('tool/call', { turn: 0, step: 1, callId: 'c1', name: 'list_files', arguments: '{}' })
    session.append('tool/result', { turn: 0, step: 1, callId: 'c1', content: 'ok', isError: false })
    session.append('tool/call', { turn: 0, step: 1, callId: 'c2', name: 'list_files', arguments: '{}' })
    session.append('tool/result', { turn: 0, step: 1, callId: 'c2', content: 'ok', isError: false })
    session.append('tool/call', { turn: 0, step: 1, callId: 'c3', name: 'search_text', arguments: '{}' })
    session.append('tool/result', { turn: 0, step: 1, callId: 'c3', content: 'ok', isError: false })

    const summary = projectSummary(session.events)
    expect(summary.toolCallCount).toBe(3) // 总数不分名字
    expect(summary.toolCallCountByName).toEqual({ list_files: 2, search_text: 1 }) // 按名字拆开还是两个
  })
})

describe('queryEvents', () => {
  it('returns only events with seq strictly greater than afterSeq', () => {
    const session = new Session()
    session.append('turn/start', { turn: 0 }) // seq 0
    session.append('user/message', { turn: 0, message: userText('a') }) // seq 1
    session.append('turn/end', { turn: 0, reason: { kind: 'completed' } }) // seq 2

    expect(queryEvents(session.events, { afterSeq: 0 }).map((e) => e.seq)).toEqual([1, 2])
    expect(queryEvents(session.events).map((e) => e.seq)).toEqual([0, 1, 2]) // 不给 afterSeq 等价于从头
  })

  it('limit caps the page size without affecting which events come first', () => {
    const session = new Session()
    session.append('turn/start', { turn: 0 })
    for (let i = 0; i < 4; i++) session.append('user/message', { turn: 0, message: userText(`msg ${i}`) })

    const page1 = queryEvents(session.events, { limit: 2 })
    expect(page1.map((e) => e.seq)).toEqual([0, 1])

    const page2 = queryEvents(session.events, { afterSeq: page1[page1.length - 1]!.seq, limit: 2 })
    expect(page2.map((e) => e.seq)).toEqual([2, 3])
  })
})

describe('deriveTitle', () => {
  it('picks the first user/message text as the title and records its seq', () => {
    const session = new Session()
    session.append('turn/start', { turn: 0 })
    session.append('user/message', { turn: 0, message: userText('investigate the auth module') })
    session.append('assistant/message', { turn: 0, step: 1, message: assistantText('ok') })

    expect(deriveTitle(session.events)).toEqual({ title: 'investigate the auth module', sourceSeq: 1 })
  })

  it('truncates a long first message and appends an ellipsis', () => {
    const session = new Session()
    const longText = 'x'.repeat(100)
    session.append('turn/start', { turn: 0 })
    session.append('user/message', { turn: 0, message: userText(longText) })

    const title = deriveTitle(session.events, { maxLength: 10 })
    expect(title?.title).toBe(`${'x'.repeat(9)}…`)
    expect(title?.title.length).toBe(10)
  })

  it('returns undefined when there is no user/message at all', () => {
    const session = new Session()
    expect(deriveTitle(session.events)).toBeUndefined()
  })
})
