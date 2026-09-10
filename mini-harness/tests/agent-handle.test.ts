import { describe, expect, it } from 'vitest'
import { Agent, type AgentCancelCause } from '../src/core/agent-handle.js'
import { LlmAdapter, LlmError, type GenerateOptions } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { ToolDefinition } from '../src/tools/types.js'

function echoTool(): ToolDefinition<string> {
  return {
    name: 'echo',
    description: 'returns whatever text argument it was given',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => value },
    timeoutMs: 1_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return (args as { text: string }).text
    },
  }
}

function userText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

function assistantText(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

/** Resolves instantly with a fixed text answer. Good for "happy path drains and goes idle" tests. */
class InstantAdapter extends LlmAdapter {
  callCount = 0
  async *stream(): AsyncIterable<StreamChunk> {
    this.callCount += 1
    yield* streamFake({ message: assistantText('ok'), finishReason: { kind: 'stop' } })
  }
}

/**
 * Stays genuinely suspended mid-request until you call `open()`, or reacts immediately to the
 * request's AbortSignal by throwing. `started` resolves the instant the generator body reaches
 * its blocking await, so tests can `await adapter.started` instead of guessing how many
 * microtask ticks it takes to get there through drain() -> runTurn() -> generateWithRetry().
 */
class GatedAdapter extends LlmAdapter {
  private release: (() => void) | undefined
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  private startedResolve: (() => void) | undefined
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })
  callCount = 0
  /** 每次 stream() 被调用时，实际收到的完整请求——用来断言"下一个 step 的历史里有没有引导消息"。 */
  readonly calls: GenerateOptions[] = []

  open(): void {
    this.release?.()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.callCount += 1
    this.calls.push(options)
    this.startedResolve?.()
    await new Promise<void>((resolve, reject) => {
      this.gate.then(resolve)
      options.signal?.addEventListener(
        'abort',
        () => reject(new LlmError({ code: 'ABORTED', message: 'aborted mid-flight' })),
        { once: true },
      )
    })
    yield* streamFake({ message: assistantText('too late'), finishReason: { kind: 'stop' } })
  }
}

/**
 * Like `GatedAdapter`, but the first call is gated and requests a tool call (forcing a real
 * step 2) instead of finishing the turn outright -- steer() needs a "next step" to actually
 * land in, and a turn that completes after one step never gets one.
 */
class GatedThenToolCallAdapter extends LlmAdapter {
  private release: (() => void) | undefined
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve
  })
  private startedResolve: (() => void) | undefined
  readonly started = new Promise<void>((resolve) => {
    this.startedResolve = resolve
  })
  readonly calls: GenerateOptions[] = []

  open(): void {
    this.release?.()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (this.calls.length === 1) {
      this.startedResolve?.()
      await this.gate
      const message: Message = {
        role: 'assistant',
        blocks: [{ type: 'tool-call', id: 'c1', name: 'echo', arguments: JSON.stringify({ text: 'x' }) }],
      }
      yield* streamFake({ message, finishReason: { kind: 'tool-calls' } })
      return
    }
    yield* streamFake({ message: assistantText('done'), finishReason: { kind: 'stop' } })
  }
}

function newAgent(adapter: LlmAdapter): Agent {
  return new Agent({ adapter, tools: new ToolRegistry(), provider: 'fake', model: 'x' })
}

