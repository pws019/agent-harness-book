import { afterEach, describe, expect, it, vi } from 'vitest'
import { CredentialNotFoundError, EnvCredentialStore, InMemoryCredentialStore, type CredentialRef } from '../src/core/credentials.js'
import { isJsonValue } from '../src/core/session.js'

describe('CredentialRef: safe to log, never carries the real value', () => {
  it('is plain, lossless JSON — safe to write into a Session event without leaking anything', () => {
    const ref: CredentialRef = { id: 'openai-api-key' }
    expect(isJsonValue(ref)).toBe(true)
    expect(JSON.stringify(ref)).not.toContain('sk-') // 一个真实密钥常见前缀，这里显然不可能出现
  })
})

describe('InMemoryCredentialStore', () => {
  it('resolve() returns the real value only when asked, by reference', () => {
    const store = new InMemoryCredentialStore()
    store.set('openai-api-key', 'sk-real-secret-value')
    expect(store.resolve({ id: 'openai-api-key' })).toBe('sk-real-secret-value')
  })

  it('resolving an unknown ref throws instead of returning undefined/empty', () => {
    const store = new InMemoryCredentialStore()
    expect(() => store.resolve({ id: 'no-such-credential' })).toThrow(CredentialNotFoundError)
  })
})

describe('EnvCredentialStore', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('resolve() reads the value from process.env, keyed by ref.id verbatim (no prefix/case rewrite)', () => {
    vi.stubEnv('MINI_HARNESS_TEST_CREDENTIAL', 'sk-from-host-env')
    const store = new EnvCredentialStore()
    expect(store.resolve({ id: 'MINI_HARNESS_TEST_CREDENTIAL' })).toBe('sk-from-host-env')
  })

  it('resolving an id with no matching environment variable throws instead of returning undefined/empty', () => {
    const store = new EnvCredentialStore()
    expect(() => store.resolve({ id: 'MINI_HARNESS_TEST_CREDENTIAL_DOES_NOT_EXIST' })).toThrow(CredentialNotFoundError)
  })
})
