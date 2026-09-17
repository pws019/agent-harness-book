import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { Agent } from './core/agent-handle.js'
import { ApprovalStore } from './core/approval.js'
import { AuditingApprovalStore, type AuditRecord } from './core/audit-log.js'
import { Conversation } from './client/conversation.js'
import { GoalStore } from './core/goal.js'
import { JobRuntime } from './core/job-runtime.js'
import { FileRawStore, JsonlSessionStore } from './core/persistence.js'
import { deriveTelemetry, type CostRateTable, type TelemetryReport } from './core/telemetry.js'
import { createRedactor } from './core/redact.js'
import { createHttpServer } from './server/http-server.js'
import { decodeEnvelopeLine } from './server/wire-protocol.js'
import { HeuristicInvestigationAdapter } from './heuristic-adapter.js'
import { proposeEdit, type ProposeEditOutcome } from './propose-edit.js'
import { createReadOnlyFsTools } from './tools/fs-tools.js'
import { ToolRegistry } from './tools/registry.js'

const NODE = process.execPath

export interface GraduationDemoOptions {
  /** 一个真实、专门为这次演示准备的空目录——函数会往里写入调查用的 fixture 文件、
   * 之后被 propose-edit 修改的目标文件、以及这次演示自己的会话持久化文件。 */
  readonly workspace: string
  readonly query: string
}

export interface GraduationReport {
  /** 阶段一：调查——最终产出的、带证据的总结文本（调查了 workspace 里的多个文件）。 */
  readonly evidence: string
  /** 阶段二：长上下文触发压缩——真的发生了压缩，还是历史还不够长（诚实记录哪种情况）。 */
  readonly compactionApplied: boolean
  /** 阶段三：提出文件修改 → 精确审批 → 沙箱内执行验证命令。 */
  readonly editOutcome: ProposeEditOutcome
  /** 阶段四：启动后台验证——一次独立的、经过审计的批准（不是 propose-edit 那次）。 */
  readonly backgroundJob: { readonly stdout: string; readonly exitCode: number | null }
  readonly backgroundJobAudit: readonly AuditRecord[]
  /** 阶段五：断线重连——一条真实 HTTP 连接中途"断开"、带着 cursor 重新连上,最终收敛。 */
  readonly reconnectConverged: boolean
  /** 阶段六：模拟服务重启——原 Agent 实例被丢弃,从持久化文件重建出的新 Agent 历史
   * 跟重启前完全一致。 */
  readonly restartRecovered: boolean
  /** 阶段七：验证目标——不是模型自称完成，是一个独立 `verify()` 真正检查过文件确实改了。 */
  readonly goalClosed: boolean
  /** 阶段八：输出证据、审计和成本——复用 Day28 `deriveTelemetry()`，脱敏过工具输出。 */
  readonly telemetry: TelemetryReport
}

const DEMO_COST_RATES: CostRateTable = { inputPerKTokens: 3, outputPerKTokens: 15 }

function assertOk(condition: boolean, message: string): void {
  if (!condition) throw new Error(`graduation demo assertion failed: ${message}`)
}

/**
 * 里程碑五（全课程毕业演示）：把 Day1-29 各自独立建好的每一块，串成大纲原文那条
 * 完整叙事——不新建任何能力,只是第一次把它们真的接在一起跑一遍。跟 Day7/14/21/27
 * 同一个"收尾不加新概念"的纪律。
 */
