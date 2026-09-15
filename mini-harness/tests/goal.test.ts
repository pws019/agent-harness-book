import { describe, expect, it } from 'vitest'
import { GoalNotFoundError, GoalNotPendingError, GoalStore, GoalVerificationFailedError } from '../src/core/goal.js'

describe('GoalStore: the model cannot close a goal by itself claiming it is done', () => {
  it('a goal starts open; markPendingVerification() moves it to pending-verification, not closed', () => {
    const store = new GoalStore()
    const id = store.open('write a passing test', () => true)
    expect(store.status(id)).toBe('open')
    store.markPendingVerification(id)
    expect(store.status(id)).toBe('pending-verification') // 不是 'closed' —— 这正是验收标准要的那句断言
  })

  it('close() succeeds only when verify() actually returns true', async () => {
    const store = new GoalStore()
    const id = store.open('x', () => true)
    store.markPendingVerification(id)
    await store.close(id)
    expect(store.status(id)).toBe('closed')
  })

  it('close() throws and leaves the goal in pending-verification when verify() returns false', async () => {
    const store = new GoalStore()
    const id = store.open('x', () => false)
    store.markPendingVerification(id)
    await expect(store.close(id)).rejects.toThrow(GoalVerificationFailedError)
    expect(store.status(id)).toBe('pending-verification') // 没被悄悄关闭
  })

  it('a failed close() can be retried after the underlying condition changes', async () => {
    let ready = false
    const store = new GoalStore()
    const id = store.open('x', () => ready)
    store.markPendingVerification(id)
    await expect(store.close(id)).rejects.toThrow(GoalVerificationFailedError)

    ready = true
    await store.close(id)
    expect(store.status(id)).toBe('closed')
  })

  it('close() called directly from "open" (skipping markPendingVerification) is rejected', async () => {
    const store = new GoalStore()
    const id = store.open('x', () => true)
    await expect(store.close(id)).rejects.toThrow(GoalNotPendingError)
  })

  it('close() is idempotent once actually closed', async () => {
    const store = new GoalStore()
    const id = store.open('x', () => true)
    store.markPendingVerification(id)
    await store.close(id)
    await expect(store.close(id)).resolves.toBeUndefined()
  })

  it('markPendingVerification() on an already-closed goal throws — that is a caller bug, not a no-op', async () => {
    const store = new GoalStore()
    const id = store.open('x', () => true)
    store.markPendingVerification(id)
    await store.close(id)
    expect(() => store.markPendingVerification(id)).toThrow(GoalNotPendingError)
  })

  it('operating on an unknown goal id throws GoalNotFoundError', () => {
    const store = new GoalStore()
    expect(() => store.status('never-created')).toThrow(GoalNotFoundError)
  })

  it('verify() can be async', async () => {
    const store = new GoalStore()
    const id = store.open('x', async () => true)
    store.markPendingVerification(id)
    await store.close(id)
    expect(store.status(id)).toBe('closed')
  })
})
