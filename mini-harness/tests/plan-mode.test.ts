import { describe, expect, it } from 'vitest'
import { PlanModeController } from '../src/core/plan-mode.js'
import { createAutonomousPreset, createReadonlyPreset } from '../src/core/permission-presets.js'

const READ_ONLY = new Set(['read_file', 'search_text'])

describe('PlanModeController: starts in planning mode, gated by the readonly preset', () => {
  it('a write-shaped tool is denied while in planning mode', () => {
    const controller = new PlanModeController({ planning: createReadonlyPreset(READ_ONLY), executing: createAutonomousPreset() })
    expect(controller.currentMode).toBe('planning')
    expect(controller.decide('edit_file')).toBe('deny')
    expect(controller.decide('read_file')).toBe('auto-approve')
  })

  it('switching to executing mode changes what decide() returns for the exact same tool', () => {
    const controller = new PlanModeController({ planning: createReadonlyPreset(READ_ONLY), executing: createAutonomousPreset() })
    controller.switchTo('executing')
    expect(controller.currentMode).toBe('executing')
    expect(controller.decide('edit_file')).toBe('auto-approve')
  })

  it('switching to the mode you are already in is a no-op — no new transition recorded', () => {
    const controller = new PlanModeController({ planning: createReadonlyPreset(READ_ONLY), executing: createAutonomousPreset() }, 1000)
    expect(controller.history).toEqual([{ mode: 'planning', at: 1000 }])
    controller.switchTo('planning', 2000)
    expect(controller.history).toEqual([{ mode: 'planning', at: 1000 }])
  })

  it('history records every real transition in order, with the timestamp given to switchTo()', () => {
    const controller = new PlanModeController({ planning: createReadonlyPreset(READ_ONLY), executing: createAutonomousPreset() }, 1000)
    controller.switchTo('executing', 2000)
    controller.switchTo('planning', 3000)
    expect(controller.history).toEqual([
      { mode: 'planning', at: 1000 },
      { mode: 'executing', at: 2000 },
      { mode: 'planning', at: 3000 },
    ])
  })
})
