import { LlmAdapter, type GenerateOptions } from './llm/adapter.js'
import { streamFake } from './llm/fake-adapter.js'
import type { FinishReason, Message, StreamChunk, ToolResultBlock } from './llm/types.js'

/**
 * 一个**不连真实模型**的演示用适配器：按固定策略调用 list_files -> search_text ->
 * 产出带证据的文本总结。它不是"智能"的（不会真的理解 goal 文本），但它会真实地
 * 根据 list_files/search_text 的实际返回结果来组织最终总结，所以指向不同的工作区
 * 会得到不同的结论——足够用来演示"Agent 自主使用工具并输出带证据的结论"这条 Day7
 * 验收标准，而不需要绑定任何真实模型供应商。
 *
 * 接入真实模型：把这个类换成你自己写的、实现了 `LlmAdapter.stream()` 的适配器
 * （Day3 的练习）即可，`Agent`/`runTurn` 不需要改一行代码——这正是 Day3 讲的
 * "Agent loop 不认识任何具体 provider" 的意义所在。
 */
export class HeuristicInvestigationAdapter extends LlmAdapter {
  private step = 0

  constructor(private readonly searchQuery: string) {
    super()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.step += 1
    const message = this.decide(options)
    const hasToolCall = message.blocks.some((b) => b.type === 'tool-call')
    const finishReason: FinishReason = hasToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
    yield* streamFake({ message, finishReason })
  }

  private decide(options: GenerateOptions): Message {
    if (this.step === 1) {
      return toolCall('call-list', 'list_files', {})
    }
    if (this.step === 2) {
      return toolCall('call-search', 'search_text', { query: this.searchQuery })
    }
    return { role: 'assistant', blocks: [{ type: 'text', text: summarize(options.messages, this.searchQuery) }] }
  }
}

function toolCall(id: string, name: string, args: unknown): Message {
  return { role: 'assistant', blocks: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] }
}

function collectToolResults(messages: readonly Message[]): readonly ToolResultBlock[] {
  const results: ToolResultBlock[] = []
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const block of message.blocks) {
      if (block.type === 'tool-result') results.push(block)
    }
  }
  return results
}

function summarize(messages: readonly Message[], searchQuery: string): string {
  const results = collectToolResults(messages)
  const listResult = results[0]
  const searchResult = results[1]

  const lines: string[] = [`Investigation for "${searchQuery}":`]
  if (listResult && !listResult.isError) {
    lines.push(`- workspace listing: ${listResult.content.split('\n')[0]}`)
  }
  if (searchResult) {
    if (searchResult.isError) {
      lines.push(`- search failed: ${searchResult.content}`)
    } else if (searchResult.content.startsWith('no matches')) {
      lines.push(`- no evidence found for "${searchQuery}"; conclusion is inconclusive`)
    } else {
      const matchLines = searchResult.content.split('\n').filter((l) => l.includes(':'))
      lines.push(`- found ${matchLines.length} matching line(s), evidence:`)
      for (const line of matchLines.slice(0, 10)) lines.push(`  ${line}`)
    }
  }
  return lines.join('\n')
}
