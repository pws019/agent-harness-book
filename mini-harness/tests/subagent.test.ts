import { describe, expect, it } from 'vitest'
import { DelegationBudget } from '../src/core/delegation-budget.js'
import { createAutonomousPreset, createBalancedPreset, createReadonlyPreset } from '../src/core/permission-presets.js'
import { SubagentBudgetExceededError, SubagentManager, SubagentPermissionEscalationError } from '../src/core/subagent.js'
import { LlmAdapter, LlmError, type GenerateOptions } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'

function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}
function task(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

class InstantAdapter extends LlmAdapter {
  constructor(private readonly reply = 'child done') {
    super()
  }
  async *stream(): AsyncIterable<StreamChunk> {
    yield* streamFake({
      message: assistantText(this.reply),
      finishReason: { kind: 'stop' },
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  }
}

/** Stays suspended until aborted — for testing maxTimeMs cancellation. */
class GatedAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await new Promise<void>((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new LlmError({ code: 'ABORTED', message: 'aborted mid-flight' })))
    })
    yield* streamFake({ message: assistantText('should not get here'), finishReason: { kind: 'stop' } })
  }
}

function deps(adapter: LlmAdapter) {
  return { adapter, tools: new ToolRegistry(), provider: 'demo', model: 'test' }
}

describe('SubagentManager: happy path — isolated child, structured result crosses back', () => {
  it('startChild() returns immediately; result() resolves once the child finishes', async () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 })
    const manager = new SubagentManager(budget)

    const handle = manager.startChild({ deps: deps(new InstantAdapter('42')), task: task('compute something') })
    expect(handle.id).toBeTruthy()

    const result = await handle.result()
    expect(result).toEqual({ ok: true, data: '42' })
  })

  it('a failed/cancelled child reports ok:false, not thrown', async () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5, maxTimeMs: 100 })
    const manager = new SubagentManager(budget)
    const handle = manager.startChild({ deps: deps(new GatedAdapter()), task: task('never finishes') })
    const result = await handle.result()
    expect(result.ok).toBe(false)
  })
})

describe('SubagentManager: budget is enforced fail-closed before a child is ever constructed', () => {
  it('exceeding maxConcurrent throws SubagentBudgetExceededError, no child is created', () => {
    const budget = new DelegationBudget({ maxConcurrent: 1, maxTotalChildren: 5, maxDepth: 5 })
    const manager = new SubagentManager(budget)
    manager.startChild({ deps: deps(new InstantAdapter()), task: task('a') })
    expect(() => manager.startChild({ deps: deps(new InstantAdapter()), task: task('b') })).toThrow(SubagentBudgetExceededError)
    expect(manager.runningChildCount).toBe(1) // 第二次没有真的创建出来
  })

  it('exceeding maxDepth denies starting any child at all', () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 1 })
    const manager = new SubagentManager(budget, /* depth */ 1)
    expect(() => manager.startChild({ deps: deps(new InstantAdapter()), task: task('a') })).toThrow(SubagentBudgetExceededError)
  })

  it('exceeding maxTotalChildren denies even when nothing is currently running', async () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 1, maxDepth: 5 })
    const manager = new SubagentManager(budget)
    const first = manager.startChild({ deps: deps(new InstantAdapter()), task: task('a') })
    await first.result()
    expect(() => manager.startChild({ deps: deps(new InstantAdapter()), task: task('b') })).toThrow(SubagentBudgetExceededError)
  })
})

describe('SubagentManager: a child cannot have more authority than its parent', () => {
  it('a child preset ranked higher than the parent preset is rejected before the child is created', () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 })
    const readOnlyTools = new Set(['read_file'])
    const manager = new SubagentManager(budget, 0, createReadonlyPreset(readOnlyTools))

    expect(() =>
      manager.startChild({ deps: deps(new InstantAdapter()), task: task('a'), preset: createAutonomousPreset() }),
    ).toThrow(SubagentPermissionEscalationError)
    expect(manager.runningChildCount).toBe(0)
  })

  it('a child preset ranked equal to or lower than the parent is allowed', () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 })
    const readOnlyTools = new Set(['read_file'])
    const manager = new SubagentManager(budget, 0, createBalancedPreset(readOnlyTools))
    expect(() =>
      manager.startChild({ deps: deps(new InstantAdapter()), task: task('a'), preset: createBalancedPreset(readOnlyTools) }),
    ).not.toThrow()
  })
})

describe('SubagentManager: no orphan children after the parent disposes', () => {
  it('disposeAll() tears down every still-running child', async () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 })
    const manager = new SubagentManager(budget)
    manager.startChild({ deps: deps(new GatedAdapter()), task: task('never finishes on its own') })
    expect(manager.runningChildCount).toBe(1)

    await manager.disposeAll()
    expect(manager.runningChildCount).toBe(0)
  })
})

describe('SubagentManager: structured results cross the boundary, not raw event logs', () => {
  it("the parent only sees the child's final text, not its internal session events", async () => {
    const budget = new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 })
    const manager = new SubagentManager(budget)
    const handle = manager.startChild({ deps: deps(new InstantAdapter('the answer is 7')), task: task('compute') })
    const result = await handle.result()
    expect(result.data).toBe('the answer is 7')
    expect(result).not.toHaveProperty('events')
    expect(result).not.toHaveProperty('sessionEvents')
  })
})
