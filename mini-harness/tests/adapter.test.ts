import { describe, expect, it } from 'vitest'
import {
  AdapterRegistry,
  DEFAULT_RETRY_POLICY,
  LlmAdapter,
  LlmError,
  classifyFinish,
  generateWithRetry,
  type GenerateOptions,
  type RetryPolicy,
} from '../src/llm/adapter.js'
import type { LlmFailureCode, StreamChunk } from '../src/llm/types.js'

/** 前 N 次调用抛出合成失败，之后成功返回一条简单文本消息。 */
class FlakyAdapter extends LlmAdapter {
  private calls = 0
  constructor(
    private readonly failTimes: number,
    private readonly failureCode: LlmFailureCode,
  ) {
    super()
  }

  async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls <= this.failTimes) {
      throw new LlmError({ code: this.failureCode, message: `synthetic failure #${this.calls}` })
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, delta: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  get callCount(): number {
    return this.calls
  }
}

const baseOptions: GenerateOptions = { provider: 'fake', model: 'fake-model-1', messages: [] }

const fastRuntime = { sleep: async () => {}, random: () => 0.5 }

describe('classifyFinish', () => {
  it('treats finish:stop with zero blocks as a retryable EMPTY_RESPONSE error', () => {
    const finish = classifyFinish(0, { kind: 'stop' })
    expect(finish).toEqual({ kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: expect.any(String) } })
  })

  it('passes through finish:stop with content unchanged', () => {
    expect(classifyFinish(2, { kind: 'stop' })).toEqual({ kind: 'stop' })
  })

  it('treats a missing finish event as a PROTOCOL_ERROR', () => {
    expect(classifyFinish(0, undefined)).toEqual({
      kind: 'error',
      failure: { code: 'PROTOCOL_ERROR', message: expect.any(String) },
    })
  })
})

describe('AdapterRegistry', () => {
  it('registers and resolves an adapter by provider name', () => {
    const registry = new AdapterRegistry()
    const adapter = new FlakyAdapter(0, 'SERVER_ERROR')
    registry.register(['fake'], adapter)
    expect(registry.resolve('fake')).toBe(adapter)
  })

  it('fails atomically when any provider in the batch is already registered', () => {
    const registry = new AdapterRegistry()
    const a = new FlakyAdapter(0, 'SERVER_ERROR')
    const b = new FlakyAdapter(0, 'SERVER_ERROR')
    registry.register(['fake-a'], a)
    expect(() => registry.register(['fake-b', 'fake-a'], b)).toThrow(LlmError)
    // fake-b must NOT have been registered either -- the whole batch failed together.
    expect(() => registry.resolve('fake-b')).toThrow(LlmError)
  })

  it('dispose() unregisters only the providers it owns, and is idempotent', () => {
    const registry = new AdapterRegistry()
    const adapter = new FlakyAdapter(0, 'SERVER_ERROR')
    const dispose = registry.register(['fake-a', 'fake-b'], adapter)
    dispose()
    expect(() => registry.resolve('fake-a')).toThrow(LlmError)
    expect(() => dispose()).not.toThrow() // second call is a no-op, not an error
  })

  it('resolving an unknown provider throws UNSUPPORTED_OPTION', () => {
    const registry = new AdapterRegistry()
    try {
      registry.resolve('nope')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(LlmError)
      expect((error as LlmError).failure.code).toBe('UNSUPPORTED_OPTION')
    }
  })
})

describe('generateWithRetry: retry behavior', () => {
  it('retries a retryable failure and succeeds once the adapter recovers', async () => {
    const adapter = new FlakyAdapter(2, 'SERVER_ERROR')
    const result = await generateWithRetry(adapter, baseOptions, DEFAULT_RETRY_POLICY, fastRuntime)
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.attempts).toBe(3)
    expect(adapter.callCount).toBe(3)
    expect(result.message.blocks).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('gives up after maxRetries and returns the final failure', async () => {
    const adapter = new FlakyAdapter(5, 'SERVER_ERROR')
    const result = await generateWithRetry(adapter, baseOptions, DEFAULT_RETRY_POLICY, fastRuntime)
    // DEFAULT_RETRY_POLICY.maxRetries === 3 -> total attempts allowed is maxRetries + 1 = 4.
    expect(result.finish.kind).toBe('error')
    expect(result.attempts).toBe(4)
    expect(adapter.callCount).toBe(4)
  })

  it('does not retry a failure code outside the retryable whitelist', async () => {
    const adapter = new FlakyAdapter(1, 'CONTEXT_WINDOW_EXCEEDED')
    const result = await generateWithRetry(adapter, baseOptions, DEFAULT_RETRY_POLICY, fastRuntime)
    expect(result.finish).toEqual({
      kind: 'error',
      failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: expect.any(String) },
    })
    expect(result.attempts).toBe(1)
    expect(adapter.callCount).toBe(1)
  })

  it('an "always" retry policy keeps retrying past what a normal policy would allow', async () => {
    const adapter = new FlakyAdapter(6, 'SERVER_ERROR')
    const alwaysPolicy: RetryPolicy = {
      mode: 'always',
      retryableCodes: ['SERVER_ERROR'],
      initialDelayMs: 1,
      maxDelayMs: 2,
      jitterRatio: 0,
    }
    const result = await generateWithRetry(adapter, baseOptions, alwaysPolicy, fastRuntime)
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.attempts).toBe(7)
  })
})

describe('generateWithRetry: cancellation never retries', () => {
  it('an already-aborted signal short-circuits before the adapter is ever called', async () => {
    const controller = new AbortController()
    controller.abort()
    const adapter = new FlakyAdapter(0, 'SERVER_ERROR')
    const result = await generateWithRetry(adapter, { ...baseOptions, signal: controller.signal }, DEFAULT_RETRY_POLICY, fastRuntime)

    expect(result.finish).toEqual({ kind: 'aborted', failure: { code: 'ABORTED', message: expect.any(String) } })
    expect(result.attempts).toBe(1)
    expect(adapter.callCount).toBe(0)
  })
})

describe('generateWithRetry: request freezing', () => {
  it('freezes the request object so later mutation attempts throw', async () => {
    const options: GenerateOptions = { provider: 'fake', model: 'x', messages: [] }
    const adapter = new FlakyAdapter(0, 'SERVER_ERROR')
    await generateWithRetry(adapter, options, DEFAULT_RETRY_POLICY, fastRuntime)

    // Without freezeRequest, nothing would stop a well-meaning piece of middleware from
    // patching `options.model` in place between "we logged this request" and "we actually
    // sent it" -- the persisted log and the real outbound call would silently diverge, and
    // a bug report saying "it used model X" would be unverifiable after the fact.
    expect(() => {
      ;(options as { model: string }).model = 'y'
    }).toThrow(TypeError)
  })
})

describe('generateWithRetry: backoff grows exponentially', () => {
  it('records delays that roughly double between attempts', async () => {
    const delays: number[] = []
    const adapter = new FlakyAdapter(3, 'SERVER_ERROR')
    const policy: RetryPolicy = {
      mode: 'normal',
      maxRetries: 3,
      retryableCodes: ['SERVER_ERROR'],
      initialDelayMs: 100,
      maxDelayMs: 10_000,
      jitterRatio: 0, // disable jitter so growth is exact and assertable
    }
    await generateWithRetry(adapter, baseOptions, policy, {
      sleep: async (ms) => {
        delays.push(ms)
      },
      random: () => 0.5,
    })

    expect(delays).toEqual([100, 200, 400])
  })
})
