import { assertNever, type ContentBlock, type FinishReason, type StreamChunk, type TokenUsage } from './types.js'

interface OpenBlock {
  readonly index: number
  readonly type: ContentBlock['type']
  readonly id?: string
  readonly name?: string
  text: string
  argumentsRaw: string
}

export interface AssembledResult {
  readonly blocks: readonly ContentBlock[]
  readonly usage?: TokenUsage
  readonly finish?: FinishReason
}

/**
 * 唯一共享的组装实现：把散乱到达的 StreamChunk 折叠回完整的 ContentBlock 列表、
 * usage 和 finish reason。
 *
 * 设计要点（对应 study.md）：
 * 1. 容忍 delta-only 协议——没有 block-start 也能通过第一条 delta 隐式开一个块。
 * 2. 已被 block-end 关闭的 index 再收到 delta，一律忽略（畸形流的安全阀）。
 * 3. block-end 携带的完整 ContentBlock 才是权威内容，累积的 delta 只用于
 *    "流还没结束时，我们目前手上有什么"（interruptedBlocks）。
 */
export class BlockAssembler {
  private readonly open = new Map<number, OpenBlock>()
  private readonly closedOrder: number[] = []
  private readonly closedBlocks = new Map<number, ContentBlock>()
  private readonly closedIndices = new Set<number>()
  private usage: TokenUsage | undefined
  private finish: FinishReason | undefined

  push(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        if (this.closedIndices.has(chunk.index)) return
        this.open.set(chunk.index, {
          index: chunk.index,
          type: chunk.blockType,
          id: chunk.id,
          name: chunk.name,
          text: '',
          argumentsRaw: '',
        })
        return
      }
      case 'text-delta': {
        this.appendDelta(chunk.index, chunk.delta, 'text')
        return
      }
      case 'reasoning-delta': {
        this.appendDelta(chunk.index, chunk.delta, 'reasoning')
        return
      }
      case 'tool-call-delta': {
        if (this.closedIndices.has(chunk.index)) return
        const block = this.getOrOpenImplicit(chunk.index, 'tool-call')
        block.argumentsRaw += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        if (this.closedIndices.has(chunk.index)) return
        this.open.delete(chunk.index)
        this.closedIndices.add(chunk.index)
        this.closedOrder.push(chunk.index)
        this.closedBlocks.set(chunk.index, chunk.block)
        return
      }
      case 'usage': {
        this.usage = chunk.usage
        return
      }
      case 'finish': {
        this.finish = chunk.reason
        if (chunk.reason.kind === 'max-tokens') {
          this.dropIncompleteToolCalls()
        }
        return
      }
      default:
        return assertNever(chunk)
    }
  }

  /** 流正常结束（收到过 finish）之后的最终结果。 */
  result(): AssembledResult {
    const blocks = this.closedOrder.map((index) => this.closedBlocks.get(index)!)
    return { blocks, usage: this.usage, finish: this.finish }
  }

  /**
   * 流被中断（取消/断线）时，返回当前可以安全使用的内容：
   * - 已闭合的块原样保留。
   * - 未闭合但非空的 text/reasoning 块保留（半句话也比没有强）。
   * - 未闭合的 tool-call 块一律丢弃（半份参数没法安全执行，留着只会制造歧义）。
   * 按原始 index 顺序返回，不管块是通过闭合还是中断路径拿到的。
   */
  interruptedBlocks(): readonly ContentBlock[] {
    const byIndex = new Map<number, ContentBlock>()
    for (const index of this.closedOrder) {
      byIndex.set(index, this.closedBlocks.get(index)!)
    }
    for (const block of this.open.values()) {
      if (block.type === 'tool-call') continue
      if (block.text.length === 0) continue
      if (block.type === 'text') {
        byIndex.set(block.index, { type: 'text', text: block.text })
      } else if (block.type === 'reasoning') {
        byIndex.set(block.index, { type: 'reasoning', text: block.text })
      }
      // 未知/其它类型的未闭合块（比如中断发生在 block-start 刚到、类型还没来得及处理）一律丢弃。
    }
    return [...byIndex.keys()].sort((a, b) => a - b).map((index) => byIndex.get(index)!)
  }

  private appendDelta(index: number, delta: string, kind: 'text' | 'reasoning'): void {
    if (this.closedIndices.has(index)) return
    const block = this.getOrOpenImplicit(index, kind)
    block.text += delta
  }

  private getOrOpenImplicit(index: number, kind: ContentBlock['type']): OpenBlock {
    let block = this.open.get(index)
    if (!block) {
      block = { index, type: kind, text: '', argumentsRaw: '' }
      this.open.set(index, block)
    }
    return block
  }

  private dropIncompleteToolCalls(): void {
    for (const [index, block] of this.open) {
      if (block.type === 'tool-call') this.open.delete(index)
    }
  }
}