describe('Agent: basic lifecycle', () => {
  it('goes idle -> running -> idle for a single message', async () => {
    const agent = newAgent(new InstantAdapter())
    expect(agent.status).toBe('idle')
    agent.send(userText('hi'))
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(agent.records).toHaveLength(1)
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
  })

  it('queues messages sent while already running, and processes all of them in order', async () => {
    const adapter = new GatedAdapter()
    const agent = newAgent(adapter)
    agent.send(userText('first'))
    await adapter.started
    expect(agent.status).toBe('running')
    agent.send(userText('second')) // queued: drain() is still inside the first turn
    adapter.open() // release the gate -- first turn can now finish, then second turn will run
    await agent.whenIdle()

    expect(agent.records).toHaveLength(2)
    expect(agent.records[0]!.userMessage).toEqual(userText('first'))
    expect(agent.records[1]!.userMessage).toEqual(userText('second'))
    expect(agent.records.every((r) => r.stopReason.kind === 'completed')).toBe(true)
  })

  it('whenIdle does not resolve until ALL queued turns (including ones sent mid-drain) are done', async () => {
    const adapter = new GatedAdapter()
    const agent = newAgent(adapter)
    agent.send(userText('first'))
    await adapter.started
    agent.send(userText('second'))

    let resolved = false
    const idlePromise = agent.whenIdle().then(() => {
      resolved = true
    })
    adapter.open()
    await idlePromise
    expect(resolved).toBe(true)
    expect(agent.records).toHaveLength(2)
  })
})

describe('Agent: cancellation', () => {
  it('cancel() aborts a turn that is genuinely mid-flight and records the cause', async () => {
    const adapter = new GatedAdapter()
    const agent = newAgent(adapter)
    agent.send(userText('hi'))
    await adapter.started
    expect(agent.status).toBe('running')

    const cause: AgentCancelCause = { kind: 'user' }
    agent.cancel(cause)
    await agent.whenIdle()

    expect(agent.records).toHaveLength(1)
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'cancelled' })
    expect(agent.records[0]!.cancelCause).toEqual(cause)
  })

  it('cancel() clears queued messages by default', async () => {
    const adapter = new GatedAdapter()
    const agent = newAgent(adapter)
    agent.send(userText('first'))
    await adapter.started
    agent.send(userText('second'))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    // Only the in-flight turn produces a record; "second" never got a chance to run.
    expect(agent.records).toHaveLength(1)
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'cancelled' })
  })

  it('cancel() with keepInbox:true leaves queued messages to run afterward', async () => {
    const adapter = new GatedAdapter()
    const agent = newAgent(adapter)
    agent.send(userText('first'))
    await adapter.started
    agent.send(userText('second'))
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    // The gate is shared by the adapter instance across calls: "first" was aborted without
    // ever needing it opened, but "second" will make its own stream() call against the same
    // never-yet-released gate, so it must be opened for the second turn to complete.
    adapter.open()
    await agent.whenIdle()

    // "first" was cancelled, but "second" was kept in the inbox and should have run to
    // completion against a fresh (non-aborted) controller once drain moved on to it.
    expect(agent.records).toHaveLength(2)
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'cancelled' })
    expect(agent.records[1]!.stopReason).toEqual({ kind: 'completed' })
  })
})

describe('Agent: steer()', () => {
  it('lands in the next step, not the one already in flight', async () => {
    const adapter = new GatedThenToolCallAdapter()
    const registry = new ToolRegistry()
    registry.define(echoTool())
    const agent = new Agent({ adapter, tools: registry, provider: 'fake', model: 'x' })
    const steered = userText('steered: focus on the auth module')

    agent.send(userText('go'))
    await adapter.started // step 1's request is already dispatched and in flight

    agent.steer(steered)
    adapter.open() // let step 1 finish; it requests a tool call, forcing a real step 2

    await agent.whenIdle()

    expect(adapter.calls).toHaveLength(2)
    expect(adapter.calls[0]!.messages).not.toContainEqual(steered) // step 1: already sent, too late
    expect(adapter.calls[1]!.messages).toContainEqual(steered) // step 2: picked up at the boundary
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
  })

  it('does not wake an idle driver by itself', () => {
    const adapter = new InstantAdapter()
    const agent = newAgent(adapter)

    agent.steer(userText('nobody is listening yet'))

    expect(agent.status).toBe('idle')
    expect(adapter.callCount).toBe(0)
  })
})

