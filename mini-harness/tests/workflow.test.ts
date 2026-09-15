import { describe, expect, it } from 'vitest'
import { DelegationBudget } from '../src/core/delegation-budget.js'
import { LlmAdapter, LlmError, type GenerateOptions } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { AgentDeps } from '../src/core/agent-handle.js'
import { agent, parallel, phase, pipeline } from '../src/core/workflow-dsl.js'
import { countAgentLeaves } from '../src/core/workflow-types.js'
import { SubagentManager } from '../src/core/subagent.js'
import { WorkflowRunner, WorkflowScriptError, buildWorkflowFromScript } from '../src/core/workflow-runner.js'

function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

class InstantAdapter extends LlmAdapter {
  constructor(private readonly reply = 'done') {
    super()
  }
  async *stream(): AsyncIterable<StreamChunk> {
    yield* streamFake({ message: assistantText(this.reply), finishReason: { kind: 'stop' }, usage: { inputTokens: 10, outputTokens: 5 } })
  }
}

/** 永不 resolve、完全忽略自己的 AbortSignal——用来验证 `WorkflowRunner.cancel()`
 * 靠自己（级联 dispose）收尾，不靠子任务配合。 */
class StubbornAdapter extends LlmAdapter {
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    await new Promise<void>(() => {})
    yield* streamFake({ message: assistantText('unreachable'), finishReason: { kind: 'stop' } })
  }
}

function deps(adapter: LlmAdapter): Omit<AgentDeps, 'sink'> {
  return { adapter, tools: new ToolRegistry(), provider: 'demo', model: 'test' }
}

function registry(entries: Record<string, LlmAdapter>): ReadonlyMap<string, Omit<AgentDeps, 'sink'>> {
  return new Map(Object.entries(entries).map(([id, adapter]) => [id, deps(adapter)]))
}

describe('workflow DSL: pure, deferred builders', () => {
  it('agent()/parallel()/pipeline()/phase() just build data — nothing runs until interpreted', () => {
    const tree = phase('review', parallel(agent('a', 'task a'), pipeline(agent('b', 'task b'), agent('c', 'task c'))))
    expect(tree).toEqual({
      kind: 'phase',
      name: 'review',
      node: {
        kind: 'parallel',
        children: [
          { kind: 'agent', agentId: 'a', task: 'task a' },
          { kind: 'pipeline', steps: [{ kind: 'agent', agentId: 'b', task: 'task b' }, { kind: 'agent', agentId: 'c', task: 'task c' }] },
        ],
      },
    })
  })

  it('countAgentLeaves() counts across all four node kinds', () => {
    const tree = phase('p', parallel(agent('a', 't'), pipeline(agent('b', 't'), agent('c', 't'), agent('d', 't'))))
    expect(countAgentLeaves(tree)).toBe(4)
  })
})

describe('buildWorkflowFromScript(): CodeRuntime\'s first real caller', () => {
  it('a script whose last statement calls the DSL builders produces the matching WorkflowNode tree', () => {
    const tree = buildWorkflowFromScript(`pipeline(agent('a', 'do x'), parallel(agent('b', 'do y'), agent('c', 'do z')))`)
    expect(tree).toEqual({
      kind: 'pipeline',
      steps: [
        { kind: 'agent', agentId: 'a', task: 'do x' },
        { kind: 'parallel', children: [{ kind: 'agent', agentId: 'b', task: 'do y' }, { kind: 'agent', agentId: 'c', task: 'do z' }] },
      ],
    })
  })

  it('a script with no access to require/process — the same CommandPolicy-adjacent whitelist discipline as Day25', () => {
    expect(() => buildWorkflowFromScript(`require('node:fs')`)).toThrow()
  })

  it('a script whose completion value is not a WorkflowNode is rejected, not silently coerced', () => {
    expect(() => buildWorkflowFromScript(`"just a string, not a tree"`)).toThrow(WorkflowScriptError)
  })
})

