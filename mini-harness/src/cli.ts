import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { join, resolve } from 'node:path'
import { Agent, type AgentDeps, type TurnRecord } from './core/agent-handle.js'
import { ApprovalStore, type ApprovalRequest } from './core/approval.js'
import { DelegationBudget } from './core/delegation-budget.js'
import { createAutonomousPreset, createBalancedPreset, createReadonlyPreset, type PermissionPreset } from './core/permission-presets.js'
import { FileRawStore, JsonlSessionStore } from './core/persistence.js'
import { deriveMessages } from './core/session.js'
import { deriveTitle, projectSummary } from './core/session-projection.js'
import { SubagentManager } from './core/subagent.js'
import { buildWorkflowFromScript, WorkflowRunner } from './core/workflow-runner.js'
import { collectAgentIds } from './core/workflow-types.js'
import { runGraduationDemo } from './graduation-demo.js'
import { HeuristicInvestigationAdapter } from './heuristic-adapter.js'
import type { LlmAdapter } from './llm/adapter.js'
import type { Message } from './llm/types.js'
import { proposeEdit, type ProposeEditOutcome } from './propose-edit.js'
import { createReadOnlyFsTools } from './tools/fs-tools.js'
import { ToolRegistry } from './tools/registry.js'

/** Day21：`propose-edit` 的 preset 只用来判断 `edit_file` 这一个动作,这份只读工具名单
 * 跟 `createReadOnlyFsTools()` 实际注册的名字保持一致（Day4 引入的三个只读工具）。 */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(['read_file', 'list_files', 'search_text'])

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

function presetByName(name: string | undefined): PermissionPreset | undefined {
  switch (name) {
    case undefined:
      return undefined
    case 'readonly':
      return createReadonlyPreset(READ_ONLY_TOOL_NAMES)
    case 'balanced':
      return createBalancedPreset(READ_ONLY_TOOL_NAMES)
    case 'autonomous':
      return createAutonomousPreset()
    default:
      throw new Error(`unknown --preset "${name}" (expected readonly|balanced|autonomous)`)
  }
}

/** 默认的人工审批实现：真的在终端里问一句。测试/脚本化场景应该直接给 `proposeEdit()`
 * 传别的 `requestApproval` 回调，不需要伪造键盘输入。 */
