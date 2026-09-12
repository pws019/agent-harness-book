import { describe, expect, it } from 'vitest'
import { TokenMeter } from '../src/core/token-meter.js'

describe('TokenMeter', () => {
  it('starts at zero and accumulates across multiple record() calls', () => {
    const meter = new TokenMeter()
    meter.record({ inputTokens: 100, outputTokens: 20 })
    meter.record({ inputTokens: 50, outputTokens: 10 })
    expect(meter.totals()).toEqual({ inputTokens: 150, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('treats a missing cache field within a reported usage as a legitimate zero, not unknown', () => {
    const meter = new TokenMeter()
    meter.record({ inputTokens: 10, outputTokens: 5 }) // no cache fields at all
    expect(meter.totals()).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 })
  })

  it('accumulates cache fields normally when a provider does report them', () => {
    const meter = new TokenMeter()
    meter.record({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1 })
    meter.record({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 })
    expect(meter.totals()).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 1 })
  })

  it('a single record(undefined) -- "this attempt reported no usage at all" -- poisons every field to unknown', () => {
    const meter = new TokenMeter()
    meter.record({ inputTokens: 10, outputTokens: 5 })
    meter.record(undefined)
    expect(meter.totals()).toEqual({
      inputTokens: 'unknown',
      outputTokens: 'unknown',
      cacheReadTokens: 'unknown',
      cacheWriteTokens: 'unknown',
    })
  })

  it('once unknown, later well-reported usage does not un-poison the total', () => {
    const meter = new TokenMeter()
    meter.record(undefined)
    meter.record({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 1 })
    const totals = meter.totals()
    expect(totals.inputTokens).toBe('unknown')
    expect(totals.outputTokens).toBe('unknown')
    expect(totals.cacheReadTokens).toBe('unknown')
    expect(totals.cacheWriteTokens).toBe('unknown')
  })

  describe('totalKnownTokens', () => {
    it('is input + output, ignoring cache fields entirely', () => {
      const meter = new TokenMeter()
      meter.record({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 999, cacheWriteTokens: 999 })
      expect(meter.totalKnownTokens()).toBe(120)
    })

    it('is unknown as soon as either input or output is unknown, even if cache fields are fine', () => {
      const meter = new TokenMeter()
      meter.record({ inputTokens: 10, outputTokens: 5 })
      meter.record(undefined) // poisons input/output (and cache) to unknown
      expect(meter.totalKnownTokens()).toBe('unknown')
    })
  })
})
