import { describe, expect, it } from 'vitest'
import { createBacklogWriter } from '../src/server/backlog-writer.js'
import { decodeEnvelopeLine } from '../src/server/wire-protocol.js'

describe('createBacklogWriter: pure accounting, no real IO needed to test it deterministically', () => {
  it('a client that never flushes eventually trips the cap, without depending on real OS socket timing', () => {
    const written: string[] = []
    let overflowed = false
    // 每条编码后的 envelope 大约 86 字节——上限设成刚好能装下 2 条、装不下第 3 条，
    // 这样断言"恰好接受了几条"才是在验证真的在累计计数，而不是"第一条就直接爆了"。
    const write = createBacklogWriter({
      maxBytes: 250,
      write: (line) => {
        written.push(line)
        // 故意永远不调用 onFlushed：模拟一个死活不读的慢客户端，backlog 永远不会被扣回去。
      },
      onOverflow: () => {
        overflowed = true
      },
    })

    let acceptedCount = 0
    for (let i = 0; i < 20; i++) {
      const ok = write({ kind: 'increment', event: { type: 'step/start', seq: i, time: 0, turn: 0, step: 0 } })
      if (ok) acceptedCount += 1
      if (overflowed) break
    }

    expect(overflowed).toBe(true)
    expect(acceptedCount).toBe(2) // 2 * 86 = 172 <= 250，第 3 条 258 > 250 才触发
    expect(written.length).toBe(2)
  })

  it('once a flushed chunk is acknowledged, its bytes are released and more room opens up', () => {
    let onFlushed: (() => void) | undefined
    const write = createBacklogWriter({
      maxBytes: 90, // 刚好够放下一条约 86 字节的 envelope，不够同时放两条
      write: (_line, flush) => {
        onFlushed = flush
      },
      onOverflow: () => {
        throw new Error('should not overflow in this test')
      },
    })

    const first = write({ kind: 'increment', event: { type: 'step/start', seq: 0, time: 0, turn: 0, step: 0 } })
    expect(first).toBe(true)
    onFlushed?.() // 模拟"这一条终于被真正发出去了"
    const second = write({ kind: 'increment', event: { type: 'step/end', seq: 1, time: 0, turn: 0, step: 0 } })
    expect(second).toBe(true) // 第一条的字节数已经被释放，第二条能写进去
  })

  it('after overflow, every subsequent write() call is rejected — the writer is permanently abandoned', () => {
    let overflowCount = 0
    const write = createBacklogWriter({
      maxBytes: 1, // 第一条就直接超限
      write: () => {
        throw new Error('should never actually write once overflowed')
      },
      onOverflow: () => {
        overflowCount += 1
      },
    })

    expect(write({ kind: 'transport-error', message: 'x'.repeat(10) })).toBe(false)
    expect(write({ kind: 'transport-error', message: 'y' })).toBe(false)
    expect(overflowCount).toBe(1) // onOverflow 只触发一次，不会每次都重复报
  })

  it('encodeEnvelope/decodeEnvelopeLine round-trip through what write() actually sends', () => {
    let captured = ''
    const write = createBacklogWriter({
      maxBytes: 1000,
      write: (line) => {
        captured = line
      },
      onOverflow: () => {
        throw new Error('should not overflow')
      },
    })
    write({ kind: 'terminal', reason: 'completed', lastSeq: 5 })
    expect(captured.endsWith('\n')).toBe(true)
    expect(decodeEnvelopeLine(captured.trim())).toEqual({ kind: 'terminal', reason: 'completed', lastSeq: 5 })
  })
})