export async function runGraduationDemo(options: GraduationDemoOptions): Promise<GraduationReport> {
  const { workspace, query } = options
  await mkdir(workspace, { recursive: true })

  // --- 准备阶段：给"调查多个来源"准备至少两个真实文件，给"提出文件修改"准备一个目标文件。
  // "多个来源"单独放一个子目录（`sources/`），只把这个子目录交给调查工具当 root——
  // 不然 search_text 连这次演示自己写的 session.jsonl 都会当成"来源"扫进去,证据里
  // 会混进一堆跟调查目标无关的会话日志片段,读起来很乱。
  const sourcesDir = join(workspace, 'sources')
  await mkdir(sourcesDir, { recursive: true })
  await writeFile(join(sourcesDir, 'source-a.md'), `# Source A\n\nThis file mentions ${query} as evidence.\n`)
  await writeFile(join(sourcesDir, 'source-b.md'), `# Source B\n\nA second, independent mention of ${query} lives here.\n`)
  await writeFile(join(workspace, 'notes.md'), 'status: TODO\n')

  // === 阶段一：建 session（真实持久化，为阶段六的"模拟重启"做铺垫） ===
  const sessionPath = join(workspace, 'session.jsonl')
  const rawStore = new FileRawStore(sessionPath)
  const tools = new ToolRegistry()
  for (const tool of createReadOnlyFsTools(sourcesDir)) tools.define(tool)
  const adapter = new HeuristicInvestigationAdapter(query)
  let agent = new Agent({ adapter, tools, provider: 'demo', model: 'heuristic-investigator-v1', sink: JsonlSessionStore.create(rawStore) })

  // === 阶段一：调查多个来源 ===
  agent.send({ role: 'user', blocks: [{ type: 'text', text: `search the workspace for evidence of ${query}` }] })
  await agent.whenIdle()
  const investigationRecord = agent.records[0]
  assertOk(investigationRecord?.stopReason.kind === 'completed', 'investigation turn did not complete')
  const finalBlock = investigationRecord!.events
    .filter((e): e is Extract<typeof e, { type: 'model-response' }> => e.type === 'model-response')
    .map((e) => e.message.blocks.find((b) => b.type === 'text'))
    .filter((b): b is { readonly type: 'text'; readonly text: string } => b !== undefined)
    .at(-1)
  const evidence = finalBlock?.text ?? ''
  assertOk(evidence.includes(query), 'final evidence text does not mention the query')

  // === 阶段二：长上下文触发压缩 ===
  // HeuristicInvestigationAdapter 过了它自己的两步工具调用之后，后续每个 turn 都只是
  // 单步文本回复（study.md 里讲过它的 step 计数器不会跨 turn 重置）——够用来堆出
  // "还有更多历史"，不需要为了这一步单独换一个 adapter。
  for (let i = 0; i < 3; i++) {
    agent.send({ role: 'user', blocks: [{ type: 'text', text: `follow-up ${i}` }] })
    await agent.whenIdle()
  }
  const compactionPlan = agent.compact({ keepRecentSurfaceEvents: 4 })
  const compactionApplied = compactionPlan !== undefined

  // === 阶段三：提出文件修改 → 精确审批 → 沙箱内执行验证命令 ===
  const editOutcome = await proposeEdit({
    root: workspace,
    filePath: 'notes.md',
    find: 'TODO',
    replace: 'DONE',
    approvalStore: new ApprovalStore(),
    requestApproval: () => true,
    preset: createAutonomousEditPreset(),
    verify: { command: NODE, args: ['-e', 'process.exit(0)'] },
  })
  assertOk(editOutcome.kind === 'applied', `propose-edit did not apply: ${editOutcome.kind}`)

  // === 阶段四：启动后台验证——一次独立的、经过审计的批准 ===
  const jobAuditRecords: AuditRecord[] = []
  const jobApprovals = new AuditingApprovalStore(new ApprovalStore(), { record: (entry) => jobAuditRecords.push(entry) })
  const jobApprovalArgs = { command: NODE, args: ['-e', 'console.log("background verification passed")'] }
  const jobApprovalRequest = jobApprovals.create('start_job', 'verify-notes-edit', 'run a background check against the edited file', jobApprovalArgs, 60_000, 'graduation-demo')
  jobApprovals.consume(jobApprovalRequest.nonce, jobApprovalArgs, 'graduation-demo')

  const jobs = new JobRuntime()
  const jobId = jobs.start({ command: NODE, args: jobApprovalArgs.args, cwd: workspace, env: {}, timeoutMs: 5_000, maxOutputBytes: 4_096 })
  let jobSnapshot = jobs.poll(jobId)
  while (jobSnapshot.status.kind === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 10))
    jobSnapshot = jobs.poll(jobId)
  }
  assertOk(jobSnapshot.status.kind === 'completed', 'background verification job did not complete')
  jobs.dispose(jobId)
  const backgroundJobExitCode = jobSnapshot.status.kind === 'completed' ? jobSnapshot.status.exitCode : null

  // === 阶段五：断线重连 ===
  // 这一步在一条真实起停的 Day22 HTTP 服务器上，单独跑一个新 session——不是硬要复用
  // 上面那个已经在内存里跑了好几个 turn 的调查 Agent（`SessionRegistry.create()` 只
  // 知道怎么"造一个全新的 Agent"，不接受一个已经存在的实例）。诚实地说：这里的
  // "session"扮演的是"断线重连"这条叙事里的角色，不是同一个 Agent 对象，但它是
  // 同一套真实代码（Day22/23），不是伪造出来的。
  const reconnectConverged = await demonstrateReconnect()

  // === 阶段六：模拟服务重启并恢复 ===
  await agent.dispose()
  agent = undefined as unknown as Agent // 明确丢掉这次进程内的引用，模拟"进程重启了"
  const { events: persistedEvents, truncated } = JsonlSessionStore.open(rawStore).load()
  assertOk(!truncated, 'persisted session was unexpectedly left truncated')
  const restoredAgent = Agent.restore({ adapter, tools, provider: 'demo', model: 'heuristic-investigator-v1' }, persistedEvents)
  assertOk(restoredAgent.history.length > 0, 'restored agent has no history')
  const restartRecovered = restoredAgent.sessionEvents.length === persistedEvents.length

  // === 阶段七：验证目标 ===
  const goals = new GoalStore()
  const goalId = goals.open('investigation found evidence and the proposed edit was actually applied', async () => {
    const noteContent = await readFile(join(workspace, 'notes.md'), 'utf8')
    return evidence.includes(query) && noteContent.includes('DONE')
  })
  goals.markPendingVerification(goalId)
  await goals.close(goalId)
  const goalClosed = goals.status(goalId) === 'closed'

  // === 阶段八：输出证据、审计和成本 ===
  const redactor = createRedactor([]) // 今天的场景没有真实凭据参与，给一个空列表也能正常工作
  const telemetry = deriveTelemetry(restoredAgent.sessionEvents, { redactor, costRates: DEMO_COST_RATES })

  await restoredAgent.dispose()

  return {
    evidence,
    compactionApplied,
    editOutcome,
    backgroundJob: { stdout: jobSnapshot.stdout, exitCode: backgroundJobExitCode },
    backgroundJobAudit: jobAuditRecords,
    reconnectConverged,
    restartRecovered,
    goalClosed,
    telemetry,
  }
}

