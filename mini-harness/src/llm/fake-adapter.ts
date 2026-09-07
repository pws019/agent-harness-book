import type { ContentBlock, FinishReason, Message, StreamChunk, TokenUsage } from './types.js'

export type FaultMode =
  | { readonly kind: 'none' }
  /** 在文本的一个多字节字符中间断流（不发 block-end，直接结束 iterable）。 */
  | { readonly kind: 'cut-mid-utf8' }
  /** 在工具调用参数 JSON 中间断流。 */
  | { readonly kind: 'cut-mid-json' }
  /** 一个内容块都不发，直接吐一个 finish: stop —— 模拟"空 completion"。 */
  | { readonly kind: 'empty-response' }
  /** 正常结束之后，再多发一次 finish 事件。 */
  | { readonly kind: 'duplicate-finish' }

export interface FakeAdapterOptions {
  readonly message: Message
  readonly usage?: TokenUsage
  readonly finishReason?: FinishReason
  /** 自定义分片函数，默认是长度 1~5 的随机分片。 */
  readonly chunker?: (text: string, rand: () => number) => string[]
  readonly seed?: number
  readonly faultMode?: FaultMode
}

/** 确定性的小型 PRNG（mulberry32），保证同一个 seed 每次跑出同样的分片方式，方便写属性测试。 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function defaultChunker(text: string, rand: () => number): string[] {
  if (text.length === 0) return []
  const pieces: string[] = []
  let i = 0
  while (i < text.length) {
    const remaining = text.length - i
    const size = Math.max(1, Math.floor(rand() * Math.min(5, remaining)) + 1)
    pieces.push(text.slice(i, i + size))
    i += size
  }
  return pieces
}

/** 找一个高位代理项（astral 字符的前半），在它后面切一刀，模拟"断在多字节字符中间"。 */
function cutMidCodepoint(text: string): string[] {
  for (let i = 0; i < text.length - 1; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      return [text.slice(0, i + 1)]
    }
  }
  const mid = Math.max(1, Math.floor(text.length / 2))
  return [text.slice(0, mid)]
}

function cutMidJson(argumentsJson: string): string[] {
  const cut = Math.max(1, Math.min(argumentsJson.length - 1, Math.floor(argumentsJson.length * 0.6)))
  return [argumentsJson.slice(0, cut)]
}

function idAndName(block: ContentBlock): { id?: string; name?: string } {
  return block.type === 'tool-call' ? { id: block.id, name: block.name } : {}
}

/**
 * 一个不连真实模型、只按配置的分片策略把一条完整 Message 拆成 StreamChunk 流的假 adapter。
 * 用来在没有真实 provider 的情况下测试 BlockAssembler 和上层消费逻辑。
 */
export async function* streamFake(options: FakeAdapterOptions): AsyncIterable<StreamChunk> {
  const rand = mulberry32(options.seed ?? 1)
  const chunker = options.chunker ?? defaultChunker
  const fault = options.faultMode ?? { kind: 'none' }

  if (fault.kind === 'empty-response') {
    yield { type: 'finish', reason: { kind: 'stop' } }
    return
  }

  const blocks = options.message.blocks
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!
    yield { type: 'block-start', index, blockType: block.type, ...idAndName(block) }

    const isLastBlock = index === blocks.length - 1
    const truncateHere =
      isLastBlock && (fault.kind === 'cut-mid-utf8' || fault.kind === 'cut-mid-json')

    if (block.type === 'text' || block.type === 'reasoning') {
      const pieces =
        truncateHere && fault.kind === 'cut-mid-utf8' ? cutMidCodepoint(block.text) : chunker(block.text, rand)
      for (const piece of pieces) {
        yield block.type === 'text'
          ? { type: 'text-delta', index, delta: piece }
          : { type: 'reasoning-delta', index, delta: piece }
      }
    } else if (block.type === 'tool-call') {
      const pieces =
        truncateHere && fault.kind === 'cut-mid-json' ? cutMidJson(block.arguments) : chunker(block.arguments, rand)
      for (const piece of pieces) {
        yield { type: 'tool-call-delta', index, argumentsDelta: piece }
      }
    }

    if (truncateHere) return // 模拟连接在此处断开：没有 block-end，没有 finish

    yield { type: 'block-end', index, block }
  }

  if (options.usage) yield { type: 'usage', usage: options.usage }
  const finishReason = options.finishReason ?? { kind: 'stop' as const }
  yield { type: 'finish', reason: finishReason }

  if (fault.kind === 'duplicate-finish') {
    yield { type: 'finish', reason: finishReason }
  }
}
