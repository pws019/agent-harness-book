import { describe, expect, it } from 'vitest'
import { createAutonomousPreset, createBalancedPreset, createReadonlyPreset } from '../src/core/permission-presets.js'

const READ_ONLY = new Set(['read_file', 'list_files', 'search_text'])

describe('readonly preset', () => {
  it('auto-approves read-only tools, denies everything else', () => {
    const preset = createReadonlyPreset(READ_ONLY)
    expect(preset.decide('read_file')).toBe('auto-approve')
    expect(preset.decide('edit_file')).toBe('deny')
    expect(preset.decide('run_command')).toBe('deny')
  })
})

describe('balanced preset', () => {
  it('auto-approves read-only tools, requires approval for everything else', () => {
    const preset = createBalancedPreset(READ_ONLY)
    expect(preset.decide('read_file')).toBe('auto-approve')
    expect(preset.decide('edit_file')).toBe('require-approval')
    expect(preset.decide('run_command')).toBe('require-approval')
  })
})

describe('autonomous preset', () => {
  it('auto-approves everything, including tools it has never heard of', () => {
    const preset = createAutonomousPreset()
    expect(preset.decide('read_file')).toBe('auto-approve')
    expect(preset.decide('run_command')).toBe('auto-approve')
    expect(preset.decide('some_future_tool_that_does_not_exist_yet')).toBe('auto-approve')
  })
})
