# architecture.md：mini-harness 整体架构

## 分层视图

```
src/llm/        消息模型、流式组装、Adapter 边界（Day2/3）
src/tools/      工具注册表与执行管线、fs/bash/job/policy/web 工具（Day4/15-18/25）
src/core/       Agent loop、事件日志、持久化、压缩、审批、委派、workflow、遥测/审计/评测（Day5-14/17/19/20/24/26-28）
src/server/     真实 HTTP server：流协议、幂等、backlog、session 广播（Day22）
src/client/     断线重连客户端：Conversation、ReconnectingStream（Day23）
src/propose-edit.ts / cli.ts / graduation-demo.ts   把核心层组合成可运行的入口（Day21/27/30）
```

每一层只依赖更底层，不反向依赖——`src/core/` 从不 import `src/server/`（Day26 study.md 专门点破过这一点："子 Agent 委派不需要 HTTP 层"），`src/llm/` 不知道 `Agent` 的存在。这条单向依赖是这门课从 Day1 起就在维持的纪律，不是事后补的规则。

## 调用链：`graduation-demo` 命令的完整路径

```
cli.ts runGraduationDemoCommand()
  └─ graduation-demo.ts runGraduationDemo()
       ├─ core/agent-handle.ts  Agent（send/whenIdle/compact/dispose/restore）
       │    ├─ core/agent-loop.ts  runTurn()（Day5，不知道 Session 存在）
       │    ├─ core/session.ts  Session（仅追加事件日志，Day8）
       │    ├─ core/compaction.ts  planCompaction/applyCompaction（Day13，今天首次被 Agent 调用）
       │    └─ core/persistence.ts  JsonlSessionStore（Day9/14）
       ├─ propose-edit.ts proposeEdit()
       │    ├─ core/approval.ts ApprovalStore（Day19）
       │    ├─ tools/fs-tools.ts createEditFileTool（Day15）
       │    └─ tools/bash-tool.ts createRunCommandTool（Day16，经 tools/command-policy.ts）
       ├─ core/audit-log.ts AuditingApprovalStore（Day28，包一层 ApprovalStore）
       ├─ core/job-runtime.ts JobRuntime（Day17，借用 tools/process-runner.ts spawnManaged）
       ├─ server/http-server.ts createHttpServer()（Day22）+ client/conversation.ts Conversation（Day23）
       ├─ core/goal.ts GoalStore（Day24）
       └─ core/telemetry.ts deriveTelemetry() + core/redact.ts createRedactor()（Day28）
```

## 类型复合图：三条从 Day30 往回长的主线

跟 day00/day08-13/day15-21 三份全貌地图同一个手法——不是"谁调用谁"，是"哪个字段装着更早哪天的类型"。

**主线一：`GraduationReport` 装的是六天独立类型的组合**

```
GraduationReport（Day30）
├─ evidence: string                              ← 从 AgentLoopEvent.model-response（Day5）派生
├─ editOutcome: ProposeEditOutcome                ← Day21，内部装 ApprovalRequest（Day19）/VerificationResult（Day21，内部又装 Day16 ProcessRunResult 的字段——day15-21-phase3-overview.md 已经画过这条血统）
├─ backgroundJobAudit: readonly AuditRecord[]     ← Day28
├─ telemetry: TelemetryReport                     ← Day28，内部装 TokenUsageTotals（Day12）
└─ goalClosed / restartRecovered / ...: boolean   ← 由 GoalStore（Day24）/ Agent.restore（Day9）的返回值现算
```

**主线二：`SessionEvent`（Day8）是这条演示叙事里唯一真正跨越全部八个阶段的类型**

```
SessionEvent（Day8，判别联合）
├─ 阶段一/二产出：turn/*、user/message、assistant/message、tool/call、tool/result
├─ 阶段二产出：compaction/start、compaction/summary、compaction/end（Day13 定义,今天第一次真的被写进一份持久化日志）
├─ 阶段六读取：JsonlSessionStore.load() 读回来的就是这个类型的数组
└─ 阶段八读取：deriveTelemetry(events: readonly SessionEvent[], ...)（Day28）直接消费这个数组，不做任何转换
```

**主线三：`AgentDeps`（Day6）贯穿了"同一份配置，喂给三种不同的 Agent 用途"**

```
AgentDeps（Day6，后续每天新增可选字段：sink Day9、systemPrompt Day11、loopOptions Day12）
├─ 阶段一构造：{adapter, tools, provider, model, sink: JsonlSessionStore.create(...)}
├─ 阶段六重建：Agent.restore({adapter, tools, provider, model}, persistedEvents)——同一个 adapter/tools 引用，不重新构造
└─ Day26 SubagentManager.startChild(spec) 的 spec.deps: Omit<AgentDeps, 'sink'>——今天没有用到子 Agent，
   但类型上是同一族，Day27 run-workflow 命令走的正是这条路
```

## 有状态 vs 无状态组件

| 组件 | 有/无状态 | 谁拥有它 |
|---|---|---|
| `Agent` | 有状态（`session`、`nextTurnQueue`、`disposed`） | 调用方（今天是 `runGraduationDemo()` 局部变量） |
| `Session` | 有状态（仅追加日志） | 唯一被 `Agent` 私有持有，外部只能通过 `sessionEvents`/`compact()` 间接触达 |
| `JobRuntime`/`SubagentManager`/`SessionRegistry` | 有状态（`Map`） | 各自的构造方——今天分别是 `runGraduationDemo()`、`demonstrateReconnect()` |
| `planCompaction`/`deriveTelemetry`/`deriveMessages`/`projectSummary` | 无状态纯函数 | 不持有任何东西,输入不变则输出不变 |
| `ApprovalStore`/`GoalStore`/`IdempotencyStore` | 有状态（各自的 `Map`） | 构造它们的那个作用域 |

无状态的派生函数（`deriveTelemetry`/`deriveMessages`/`projectSummary`/`planCompaction`）全部只吃一份 `SessionEvent[]`——这是这门课从 Day8 起反复验证过的模式："仅追加事件日志是唯一真源,任何视图都能从它重新算出来",今天的 `GraduationReport` 本质上也是这个模式的一次终极应用：八个阶段产出的几乎所有信息,最终都能从同一份持久化在磁盘上的 `session.jsonl` 重新推导出来。
