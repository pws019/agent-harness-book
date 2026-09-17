import { describe, expect, it } from 'vitest'
import {
  ApprovalAlreadyConsumedError,
  ApprovalArgsMismatchError,
  ApprovalStore,
} from '../src/core/approval.js'
import { AuditingApprovalStore, type AuditRecord } from '../src/core/audit-log.js'

function recordingSink() {
  const records: AuditRecord[] = []
  return { sink: { record: (entry: AuditRecord) => records.push(entry) }, records }
}

describe('AuditingApprovalStore: wraps a real ApprovalStore without changing its behavior', () => {
  it('create()/consume() succeed exactly as they would against the bare ApprovalStore', () => {
    const inner = new ApprovalStore()
    const store = new AuditingApprovalStore(inner)
    const args = { file: 'a.txt' }

    const request = store.create('edit_file', 'a.txt', 'summary', args, 60_000, 'alice')
    expect(request.action).toBe('edit_file')
    store.consume(request.nonce, args, 'alice')

    // consume() 已经用过一次——直接对着被包的那个 inner store 断言语义没变，
    // 底层状态机（consumed/revoked/expired 判断）完全还是 ApprovalStore 自己的。
    expect(() => inner.consume(request.nonce, args)).toThrow(ApprovalAlreadyConsumedError)
  })

  it('a mismatched-args consume() still throws through the wrapper, exactly as the bare store would', () => {
    const store = new AuditingApprovalStore(new ApprovalStore())
    const request = store.create('edit_file', 'a.txt', 'summary', { find: 'x' }, 60_000, 'alice')

    expect(() => store.consume(request.nonce, { find: 'y' }, 'alice')).toThrow(ApprovalArgsMismatchError)
  })

  it('create() emits a "created" audit record with the given principal', () => {
    const { sink, records } = recordingSink()
    const store = new AuditingApprovalStore(new ApprovalStore(), sink)

    const request = store.create('edit_file', 'notes.txt', 'summary', { a: 1 }, 60_000, 'alice', 1_000)

    expect(records).toEqual([{ kind: 'created', principal: 'alice', nonce: request.nonce, action: 'edit_file', target: 'notes.txt', at: 1_000 }])
  })

  it('a successful consume() emits a "consumed" record carrying the action/target recorded at create() time', () => {
    const { sink, records } = recordingSink()
    const store = new AuditingApprovalStore(new ApprovalStore(), sink)
    const args = { a: 1 }

    const request = store.create('edit_file', 'notes.txt', 'summary', args, 60_000, 'alice', 1_000)
    store.consume(request.nonce, args, 'alice', 1_005)

    expect(records).toEqual([
      { kind: 'created', principal: 'alice', nonce: request.nonce, action: 'edit_file', target: 'notes.txt', at: 1_000 },
      { kind: 'consumed', principal: 'alice', nonce: request.nonce, action: 'edit_file', target: 'notes.txt', at: 1_005 },
    ])
  })

  it('a failed consume() (already consumed) emits no additional audit record — a failed attempt is not "a consumption that happened"', () => {
    const { sink, records } = recordingSink()
    const store = new AuditingApprovalStore(new ApprovalStore(), sink)
    const args = { a: 1 }

    const request = store.create('edit_file', 'notes.txt', 'summary', args, 60_000, 'alice')
    store.consume(request.nonce, args, 'alice')
    expect(() => store.consume(request.nonce, args, 'alice')).toThrow(ApprovalAlreadyConsumedError)

    expect(records.filter((r) => r.kind === 'consumed')).toHaveLength(1)
  })

  it('revoke() emits a "revoked" record', () => {
    const { sink, records } = recordingSink()
    const store = new AuditingApprovalStore(new ApprovalStore(), sink)

    const request = store.create('edit_file', 'notes.txt', 'summary', { a: 1 }, 60_000, 'alice', 1_000)
    store.revoke(request.nonce, 'alice', 1_002)

    expect(records.at(-1)).toEqual({ kind: 'revoked', principal: 'alice', nonce: request.nonce, action: 'edit_file', target: 'notes.txt', at: 1_002 })
  })

  it('no sink given — create()/consume()/revoke() still work, they just have nothing to notify', () => {
    const store = new AuditingApprovalStore(new ApprovalStore())
    const request = store.create('edit_file', 'a.txt', 's', { a: 1 }, 60_000, 'alice')
    expect(() => store.consume(request.nonce, { a: 1 }, 'alice')).not.toThrow()
  })
})
