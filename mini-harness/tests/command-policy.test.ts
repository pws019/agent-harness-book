import { describe, expect, it } from 'vitest'
import { AllowlistCommandPolicy, FailClosedCommandPolicy, type CommandPolicy } from '../src/tools/command-policy.js'

describe('AllowlistCommandPolicy', () => {
  it('allows exactly the commands it was constructed with, nothing else', () => {
    const policy = new AllowlistCommandPolicy(['ls', 'cat'])
    expect(policy.isAllowed('ls')).toBe(true)
    expect(policy.isAllowed('cat')).toBe(true)
    expect(policy.isAllowed('rm')).toBe(false)
    expect(policy.isAllowed('')).toBe(false)
  })
})

describe('FailClosedCommandPolicy: a broken policy denies, it never silently allows', () => {
  it('passes through a working inner policy unchanged', () => {
    const policy = new FailClosedCommandPolicy(new AllowlistCommandPolicy(['ls']))
    expect(policy.isAllowed('ls')).toBe(true)
    expect(policy.isAllowed('rm')).toBe(false)
  })

  it('denies (does not throw, does not allow) when the inner policy itself throws', () => {
    const broken: CommandPolicy = {
      isAllowed() {
        throw new Error('config file is corrupted')
      },
    }
    const policy = new FailClosedCommandPolicy(broken)
    expect(() => policy.isAllowed('ls')).not.toThrow()
    expect(policy.isAllowed('ls')).toBe(false)
  })
})
