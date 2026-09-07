import { resolve } from 'node:path'
import { Agent, type TurnRecord } from './core/agent-handle.js'
import { HeuristicInvestigationAdapter } from './heuristic-adapter.js'
import type { LlmAdapter } from './llm/adapter.js'
import type { Message } from './llm/types.js'
import { createReadOnlyFsTools } from './tools/fs-tools.js'
import { ToolRegistry } from './tools/registry.js'

export interface CliArgs {
  readonly workspace: string
  readonly goal: string
  readonly query: string
  readonly maxSteps?: number
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const workspace = get('--workspace') ?? process.cwd()
  const goal = get('--goal') ?? `search the workspace for evidence of the query`
  const query = get('--query')
  if (!query) {
    throw new Error('missing required --query <text> (what to search the workspace for)')
  }
  const maxStepsRaw = get('--max-steps')
  return {
    workspace: resolve(workspace),
    goal,
    query,
    ...(maxStepsRaw ? { maxSteps: Number(maxStepsRaw) } : {}),
  }
}

export interface InvestigationOutcome {
  readonly summary: string
  readonly record: TurnRecord
}

/**
 * 跑一次完整调查：建工具、建 Agent、发一条用户消息、等它跑完、取回最终文本 + 证据。
 * 抽成一个独立函数（而不是把逻辑全塞进 main()）是为了让 Day7 的场景测试可以直接
 * 复用它，不用去解析 stdout。
 */
export async function runInvestigation(
  args: CliArgs,
  adapterFactory: (query: string) => LlmAdapter = (q) => new HeuristicInvestigationAdapter(q),
): Promise<InvestigationOutcome> {
  const tools = new ToolRegistry()
  for (const tool of createReadOnlyFsTools(args.workspace)) tools.define(tool)

  const agent = new Agent({
    adapter: adapterFactory(args.query),
    tools,
    provider: 'demo',
    model: 'heuristic-investigator-v1',
    ...(args.maxSteps ? { loopOptions: { maxSteps: args.maxSteps } } : {}),
  })

  const userMessage: Message = { role: 'user', blocks: [{ type: 'text', text: args.goal }] }
  agent.send(userMessage)
  await agent.whenIdle()
  await agent.dispose()

  const record = agent.records[0]
  if (!record) throw new Error('investigation produced no turn record')

  const finalText = record.events
    .filter((e): e is Extract<typeof e, { type: 'model-response' }> => e.type === 'model-response')
    .map((e) => e.message.blocks.find((b) => b.type === 'text'))
    .filter((b): b is { type: 'text'; text: string } => b !== undefined)
    .at(-1)

  const summary =
    record.stopReason.kind === 'completed' && finalText
      ? finalText.text
      : `investigation did not complete normally: ${describeStopReason(record.stopReason)}`

  return { summary, record }
}

function describeStopReason(stopReason: TurnRecord['stopReason']): string {
  switch (stopReason.kind) {
    case 'completed':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
    case 'budget_exhausted':
      return `budget_exhausted (${stopReason.reason})`
    case 'error':
      return `error (${stopReason.failure.code}: ${stopReason.failure.message})`
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const outcome = await runInvestigation(args)
  console.log(outcome.summary)
  console.log(`\n[stop reason: ${describeStopReason(outcome.record.stopReason)}]`)
  if (outcome.record.stopReason.kind !== 'completed') {
    process.exitCode = 1
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
