import { afterEach, describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/core/agent-handle.js'
import { scheduleReminder } from '../src/core/reminder.js'
import { LlmAdapter } from '../src/llm/adapter.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { Message, StreamChunk } from '../src/llm/types.js'
import { ToolRegistry } from '../src/tools/registry.js'

class InstantAdapter extends LlmAdapter {
  async *stream(): AsyncIterable<StreamChunk> {
    yield* streamFake({ message: { role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }, finishReason: { kind: 'stop' } })
  }
}

function reminderText(text: string): Message {
  return { role: 'user', blocks: [{ type: 'text', text }] }
}

function makeAgent(): Agent {
  return new Agent({ adapter: new InstantAdapter(), tools: new ToolRegistry(), provider: 'demo', model: 'instant' })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('scheduleReminder: a thin wrapper over Agent.steer(), nothing more', () => {
  it('calls agent.steer() with the given message once the delay elapses', async () => {
    vi.useFakeTimers()
    const agent = makeAgent()
    const steerSpy = vi.spyOn(agent, 'steer')
    const message = reminderText('reminder: check back in on this')

    scheduleReminder(agent, message, 1_000)
    expect(steerSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)
    expect(steerSpy).toHaveBeenCalledTimes(1)
    expect(steerSpy).toHaveBeenCalledWith(message)
    await agent.dispose()
  })

  it('dispose() before the delay elapses cancels it — steer() is never called', async () => {
    vi.useFakeTimers()
    const agent = makeAgent()
    const steerSpy = vi.spyOn(agent, 'steer')

    const reminder = scheduleReminder(agent, reminderText('x'), 1_000)
    reminder.dispose()
    vi.advanceTimersByTime(2_000)

    expect(steerSpy).not.toHaveBeenCalled()
    await agent.dispose()
  })

  it('dispose() after it already fired is a harmless no-op', async () => {
    vi.useFakeTimers()
    const agent = makeAgent()
    const steerSpy = vi.spyOn(agent, 'steer')

    const reminder = scheduleReminder(agent, reminderText('x'), 1_000)
    vi.advanceTimersByTime(1_000)
    expect(steerSpy).toHaveBeenCalledTimes(1)

    expect(() => reminder.dispose()).not.toThrow()
    await agent.dispose()
  })
})