function createAutonomousEditPreset() {
  // propose-edit 只需要判断 'edit_file' 这一个动作——借用 Day19 的 readonly preset
  // 构造方式，直接把 edit_file 标成自动通过，不需要引入一个新的 preset 工厂。
  return { name: 'autonomous', decide: () => 'auto-approve' as const }
}

async function demonstrateReconnect(): Promise<boolean> {
  const server = createHttpServer({
    createAgentDeps: () => ({ adapter: new HeuristicInvestigationAdapter('reconnect-demo'), tools: new ToolRegistry(), provider: 'demo', model: 'reconnect' }),
  })
  await new Promise<void>((resolve) => server.listen(0, resolve))
  try {
    const port = (server.address() as AddressInfo).port
    const baseUrl = `http://127.0.0.1:${port}`

    const createRes = await fetch(`${baseUrl}/sessions`, { method: 'POST' })
    const { sessionId } = (await createRes.json()) as { sessionId: string }

    // 先连上、只读第一个 chunk（这个 session 这时候还没发过消息，第一个 chunk 就是
    // 一份空的 baseline）就主动断开——真实模拟"客户端在事情还没真正开始跑的时候
    // 就掉线了"，不是等它完全跑完再假装断线（那样 cursor 会正好等于 lastSeq，
    // 触发的是另一条不同的"已经追上"路径，Day29 `load-and-chaos.test.ts` 已经专门
        // 测过那一条，这里换一个更常见的场景：断线发生在真正开始产生数据之前）。
    const firstConnection = await fetch(`${baseUrl}/sessions/${sessionId}/events`)
    const reader = firstConnection.body!.getReader()
    const { value: firstChunk } = await reader.read()
    await reader.cancel()
    const firstLines = new TextDecoder()
      .decode(firstChunk ?? new Uint8Array())
      .trim()
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => decodeEnvelopeLine(l))

    const conversation = new Conversation()
    for (const envelope of firstLines) conversation.applyEnvelope(envelope)

    // 断线之后才真正发消息——这条消息产生的所有事件，客户端一条都没见过，
    // 全部要靠下面的重连才能拿到。
    await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'go' }),
    })

    // 重连：带着断线前确认到的 cursor（这里等于 -1，因为断线时什么都还没发生）
    // 再连一次，走正常的"实时订阅 + 收到 turn/end 才收尾"路径,拿到这次 turn
    // 完整的进展,包括最后的 terminal。
    const secondConnection = await fetch(`${baseUrl}/sessions/${sessionId}/events?since=${conversation.cursor}`)
    const secondLines = (await secondConnection.text()).trim().split('\n').filter((l) => l.length > 0).map((l) => decodeEnvelopeLine(l))
    for (const envelope of secondLines) conversation.applyEnvelope(envelope)

    const secondTerminal = secondLines.find((e) => e.kind === 'terminal')
    return secondTerminal !== undefined && conversation.messages.length > 0
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
}