describe('Agent: dispose', () => {
  it('is idempotent and blocks further send() calls', async () => {
    const agent = newAgent(new InstantAdapter())
    await agent.dispose()
    await expect(agent.dispose()).resolves.toBeUndefined() // second call: no-op, does not throw
    expect(() => agent.send(userText('too late'))).toThrow()
  })

  it('waits for an in-flight turn to finish draining before resolving', async () => {
    const adapter = new GatedAdapter()
    const agent = newAgent(adapter)
    agent.send(userText('hi'))
    await adapter.started

    // dispose() cancels the turn, which rejects the adapter's gated promise immediately (no
    // need to call open()) -- but dispose() must still wait for drain()'s await chain to
    // actually settle and record the outcome before its own promise resolves.
    await agent.dispose()
    expect(agent.records).toHaveLength(1)
    expect(agent.records[0]!.stopReason).toEqual({ kind: 'cancelled' })
    expect(agent.status).toBe('idle')
  })

  it('status stays "running" until the dispose() promise itself resolves, not before', async () => {
    const adapter = new GatedAdapter()
    const agent = newAgent(adapter)
    agent.send(userText('hi'))
    await adapter.started

    const disposePromise = agent.dispose()
    // Checked synchronously, before awaiting disposePromise: dispose() has only run up to its
    // own first await (`await this.runLoopPromise`) at this point -- drain() hasn't had a chance
    // to observe the abort and actually unwind yet.
    expect(agent.status).toBe('running')

    await disposePromise
    expect(agent.status).toBe('idle')
  })
})

describe('Agent: repeated cancel/send races produce no dangling state', () => {
  it('pattern 1 — send() immediately followed by cancel(): 100 rounds, no duplicate or missing terminal records', async () => {
    for (let i = 0; i < 100; i++) {
      const adapter = new InstantAdapter()
      const agent = newAgent(adapter)
      agent.send(userText(`race-${i}`))
      // Fire cancel() without waiting -- sometimes it lands before the turn starts, sometimes
      // after it has already completed (InstantAdapter resolves fast). Either way the agent
      // must end up idle with a consistent, single-record-per-turn history.
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      expect(agent.status).toBe('idle')
      expect(agent.records.length).toBeLessThanOrEqual(1)
      await agent.dispose()
    }
  })

  it('pattern 2 — cancel() after adapter.started: 100 rounds, guaranteed to land on a genuinely in-flight turn', async () => {
    for (let i = 0; i < 100; i++) {
      const adapter = new GatedAdapter()
      const agent = newAgent(adapter)
      agent.send(userText(`race-${i}`))
      // Unlike pattern 1, this is not racy: `started` only resolves once the adapter's request
      // body has actually begun (Day6 study.md's GatedAdapter note), so cancel() here always
      // hits a real in-flight activity, never a not-yet-started or already-finished one.
      await adapter.started
      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      expect(agent.status).toBe('idle')
      expect(agent.records).toHaveLength(1)
      expect(agent.records[0]!.stopReason).toEqual({ kind: 'cancelled' })
      expect(agent.records[0]!.cancelCause).toEqual({ kind: 'user' })
      await agent.dispose()
    }
  })

  it('pattern 3 — cancel() immediately followed by send(): 100 rounds, cancelling nothing must not poison the next turn', async () => {
    for (let i = 0; i < 100; i++) {
      const adapter = new InstantAdapter()
      const agent = newAgent(adapter)
      // Nothing is running yet, so this cancel() has nothing to cancel -- it must be a harmless
      // no-op (this exercises `currentCancelCause` getting reset at the top of drain()'s loop,
      // not leaking a stale cause from before any turn ever started onto the turn send() is
      // about to queue).
      agent.cancel({ kind: 'user' })
      agent.send(userText(`race-${i}`))
      await agent.whenIdle()
      expect(agent.status).toBe('idle')
      expect(agent.records).toHaveLength(1)
      expect(agent.records[0]!.stopReason).toEqual({ kind: 'completed' })
      expect(agent.records[0]!.cancelCause).toBeUndefined()
      await agent.dispose()
    }
  })
})
