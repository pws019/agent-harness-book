import { resolve } from 'node:path'
import { Agent, type TurnRecord } from './core/agent-handle.js'
import { FileRawStore, JsonlSessionStore } from './core/persistence.js'
import { deriveMessages } from './core/session.js'
import { deriveTitle, projectSummary } from './core/session-projection.js'
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
  /** Day14：给了这个路径，调查过程会持久化到这个文件，下次指向同一个文件会从中断处续上。 */
  readonly sessionFile?: string
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
  const sessionFile = get('--session-file')
  return {
    workspace: resolve(workspace),
    goal,
    query,
    ...(maxStepsRaw ? { maxSteps: Number(maxStepsRaw) } : {}),
    ...(sessionFile ? { sessionFile: resolve(sessionFile) } : {}),
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
 *
 * Day14：如果 `args.sessionFile` 给了路径，这次调查会持久化——文件不存在就新建一份
 * 干净的 session，文件已经存在就先 `load()` 再 `Agent.restore()`，从上次中断的地方
 * 接着跑（`send()` 的新用户消息会开一个编号接着算的新 turn，不会跟旧的撞车）。
 */
export async function runInvestigation(
  args: CliArgs,
  adapterFactory: (query: string) => LlmAdapter = (q) => new HeuristicInvestigationAdapter(q),
): Promise<InvestigationOutcome> {
  const tools = new ToolRegistry()
  for (const tool of createReadOnlyFsTools(args.workspace)) tools.define(tool)

  const deps = {
    adapter: adapterFactory(args.query),
    tools,
    provider: 'demo',
    model: 'heuristic-investigator-v1',
    ...(args.maxSteps ? { loopOptions: { maxSteps: args.maxSteps } } : {}),
  }

  const userMessage: Message = { role: 'user', blocks: [{ type: 'text', text: args.goal }] }

  let agent: Agent
  if (args.sessionFile) {
    const fileExists = FileRawStore.exists(args.sessionFile)
    const raw = new FileRawStore(args.sessionFile)
    if (fileExists) {
      const { events, truncated } = JsonlSessionStore.open(raw).load()
      if (truncated) {
        console.error(`[session ${args.sessionFile} was interrupted mid-write; resuming from the last complete event]`)
      }
      agent = Agent.restore({ ...deps, sink: JsonlSessionStore.open(raw) }, events)
    } else {
      agent = new Agent({ ...deps, sink: JsonlSessionStore.create(raw) })
    }
  } else {
    agent = new Agent(deps)
  }

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

/** `pnpm cli -- inspect-session <path>`：不重放对话，只打印一份人类可读的概览。 */
function inspectSession(path: string): void {
  const { events, truncated } = JsonlSessionStore.open(new FileRawStore(resolve(path))).load()
  const summary = projectSummary(events)
  const title = deriveTitle(events)
  console.log(`session: ${path}`)
  console.log(`truncated (crashed mid-write): ${truncated}`)
  console.log(`title: ${title ? `"${title.title}" (from seq ${title.sourceSeq})` : '(no user message yet)'}`)
  console.log(`turns: ${summary.turnCount}`)
  console.log(`last stop reason: ${summary.lastStopReason ? JSON.stringify(summary.lastStopReason) : '(turn still open)'}`)
  if (summary.previousStopReason?.kind === 'cancelled') {
    console.log('这份会话上一次是被中断的（可能是进程崩溃），最新一轮调查已经补上了')
  }
  console.log(`tool calls by name: ${JSON.stringify(summary.toolCallCountByName)}`)
  console.log(`total events on disk: ${events.length}`)
}

/** `pnpm cli -- replay-session <path>`：打印 deriveMessages() 派生出的完整对话文本。 */
function replaySession(path: string): void {
  const { events } = JsonlSessionStore.open(new FileRawStore(resolve(path))).load()
  const messages = deriveMessages(events)
  for (const message of messages) {
    const text = message.blocks
      .map((block) => {
        if (block.type === 'text' || block.type === 'reasoning') return block.text
        if (block.type === 'tool-call') return `[tool-call ${block.name}(${block.arguments})]`
        return `[tool-result ${block.isError ? 'ERROR' : 'ok'}: ${block.content}]`
      })
      .join(' ')
    console.log(`${message.role}: ${text}`)
  }
}

async function main(): Promise<void> {
  // pnpm cli -- <args> 有的版本会把这个 `--` 原样转发给 tsx（不像我们在 Day7 study.md
  // §0 讲的那样被吃掉），子命令判断必须先把它剥掉，不然 `argv[0]` 是 `'--'` 而不是
  // 真正的子命令名，`inspect-session`/`replay-session` 会被误判成走 parseArgs() 那条
  // 默认调查路径，报出一个跟用户实际输入毫不相关的"缺少 --query"错误。只剥开头那一个，
  // 不是全局过滤——`--` 理论上也可能是某个 flag 的合法取值的一部分。
  const rawArgv = process.argv.slice(2)
  const argv = rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv

  if (argv[0] === 'inspect-session') {
    const path = argv[1]
    if (!path) throw new Error('usage: inspect-session <path>')
    inspectSession(path)
    return
  }
  if (argv[0] === 'replay-session') {
    const path = argv[1]
    if (!path) throw new Error('usage: replay-session <path>')
    replaySession(path)
    return
  }

  const args = parseArgs(argv)
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
