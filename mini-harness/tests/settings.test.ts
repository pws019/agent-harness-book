import { describe, expect, it } from 'vitest'
import { mergeSettings } from '../src/core/settings.js'

describe('mergeSettings', () => {
  it('later layers override earlier ones, and each resolved key remembers which layer won', () => {
    const merged = mergeSettings([
      { source: 'default', values: { theme: 'light', maxTokens: 1000 } },
      { source: 'deployment', values: { maxTokens: 2000 } },
      { source: 'workspace', values: { theme: 'dark' } },
      { source: 'user', values: {} }, // 用户这一层没设置任何东西，不应该覆盖掉 workspace 的选择
    ])

    expect(merged.theme).toEqual({ value: 'dark', source: 'workspace' })
    expect(merged.maxTokens).toEqual({ value: 2000, source: 'deployment' })
  })

  it('a key only present in the default layer keeps default as its source', () => {
    const merged = mergeSettings([
      { source: 'default', values: { onlyInDefault: true } },
      { source: 'user', values: { somethingElse: 1 } },
    ])
    expect(merged.onlyInDefault).toEqual({ value: true, source: 'default' })
  })

  it('an empty layer list produces an empty result, not an error', () => {
    expect(mergeSettings([])).toEqual({})
  })
})

describe('mergeSettings: falsy values are real overrides, not treated as "unset"', () => {
  it('a later layer explicitly setting false/0 wins over an earlier layer, not silently ignored', () => {
    const merged = mergeSettings([
      { source: 'default', values: { debug: true, retries: 3 } },
      { source: 'user', values: { debug: false, retries: 0 } },
    ])
    expect(merged.debug).toEqual({ value: false, source: 'user' })
    expect(merged.retries).toEqual({ value: 0, source: 'user' })
  })
})
