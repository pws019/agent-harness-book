import { describe, expect, it } from 'vitest'
import { BlockAssembler } from '../src/llm/block-assembler.js'
import { streamFake } from '../src/llm/fake-adapter.js'
import type { Message } from '../src/llm/types.js'

const sampleMessage: Message = {
  role: 'assistant',
  blocks: [
    { type: 'text', text: 'Hello, 世界! Let me check that file 👋 for you.' },
    { type: 'reasoning', text: 'The user wants a file read, I should call read_file.' },
    {
      type: 'tool-call',
      id: 'call_1',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'src/index.ts', offset: 1, limit: 200 }),
    },
  ],
}

async function assemble(chunks: AsyncIterable<import('../src/llm/types.js').StreamChunk>) {
  const assembler = new BlockAssembler()
  for await (const chunk of chunks) assembler.push(chunk)
  return assembler
}

describe('BlockAssembler: assembles a message identically across 100 random chunkings', () => {
  for (let seed = 1; seed <= 100; seed++) {
    it(`seed=${seed}`, async () => {
      const assembler = await assemble(streamFake({ message: sampleMessage, seed }))
      const { blocks, finish } = assembler.result()
      expect(blocks).toEqual(sampleMessage.blocks)
      expect(finish).toEqual({ kind: 'stop' })
    })
  }

  it('holds under extreme fine-grained chunking (1 char at a time)', async () => {
    const oneCharChunker = (text: string) => text.split('')
    const assembler = await assemble(streamFake({ message: sampleMessage, chunker: oneCharChunker }))
    expect(assembler.result().blocks).toEqual(sampleMessage.blocks)
  })
})

describe('BlockAssembler: malformed stream defenses', () => {
  it('ignores deltas that arrive after the block has already been closed', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, delta: 'hello' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } })
    // Malformed: more deltas for an index that's already closed.
    assembler.push({ type: 'text-delta', index: 0, delta: ' should not appear' })

    expect(assembler.result().blocks).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('is tolerant of delta-only protocols with no block-start', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'text-delta', index: 0, delta: 'no start event' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'no start event' } })
    expect(assembler.result().blocks).toEqual([{ type: 'text', text: 'no start event' }])
  })

  it('drops incomplete tool calls when finish reason is max-tokens', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, delta: 'partial answer' })
    assembler.push({ type: 'block-start', index: 1, blockType: 'tool-call', id: 'c1', name: 'read_file' })
    assembler.push({ type: 'tool-call-delta', index: 1, argumentsDelta: '{"path": "unfinis' })
    assembler.push({ type: 'finish', reason: { kind: 'max-tokens' } })

    // Text block was never closed either, so it's absent from result() (only finish-time closed
    // blocks count there); interruptedBlocks() is what recovers the partial text.
    expect(assembler.result().blocks).toEqual([])
    const interrupted = assembler.interruptedBlocks()
    expect(interrupted).toEqual([{ type: 'text', text: 'partial answer' }])
  })
})

describe('BlockAssembler: interruption', () => {
  it('keeps closed blocks, keeps non-empty open text/reasoning blocks, drops open tool calls', () => {
    const assembler = new BlockAssembler()
    // Block 0: fully closed text block.
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, delta: 'closed text' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'closed text' } })
    // Block 1: open reasoning block with content -> should survive.
    assembler.push({ type: 'block-start', index: 1, blockType: 'reasoning' })
    assembler.push({ type: 'reasoning-delta', index: 1, delta: 'still thinking' })
    // Block 2: open tool-call block -> must be dropped.
    assembler.push({ type: 'block-start', index: 2, blockType: 'tool-call', id: 'c1', name: 'read_file' })
    assembler.push({ type: 'tool-call-delta', index: 2, argumentsDelta: '{"path": "a.ts"' })

    expect(assembler.interruptedBlocks()).toEqual([
      { type: 'text', text: 'closed text' },
      { type: 'reasoning', text: 'still thinking' },
    ])
  })

  it('discards open blocks that never received any content', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    // No delta ever arrives before interruption.
    expect(assembler.interruptedBlocks()).toEqual([])
  })

  it('returns interrupted content in original index order regardless of closed/open mix', () => {
    const assembler = new BlockAssembler()
    assembler.push({ type: 'block-start', index: 1, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 1, delta: 'open second' })
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' })
    assembler.push({ type: 'text-delta', index: 0, delta: 'closed first' })
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: 'closed first' } })

    expect(assembler.interruptedBlocks()).toEqual([
      { type: 'text', text: 'closed first' },
      { type: 'text', text: 'open second' },
    ])
  })
})

describe('fake adapter fault injection', () => {
  it('cut-mid-utf8: stream ends without block-end after a split surrogate pair', async () => {
    const fullText = 'emoji test 👋 done'
    const message: Message = { role: 'assistant', blocks: [{ type: 'text', text: fullText }] }
    const assembler = await assemble(streamFake({ message, faultMode: { kind: 'cut-mid-utf8' } }))
    expect(assembler.result().finish).toBeUndefined()
    const interrupted = assembler.interruptedBlocks()
    expect(interrupted).toEqual([{ type: 'text', text: expect.any(String) }])
    const partialText = (interrupted[0] as { text: string }).text
    expect(partialText.length).toBeGreaterThan(0)
    expect(partialText.length).toBeLessThan(fullText.length)
  })

  it('cut-mid-json: incomplete tool-call arguments are discarded on interruption', async () => {
    const message: Message = {
      role: 'assistant',
      blocks: [{ type: 'tool-call', id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'a.ts' }) }],
    }
    const assembler = await assemble(streamFake({ message, faultMode: { kind: 'cut-mid-json' } }))
    expect(assembler.interruptedBlocks()).toEqual([])
  })

  it('empty-response: finish stop with zero content blocks must be treated as retryable, not success', async () => {
    const message: Message = { role: 'assistant', blocks: [{ type: 'text', text: 'unused' }] }
    const assembler = await assemble(streamFake({ message, faultMode: { kind: 'empty-response' } }))
    const { blocks, finish } = assembler.result()
    expect(blocks).toEqual([])
    expect(finish).toEqual({ kind: 'stop' })
    // Assembler only reports facts; classifying "empty + stop" as retryable is the adapter/loop's
    // job (Day3's classifyFinish). This assertion documents the raw fact the classifier consumes.
    expect(blocks.length === 0 && finish?.kind === 'stop').toBe(true)
  })

  it('duplicate-finish: second finish event does not corrupt the first result', async () => {
    const message: Message = { role: 'assistant', blocks: [{ type: 'text', text: 'ok' }] }
    const assembler = await assemble(streamFake({ message, faultMode: { kind: 'duplicate-finish' } }))
    expect(assembler.result().finish).toEqual({ kind: 'stop' })
    expect(assembler.result().blocks).toEqual([{ type: 'text', text: 'ok' }])
  })
})
