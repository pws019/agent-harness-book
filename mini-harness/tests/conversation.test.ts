import { describe, expect, it } from 'vitest'
import { Conversation } from '../src/client/conversation.js'
import type { SessionEvent } from '../src/core/session.js'

function turnStart(seq: number): SessionEvent {
  return { type: 'turn/start', seq, time: 0, turn: 0 }
}
function userMessage(seq: number, text: string): SessionEvent {
  return { type: 'user/message', seq, time: 0, turn: 0, message: { role: 'user', blocks: [{ type: 'text', text }] } }
}
function turnEnd(seq: number): SessionEvent {
  return { type: 'turn/end', seq, time: 0, turn: 0, reason: { kind: 'completed' } }
}

describe('Conversation: duplicates are absorbed', () => {
  it('applying the exact same increment twice does not duplicate it in the derived messages', () => {
    const conversation = new Conversation()
    conversation.applyEnvelope({ kind: 'increment', event: turnStart(0) })
    conversation.applyEnvelope({ kind: 'increment', event: userMessage(1, 'hi') })
    conversation.applyEnvelope({ kind: 'increment', event: userMessage(1, 'hi') }) // 重复投递同一条
    expect(conversation.confirmedEvents).toHaveLength(2)
  })
})

describe('Conversation: out-of-order arrival is reordered by seq, not by arrival time', () => {
  it('events applied out of order still derive correctly once the gap closes', () => {
    const conversation = new Conversation()
    conversation.applyEnvelope({ kind: 'increment', event: userMessage(1, 'hi') }) // seq 1 先到
    conversation.applyEnvelope({ kind: 'increment', event: turnStart(0) }) // seq 0 后到，补上缺口
    expect(conversation.confirmedEvents.map((e) => e.seq)).toEqual([0, 1])
  })
})

describe('Conversation: a gap blocks confirmation, even if later events already arrived', () => {
  it('seq 2 arriving before seq 1 does not let seq 2 become "confirmed" — seq 0 is the ceiling', () => {
    const conversation = new Conversation()
    conversation.applyEnvelope({ kind: 'increment', event: turnStart(0) })
    conversation.applyEnvelope({ kind: 'increment', event: turnEnd(2) }) // seq 1 缺失，seq 2 提前到
    expect(conversation.cursor).toBe(0) // 只确认到 seq 0，不会因为 seq 2 已经到了就往前跳
    expect(conversation.confirmedEvents.map((e) => e.seq)).toEqual([0])

    conversation.applyEnvelope({ kind: 'increment', event: userMessage(1, 'hi') }) // 缺口补上
    expect(conversation.cursor).toBe(2) // 一次性追上去，seq 1、2 都变成"确认"
    expect(conversation.confirmedEvents.map((e) => e.seq)).toEqual([0, 1, 2])
  })
})

describe('Conversation: baseline and increment feed the same underlying store', () => {
  it('a baseline snapshot and a later increment for a new seq compose correctly', () => {
    const conversation = new Conversation()
    conversation.applyEnvelope({ kind: 'baseline', snapshot: [turnStart(0), userMessage(1, 'hi')] })
    conversation.applyEnvelope({ kind: 'increment', event: turnEnd(2) })
    expect(conversation.cursor).toBe(2)
    expect(conversation.messages).toHaveLength(1) // deriveMessages() 只把 user/message 变成一条消息
  })
})

describe('Conversation: terminal/transport-error do not touch the event log', () => {
  it('applying terminal or transport-error envelopes leaves cursor/confirmedEvents unchanged', () => {
    const conversation = new Conversation()
    conversation.applyEnvelope({ kind: 'increment', event: turnStart(0) })
    conversation.applyEnvelope({ kind: 'terminal', reason: 'completed', lastSeq: 0 })
    conversation.applyEnvelope({ kind: 'transport-error', message: 'x' })
    expect(conversation.cursor).toBe(0)
    expect(conversation.confirmedEvents).toHaveLength(1)
  })
})

describe('Conversation: a fresh instance starts with no confirmed history', () => {
  it('cursor is -1 and confirmedEvents/messages are empty before anything is applied', () => {
    const conversation = new Conversation()
    expect(conversation.cursor).toBe(-1)
    expect(conversation.confirmedEvents).toEqual([])
    expect(conversation.messages).toEqual([])
  })
})