async function promptApproval(request: ApprovalRequest, diff: string): Promise<boolean> {
  console.log(`\n--- approval requested: ${request.action} "${request.target}" (expires in ${Math.round((request.expiresAt - Date.now()) / 1000)}s) ---`)
  console.log(diff)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question('approve? [y/N] ')
    return answer.trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

function printProposeEditOutcome(outcome: ProposeEditOutcome): void {
  switch (outcome.kind) {
    case 'no-changes':
      console.log('no changes: the --find text was not present in the file, nothing to do')
      break
    case 'denied':
      console.log(`edit denied (nonce ${outcome.request.nonce}); nothing was written`)
      console.log(outcome.diff)
      break
    case 'applied':
      console.log(`edit applied, newHash: ${outcome.newHash}`)
      console.log(outcome.diff)
      if (outcome.verification) {
        console.log(`\nverification ${outcome.verification.passed ? 'passed' : 'FAILED'} (exit code ${outcome.verification.exitCode})`)
        console.log(outcome.verification.output)
      }
      break
  }
}

/**
 * 里程碑三：`pnpm cli -- propose-edit --workspace <dir> --file <path> --find <text> --replace <text>`。
 * 把 Day15 `edit_file`、Day16 `run_command`、Day19 `ApprovalStore`/权限预设第一次接进一条
 * 真实可跑的命令——细节见 `src/propose-edit.ts` 和 `modules/day21-milestone-secure-agent/study.md`。
 */
async function runProposeEditCommand(argv: readonly string[]): Promise<void> {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const workspace = resolve(get('--workspace') ?? process.cwd())
  const file = get('--file')
  const find = get('--find')
  const replace = get('--replace')
  if (!file || find === undefined || replace === undefined) {
    throw new Error(
      'usage: propose-edit --workspace <dir> --file <path> --find <text> --replace <text> ' +
        '[--preset readonly|balanced|autonomous] [--verify-command <cmd>] [--verify-args "arg1 arg2"]',
    )
  }
  const preset = presetByName(get('--preset'))
  const verifyCommand = get('--verify-command')
  const verifyArgsRaw = get('--verify-args')
  const verify = verifyCommand ? { command: verifyCommand, args: verifyArgsRaw ? verifyArgsRaw.split(' ') : [] } : undefined

  const outcome = await proposeEdit({
    root: workspace,
    filePath: file,
    find,
    replace,
    approvalStore: new ApprovalStore(),
    requestApproval: promptApproval,
    preset,
    verify,
  })

  printProposeEditOutcome(outcome)
  if (outcome.kind !== 'applied') process.exitCode = 1
}

/**
 * 阶段四里程碑：`pnpm cli -- run-workflow --workspace <dir> --script <path> --query <text>
 * [--max-agents <n>] [--force-cancel-after-ms <n>]`。把 Day22-26 各自独立建好的每一块
 * 第一次串成一条真正能跑的命令——`--script` 指向的文件是一段普通 JS 源码，最后一句
 * 调用 Day27 的 `agent()`/`parallel()`/`pipeline()`/`phase()` 拼出一棵计划树,经
 * `buildWorkflowFromScript()`（Day25 `CodeRuntime`）跑出树本身,再交给
 * `WorkflowRunner`（内部用 Day26 `SubagentManager`）真正执行。
 *
 * 诚实的简化：这条命令里,树上每一个 `agentId` 最终都对应同一种 `HeuristicInvestigationAdapter`
 * worker——都指向同一个 `--workspace`、同一个 `--query`,不同 `agentId` 之间不切换模型
 * 或工具集。区分它们的只是脚本里附加的 `task` 文本标签（主要起标注作用，
 * `HeuristicInvestigationAdapter` 本身不读它）。这是这门课"零新依赖、不接真实模型"这条线
 * 延续到 Day27 的必然结果，不是遗漏——脚本要选不同的 worker,只需要把 `agentId` 换成
 * 不同的字符串,`registry` 那一步自然会各建一份独立的 `Agent`/`Session`。
 */
async function runWorkflowCommand(argv: readonly string[]): Promise<void> {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const workspace = resolve(get('--workspace') ?? process.cwd())
  const scriptPath = get('--script')
  const query = get('--query')
  if (!scriptPath || !query) {
    throw new Error(
      'usage: run-workflow --workspace <dir> --script <path> --query <text> [--max-agents <n>] [--force-cancel-after-ms <n>]',
    )
  }
  const maxAgentsRaw = get('--max-agents')
  const maxAgents = maxAgentsRaw ? Number(maxAgentsRaw) : 10
  const forceCancelAfterMsRaw = get('--force-cancel-after-ms')

  const source = await readFile(resolve(scriptPath), 'utf8')
  const tree = buildWorkflowFromScript(source)

  const registry = new Map<string, Omit<AgentDeps, 'sink'>>(
    collectAgentIds(tree).map((agentId) => {
      const tools = new ToolRegistry()
      for (const tool of createReadOnlyFsTools(workspace)) tools.define(tool)
      return [agentId, { adapter: new HeuristicInvestigationAdapter(query), tools, provider: 'demo', model: 'heuristic-investigator-v1' }]
    }),
  )

  const budget = new DelegationBudget({ maxConcurrent: registry.size, maxTotalChildren: registry.size, maxDepth: 1 })
  const manager = new SubagentManager(budget)
  const runner = new WorkflowRunner(manager, registry)

  const state = await runner.run(tree, {
    maxAgents,
    ...(forceCancelAfterMsRaw ? { forceCancelAfterMs: Number(forceCancelAfterMsRaw) } : {}),
  })

  console.log(JSON.stringify(state, null, 2))
  if (state.kind !== 'completed') process.exitCode = 1
}

/**
 * 阶段五里程碑（全课程毕业演示）：`pnpm cli -- graduation-demo --workspace <dir> --query <text>`。
 * 把 Day1-29 各自独立建好的每一块，第一次真的串成大纲原文那条完整叙事跑一遍——
 * 细节见 `src/graduation-demo.ts` 和 `modules/day30-milestone-graduation/README.md`。
 */
async function runGraduationDemoCommand(argv: readonly string[]): Promise<void> {
  const get = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const workspace = resolve(get('--workspace') ?? join(process.cwd(), '.graduation-demo'))
  const query = get('--query') ?? 'GRADUATION_NEEDLE'

  const report = await runGraduationDemo({ workspace, query })
  console.log(JSON.stringify(report, null, 2))

  const allStagesOk =
    report.compactionApplied &&
    report.editOutcome.kind === 'applied' &&
    report.backgroundJob.exitCode === 0 &&
    report.reconnectConverged &&
    report.restartRecovered &&
    report.goalClosed
  if (!allStagesOk) process.exitCode = 1
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
  if (argv[0] === 'propose-edit') {
    await runProposeEditCommand(argv.slice(1))
    return
  }
  if (argv[0] === 'run-workflow') {
    await runWorkflowCommand(argv.slice(1))
    return
  }
  if (argv[0] === 'graduation-demo') {
    await runGraduationDemoCommand(argv.slice(1))
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
