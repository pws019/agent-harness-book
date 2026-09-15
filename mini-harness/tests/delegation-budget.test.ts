import { describe, expect, it } from 'vitest'
import { DelegationBudget } from '../src/core/delegation-budget.js'

describe('DelegationBudget: fail-closed, no partial permission', () => {
  it('canStart() is true when under every limit', () => {
    const budget = new DelegationBudget({ maxConcurrent: 2, maxTotalChildren: 5, maxDepth: 3 })
    expect(budget.canStart(0)).toBe(true)
  })

  it('depth at or beyond maxDepth is denied', () => {
    const budget = new DelegationBudget({ maxConcurrent: 10, maxTotalChildren: 10, maxDepth: 2 })
    expect(budget.canStart(1)).toBe(true)
    expect(budget.canStart(2)).toBe(false)
    expect(budget.canStart(3)).toBe(false)
  })

  it('maxConcurrent caps how many can be running at once, independent of total started', () => {
    const budget = new DelegationBudget({ maxConcurrent: 1, maxTotalChildren: 10, maxDepth: 5 })
    budget.recordStart()
    expect(budget.canStart(0)).toBe(false) // 1 个还在跑，达到并发上限
    budget.recordEnd(0)
    expect(budget.canStart(0)).toBe(true) // 跑完了，并发额度还回来了
  })

  it('maxTotalChildren caps lifetime total, even after children finish and free up concurrency', () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 2, maxDepth: 5 })
    budget.recordStart()
    budget.recordEnd(0)
    budget.recordStart()
    budget.recordEnd(0)
    expect(budget.canStart(0)).toBe(false) // 已经启动过 2 个了，哪怕现在一个都没在跑
  })

  it('maxTokens caps cumulative usage across finished children', () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5, maxTokens: 100 })
    budget.recordStart()
    budget.recordEnd(60)
    expect(budget.canStart(0)).toBe(true)
    budget.recordStart()
    budget.recordEnd(60) // 累计 120 > 100
    expect(budget.canStart(0)).toBe(false)
  })

  it('omitting maxTokens means no token-based cap at all', () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 })
    budget.recordStart()
    budget.recordEnd(1_000_000)
    expect(budget.canStart(0)).toBe(true)
  })

  it('maxTimeMs is exposed for callers to enforce per-child cancellation, not enforced by canStart() itself', () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5, maxTimeMs: 5_000 })
    expect(budget.maxTimeMs).toBe(5_000)
  })
})
