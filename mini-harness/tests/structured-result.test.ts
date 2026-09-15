import { describe, expect, it } from 'vitest'
import { InvalidStructuredResultError, createStructuredResult } from '../src/core/structured-result.js'

describe('createStructuredResult: the only legal way to cross the parent/child boundary', () => {
  it('accepts plain JSON-safe data', () => {
    expect(createStructuredResult(true, { a: 1, b: ['x', 'y'], c: null })).toEqual({ ok: true, data: { a: 1, b: ['x', 'y'], c: null } })
  })

  it('accepts null and primitives', () => {
    expect(createStructuredResult(true, null).data).toBeNull()
    expect(createStructuredResult(true, 'text').data).toBe('text')
    expect(createStructuredResult(false, 42).data).toBe(42)
  })

  it('rejects a function — cannot cross a JSON-only boundary', () => {
    expect(() => createStructuredResult(true, () => {})).toThrow(InvalidStructuredResultError)
  })

  it('rejects undefined', () => {
    expect(() => createStructuredResult(true, undefined)).toThrow(InvalidStructuredResultError)
  })

  it('rejects a class instance (non-plain-object prototype)', () => {
    class Weird {
      x = 1
    }
    expect(() => createStructuredResult(true, new Weird())).toThrow(InvalidStructuredResultError)
  })
})
