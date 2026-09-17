import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFlakySampleAdapter, runScenario, runScenarioSet, sampleScenario, type Scenario } from '../src/core/eval-harness.js'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, 'fixtures', 'workspace')

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: 'finds the needle',
    workspace: workspaceRoot,
    goal: 'search for TARGET_NEEDLE and report findings',
    query: 'TARGET_NEEDLE',
    assertions: [
      { kind: 'stop-reason', expected: 'completed' },
      { kind: 'tool-called', name: 'list_files' },
      { kind: 'tool-called', name: 'search_text' },
      { kind: 'final-text-includes', substring: 'TARGET_NEEDLE' },
    ],
    ...overrides,
  }
}

describe('runScenario(): assertions checked against a real InvestigationOutcome, not a canned expectation', () => {
  it('a scenario whose assertions actually hold reports passed:true, with a per-assertion breakdown', async () => {
    const result = await runScenario(scenario())
    expect(result.passed).toBe(true)
    expect(result.assertions.every((a) => a.passed)).toBe(true)
    expect(result.assertions).toHaveLength(4)
  })

  it('a scenario with a deliberately unsatisfiable assertion reports passed:false — failure detection actually works', async () => {
    const result = await runScenario(scenario({ assertions: [{ kind: 'final-text-includes', substring: 'this string never appears anywhere' }] }))
    expect(result.passed).toBe(false)
    expect(result.assertions[0]!.passed).toBe(false)
    expect(result.assertions[0]!.detail).toContain('does NOT contain')
  })

  it('a "tool-called" assertion against a tool that was never invoked fails, distinct from a text-content failure', async () => {
    const result = await runScenario(scenario({ assertions: [{ kind: 'tool-called', name: 'edit_file' }] }))
    expect(result.passed).toBe(false)
  })
})

describe('runScenarioSet(): aggregates multiple scenarios into one report', () => {
  it('counts passes and totals correctly across a mix of passing and failing scenarios', async () => {
    const passing = scenario({ name: 'passing' })
    const failing = scenario({ name: 'failing', assertions: [{ kind: 'stop-reason', expected: 'cancelled' }] })

    const report = await runScenarioSet([passing, failing])
    expect(report.totalCount).toBe(2)
    expect(report.passCount).toBe(1)
    expect(report.results.map((r) => r.scenario)).toEqual(['passing', 'failing'])
  })
})

// `createFlakySampleAdapter` 的"成功"路径只走一次 `list_files` 就直接给出最终文本
// （见 eval-harness.ts 的实现注释）——这里配一个跟它的真实行为匹配的轻量场景，
// 不复用上面那个要求同时调用 list_files 和 search_text 的 `scenario()`。
function flakyScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: 'flaky demo scenario',
    workspace: workspaceRoot,
    goal: 'demo',
    query: 'demo',
    assertions: [{ kind: 'final-text-includes', substring: 'evidence found in files' }],
    ...overrides,
  }
}

describe('sampleScenario(): sampling + aggregation mechanics, proven with a synthetic seeded adapter', () => {
  it('a 100%-success adapter always passes — aggregated pass rate is exactly 1', async () => {
    const alwaysSucceeds = createFlakySampleAdapter(1, 1)
    const report = await sampleScenario(flakyScenario(), 5, alwaysSucceeds)
    expect(report).toEqual({ scenario: 'flaky demo scenario', samples: 5, passCount: 5, passRate: 1 })
  })

  it('a 0%-success adapter never passes — aggregated pass rate is exactly 0', async () => {
    const alwaysFails = createFlakySampleAdapter(1, 0)
    const report = await sampleScenario(flakyScenario(), 5, alwaysFails)
    expect(report).toEqual({ scenario: 'flaky demo scenario', samples: 5, passCount: 0, passRate: 0 })
  })

  it('a seeded 50%-ish adapter produces a genuinely mixed pass rate — not all-or-nothing, and reproducible from the same seed', async () => {
    const report1 = await sampleScenario(flakyScenario(), 20, createFlakySampleAdapter(42, 0.5))
    const report2 = await sampleScenario(flakyScenario(), 20, createFlakySampleAdapter(42, 0.5))

    expect(report1.passCount).toBeGreaterThan(0)
    expect(report1.passCount).toBeLessThan(20)
    expect(report1).toEqual(report2) // 同一个种子必须复现同样的结果序列
  })
})
