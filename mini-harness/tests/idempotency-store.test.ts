import { describe, expect, it } from 'vitest'
import { IdempotencyStore } from '../src/server/idempotency-store.js'

describe('IdempotencyStore: claim() gates the side effect, not just the response', () => {
  it('the first claim() for a key succeeds; every later claim() for the same key fails', () => {
    const store = new IdempotencyStore<{ turnNumber: number }>()
    expect(store.claim('k1')).toBe(true)
    expect(store.claim('k1')).toBe(false)
    expect(store.claim('k1')).toBe(false)
  })

  it('different keys are independent', () => {
    const store = new IdempotencyStore<{ turnNumber: number }>()
    expect(store.claim('k1')).toBe(true)
    expect(store.claim('k2')).toBe(true)
  })

  it('complete() records the response that a later get() can read back', () => {
    const store = new IdempotencyStore<{ turnNumber: number }>()
    store.claim('k1')
    store.complete('k1', { turnNumber: 1 })
    expect(store.get('k1')).toEqual({ status: 'completed', response: { turnNumber: 1 } })
  })

  it('a claimed-but-not-yet-completed key reports in-flight, not a stale/undefined response', () => {
    const store = new IdempotencyStore<{ turnNumber: number }>()
    store.claim('k1')
    expect(store.get('k1')).toEqual({ status: 'in-flight' })
  })

  it('an unknown key has no entry at all', () => {
    const store = new IdempotencyStore<{ turnNumber: number }>()
    expect(store.get('never-seen')).toBeUndefined()
  })
})