describe('WorkflowRunner: interpreting a tree into real SubagentManager calls', () => {
  it('agent leaf resolves an agentId against the registry and runs a real child Agent', async () => {
    const manager = new SubagentManager(new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 }))
    const runner = new WorkflowRunner(manager, registry({ writer: new InstantAdapter('written') }))

    const state = await runner.run(agent('writer', 'write something'), { maxAgents: 5 })

    expect(state).toEqual({
      kind: 'completed',
      result: { kind: 'agent', agentId: 'writer', result: { ok: true, data: 'written' } },
    })
  })

  it('parallel runs children concurrently; pipeline runs steps in order — both reflected in the result tree', async () => {
    const manager = new SubagentManager(new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 }))
    const runner = new WorkflowRunner(
      manager,
      registry({ a: new InstantAdapter('A'), b: new InstantAdapter('B'), c: new InstantAdapter('C') }),
    )

    const tree = phase('build', parallel(agent('a', 't1'), pipeline(agent('b', 't2'), agent('c', 't3'))))
    const state = await runner.run(tree, { maxAgents: 5 })

    expect(state).toEqual({
      kind: 'completed',
      result: {
        kind: 'phase',
        name: 'build',
        result: {
          kind: 'parallel',
          children: [
            { kind: 'agent', agentId: 'a', result: { ok: true, data: 'A' } },
            {
              kind: 'pipeline',
              steps: [
                { kind: 'agent', agentId: 'b', result: { ok: true, data: 'B' } },
                { kind: 'agent', agentId: 'c', result: { ok: true, data: 'C' } },
              ],
            },
          ],
        },
      },
    })
  })

  it('unknown agentId fails the whole run as an error terminal state, not a thrown exception', async () => {
    const manager = new SubagentManager(new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 }))
    const runner = new WorkflowRunner(manager, registry({ known: new InstantAdapter() }))

    const state = await runner.run(agent('ghost', 'task'), { maxAgents: 5 })

    expect(state.kind).toBe('error')
  })

  it('maxAgents rejects fail-closed before any child starts — running count stays 0', async () => {
    const manager = new SubagentManager(new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 }))
    const runner = new WorkflowRunner(manager, registry({ a: new InstantAdapter(), b: new InstantAdapter() }))

    const tree = parallel(agent('a', 't'), agent('b', 't'))
    const state = await runner.run(tree, { maxAgents: 1 })

    expect(state).toEqual({ kind: 'error', message: 'workflow tree has 2 agent leaves, exceeding maxAgents (1)' })
    expect(manager.runningChildCount).toBe(0)
  })

  it('cancel() resolves within a bounded time even against a stuck child that ignores its own AbortSignal', async () => {
    // StubbornAdapter's stream() never settles and never listens to the AbortSignal at all —
    // Agent.dispose() itself (`await this.runLoopPromise`) would hang forever waiting on it.
    // WorkflowRunner.cancel() must not wait for that: it settles its own terminal state
    // immediately and fires child dispose() in the background instead of awaiting it.
    const manager = new SubagentManager(new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 }))
    const runner = new WorkflowRunner(manager, registry({ stuck: new StubbornAdapter() }))

    const runPromise = runner.run(agent('stuck', 'never finishes'), { maxAgents: 5 })
    await new Promise((resolve) => setTimeout(resolve, 20))

    const started = Date.now()
    await runner.cancel()
    expect(Date.now() - started).toBeLessThan(200)

    const state = await runPromise
    expect(state).toEqual({ kind: 'cancelled' })
  })

  it('forceCancelAfterMs forces a cancelled terminal state on its own, without an explicit cancel() call', async () => {
    const manager = new SubagentManager(new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 }))
    const runner = new WorkflowRunner(manager, registry({ stuck: new StubbornAdapter() }))

    const state = await runner.run(agent('stuck', 'never finishes'), { maxAgents: 5, forceCancelAfterMs: 50 })

    expect(state).toEqual({ kind: 'cancelled' })
  })

  it('cancel() racing natural completion still produces exactly one terminal state', async () => {
    const manager = new SubagentManager(new DelegationBudget({ maxConcurrent: 5, maxTotalChildren: 5, maxDepth: 5 }))
    const runner = new WorkflowRunner(manager, registry({ fast: new InstantAdapter('quick') }))

    const runPromise = runner.run(agent('fast', 'quick task'), { maxAgents: 5 })
    const cancelPromise = runner.cancel()

    const [state] = await Promise.all([runPromise, cancelPromise])
    expect(['completed', 'cancelled']).toContain(state.kind)

    // Whichever won, run() must never resolve a second, different terminal state later.
    const second = await runner.run(agent('fast', 'quick task'), { maxAgents: 5 })
    expect(second).toEqual(state)
  })
})
