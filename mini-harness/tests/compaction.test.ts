import { describe, expect, it } from 'vitest'
import { applyCompaction, planCompaction } from '../src/core/compaction.js'
import { deriveMessages, Session } from '../src/core/session.js'
import type { Message } from '../src/llm/types.js'

function userText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

/** Appends `count` user/assistant exchange pairs, each inside its own turn, all cleanly closed. */
function seedConversation(session: Session, count: number, textAt: (i: number) => string, startTurn = 0): void {
  for (let i = 0; i < count; i++) {
    const turn = startTurn + i
    session.append('turn/start', { turn })
    session.append('user/message', { turn, message: userText(`question ${turn}: ${textAt(i)}`) })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', { turn, step: 1, message: assistantText(`answer ${turn}`) })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

describe('planCompaction', () => {
  it('returns undefined when there are not more surface events than the keep-recent budget', () => {
    const session = new Session()
    seedConversation(session, 2, () => '')
    // 2 turns * 2 surface events (user+assistant) = 4 surface events total
    expect(planCompaction(session.events, { keepRecentSurfaceEvents: 10 })).toBeUndefined()
  })

  it('compacts everything except the most recent N surface events, and the summary text includes the compacted originals', () => {
    const session = new Session()
    seedConversation(session, 5, (i) => `fact-${i}`)

    const plan = planCompaction(session.events, { keepRecentSurfaceEvents: 2 })
    expect(plan).toBeDefined()
    // 5 turns * 2 surface events = 10 total; keep last 2 -> compact the first 8.
    const surfaceEvents = session.events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message')
    expect(plan!.fromSeq).toBe(surfaceEvents[0]!.seq)
    expect(plan!.toSeq).toBe(surfaceEvents[7]!.seq)
    expect(plan!.summary.role).toBe('assistant')
    expect((plan!.summary.blocks[0] as { text: string }).text).toContain('fact-0')
    expect((plan!.summary.blocks[0] as { text: string }).text).toContain('fact-3') // 第4轮（i=3）也在被压缩范围内
    expect((plan!.summary.blocks[0] as { text: string }).text).not.toContain('fact-4') // 最后一轮保留，不该出现在摘要里
  })

  it('keeps track of who originally said each compacted line, not just the raw text', () => {
    const session = new Session()
    seedConversation(session, 3, (i) => `fact-${i}`)

    const plan = planCompaction(session.events, { keepRecentSurfaceEvents: 0 })!
    const text = (plan.summary.blocks[0] as { text: string }).text

    // 摘要整体包成一条 assistant 消息（Message.role 没有"摘要"这个选项），但每一行
    // 仍然保留了原始说话人——不能因为外层包装是 assistant 就让内容也变得看不出
    // 这句话原本是用户说的还是模型说的。
    expect(text).toContain('user: question 0: fact-0')
    expect(text).toContain('assistant: answer 0')
  })
})

describe('applyCompaction + deriveMessages: the summary replaces the compacted range without touching the original log', () => {
  it('derived history shows the summary once, in place, followed by the kept recent messages', () => {
    const session = new Session()
    seedConversation(session, 5, (i) => `fact-${i}`)
    const originalEventCount = session.events.length

    const plan = planCompaction(session.events, { keepRecentSurfaceEvents: 2 })!
    applyCompaction(session, plan)

    // 原始事件一条都没被删除或改写，只是追加了三条新事件。
    expect(session.events.length).toBe(originalEventCount + 3)
    expect(session.events.slice(0, originalEventCount)).toEqual(
      Session.restoreFrom(session.events.slice(0, originalEventCount)).events,
    )

    const messages = deriveMessages(session.events)
    // 摘要 + 最后一轮的 user + assistant = 3 条
    expect(messages).toHaveLength(3)
    expect((messages[0] as { blocks: readonly { text: string }[] }).blocks[0]!.text).toContain('fact-0')
    expect(messages[1]).toEqual(userText('question 4: fact-4'))
    expect(messages[2]).toEqual(assistantText('answer 4'))
  })

  it('a second compaction later only touches events after the first one', () => {
    const session = new Session()
    seedConversation(session, 4, (i) => `fact-${i}`)
    applyCompaction(session, planCompaction(session.events, { keepRecentSurfaceEvents: 2 })!)

    seedConversation(session, 3, (i) => `later-${i}`, 4) // turns 4..6 appended after the compaction

    const secondPlan = planCompaction(session.events, { keepRecentSurfaceEvents: 2 })!
    applyCompaction(session, secondPlan)

    const messages = deriveMessages(session.events)
    // 第一份摘要 + 第二份摘要 + 最后保留的一轮（user+assistant）
    expect(messages).toHaveLength(4)
    expect((messages[0] as { blocks: readonly { text: string }[] }).blocks[0]!.text).toContain('fact-0')
    expect((messages[1] as { blocks: readonly { text: string }[] }).blocks[0]!.text).toContain('later-0')
    expect(messages[2]).toEqual(userText('question 6: later-2'))
  })
})

describe('fault injection: needle in a haystack survives compaction', () => {
  it('a key fact planted early in a long history is still present in the compacted summary', () => {
    const session = new Session()
    const needle = 'THE_SECRET_INVOICE_NUMBER_IS_42'
    seedConversation(session, 1, () => needle) // 第0轮埋一个关键事实
    seedConversation(session, 50, (i) => `filler chatter number ${i}`, 1) // turns 1..50，无关的干扰内容

    const plan = planCompaction(session.events, { keepRecentSurfaceEvents: 2 })!
    applyCompaction(session, plan)

    const messages = deriveMessages(session.events)
    const summaryText = (messages[0] as { blocks: readonly { text: string }[] }).blocks[0]!.text
    expect(summaryText).toContain(needle)
  })
})
