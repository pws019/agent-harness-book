import { describe, expect, it } from 'vitest'
import {
  ApprovalAlreadyConsumedError,
  ApprovalArgsMismatchError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  ApprovalStore,
} from '../src/core/approval.js'

describe('ApprovalStore: happy path', () => {
  it('create() returns a request bound to the given args, consume() with the same args succeeds', () => {
    const store = new ApprovalStore()
    const args = { file_path: 'a.txt', content: 'v2' }
    const request = store.create('edit_file', 'a.txt', 'overwrite a.txt', args, 60_000)

    expect(request.action).toBe('edit_file')
    expect(request.target).toBe('a.txt')
    expect(() => store.consume(request.nonce, args)).not.toThrow()
  })
})

describe('故障注入1：重放（同一个 nonce 消费两次）', () => {
  it('consuming the same nonce a second time fails, even with the exact same args', () => {
    const store = new ApprovalStore()
    const args = { command: 'ls' }
    const request = store.create('run_command', 'ls', 'list files', args, 60_000)

    store.consume(request.nonce, args) // 第一次：成功
    expect(() => store.consume(request.nonce, args)).toThrow(ApprovalAlreadyConsumedError) // 第二次：拒绝
  })
})

describe('故障注入2：批准后换参数', () => {
  it('consuming with different args than what was approved fails, and does not burn the nonce', () => {
    const store = new ApprovalStore()
    const approvedArgs = { command: 'ls', args: ['-l'] }
    const request = store.create('run_command', 'ls', 'list files with -l', approvedArgs, 60_000)

    const tamperedArgs = { command: 'rm', args: ['-rf', '/'] }
    expect(() => store.consume(request.nonce, tamperedArgs)).toThrow(ApprovalArgsMismatchError)

    // 换参数失败之后，用原本批准的那组参数重试仍然应该成功——一次参数不匹配的
    // 尝试不应该顺带把这个 nonce 也烧掉，那会连累一次合法的重试。
    expect(() => store.consume(request.nonce, approvedArgs)).not.toThrow()
  })
})

describe('故障注入3：双击批准', () => {
  it('is exactly the replay case — two near-simultaneous consume() calls, only the first wins', () => {
    const store = new ApprovalStore()
    const args = { command: 'ls' }
    const request = store.create('run_command', 'ls', 'list files', args, 60_000)

    const results = [
      (() => {
        try {
          store.consume(request.nonce, args)
          return 'ok'
        } catch {
          return 'rejected'
        }
      })(),
      (() => {
        try {
          store.consume(request.nonce, args)
          return 'ok'
        } catch {
          return 'rejected'
        }
      })(),
    ]
    expect(results.filter((r) => r === 'ok')).toHaveLength(1)
    expect(results.filter((r) => r === 'rejected')).toHaveLength(1)
  })
})

describe('故障注入4：过期回复', () => {
  it('consuming after expiresAt fails, even with the correct args and an unused nonce', () => {
    const store = new ApprovalStore()
    const args = { command: 'ls' }
    const now = 1_000_000
    const request = store.create('run_command', 'ls', 'list files', args, 1_000, now) // 1 秒 TTL

    expect(() => store.consume(request.nonce, args, now + 500)).not.toThrow() // 500ms 后，还没过期——但这次消费掉了

    const request2 = store.create('run_command', 'ls', 'list files', args, 1_000, now)
    expect(() => store.consume(request2.nonce, args, now + 1_500)).toThrow(ApprovalExpiredError) // 1500ms 后，过期了
  })
})

describe('未知 nonce', () => {
  it('consuming a nonce that was never created throws ApprovalNotFoundError', () => {
    const store = new ApprovalStore()
    expect(() => store.consume('never-existed', {})).toThrow(ApprovalNotFoundError)
  })
})
