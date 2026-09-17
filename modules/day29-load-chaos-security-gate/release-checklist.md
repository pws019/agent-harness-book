# 上线检查表：针对 mini-harness 当前真实状态

这不是一份空模板——是把根 `README.md` "企业级 Agent 的核心不变式清单"18 条，逐条对照 `mini-harness/` 当前真实代码/测试打勾，标注"通过/部分通过/未通过"和具体理由（哪个测试/哪段代码落实了它，或者缺口具体在哪）。这份清单本身也是诚实的——`Day30` 的 `invariants.md` 会在这份基础上做更完整的版本，这里先给出一个可以直接核对的第一版。

| # | 不变式 | 状态 | 理由 |
|---|---|---|---|
| 1 | 每个 run/turn/step/tool call 只有一个合法终态 | ✅ 通过 | `Agent` 的 `stopReason` 只写一次；`JobRuntime`（Day17）、`WorkflowRunner.settle()`（Day27，`workflow-runner.ts:79-83` 的 `settled` 标志位）都是同一套"只落定一次"纪律,各自有专门测试覆盖终态竞态。 |
| 2 | 所有模型可见输入都能从持久日志重建 | ✅ 通过 | `deriveMessages()`（Day8）+ `JsonlSessionStore`（Day9/14）；`tests/persistence-integration.test.ts` 验证崩溃恢复后依然可重建。 |
| 3 | 会话事件 seq 连续、仅追加、可验证；历史不被压缩或恢复过程改写 | ✅ 通过 | `Session.append()`（`session.ts:143-151`）单调递增 `seq`；Day13 压缩是"追加一条摘要声明"而不是删除/改写原始事件（surface replacement，不是真正抹除历史）。 |
| 4 | tool result 必须对应已存在且尚未闭合的 tool call | ✅ 通过 | `Session.checkInvariant()`（`session.ts:169`）；Day8 就有专门测试覆盖"孤儿 tool/result"场景。 |
| 5 | 未完整组装的工具调用绝不执行 | ✅ 通过 | `BlockAssembler` 只在 `block-end` 之后才认为一次工具调用参数完整（Day2/3）；`runTurn()` 只在组装完成后才真正调用 `ToolRegistry.execute()`。 |
| 6 | 取消从入口传播到模型、工具、进程、Job、workflow 和 subagent | 🟡 部分通过 | 模型/工具/进程/Job/subagent 都有专门的取消传播测试（Day6/16/17/26）。`WorkflowRunner.cancel()`（Day27）是一个刻意收窄的版本——它保证**自己的终态记账**在有界时间内落定，但不保证被取消的子 Agent 底层真的已经完全停止运行（`workflow-runner.ts` 的 `forceCancel()` 注释里写明了这条边界）。 |
| 7 | dispose 幂等且有界；所有长生命周期资源都有明确 owner | 🟡 部分通过 | `Agent.dispose()`/`JobRuntime.dispose()`/`SubagentManager.disposeAll()` 都幂等（Day6/17/26）。"有界"这一半在 `WorkflowRunner` 那里有第6条同样的收窄——`dispose()` 被调用了，但不保证在有界时间内真正完成。 |
| 8 | 未知用量是 unknown，不是 0；失败请求的真实成本仍被记录 | ✅ 通过 | `TokenMeter`（Day12）+ Day28 `deriveTelemetry()` 延续同一条纪律（真实踩到并修复过一次"未上报被悄悄当 0"的坑，见 `modules/day28-telemetry-audit-eval/answer.md`）。 |
| 9 | policy 决策、用户审批、sandbox 强制执行是三层不同机制 | 🟡 部分通过 | policy（`CommandPolicy`，Day18）和审批（`ApprovalStore`，Day19）两层是真实、独立的机制。"sandbox 强制执行"这一层今天没有真正的 OS 级沙箱——`CodeRuntime`（Day25）自己的文档注释明确写了"`node:vm` 不是安全边界"，这条防线目前只有 policy 这一层在真正生效。 |
| 10 | 审批绑定具体动作和参数，不能跨调用重放 | ✅ 通过 | `ApprovalRequest.argsHash`（Day19）+ 一次性 `consume()`。 |
| 11 | secret 不进入 prompt、会话日志、普通错误、trace 或工具展示 | 🟡 部分通过 | `CredentialRef`（Day20）让 secret 不会通过*结构化*字段进入日志。但 Day28 `study.md` 明确记录了一条没有完全堵住的路径：`tool/result.content`（真实 stdout）可能意外带出明文,这段内容会原样进 `SessionEvent` 日志（这正是"会话日志"字面意义上的一部分）。`redact.ts` 只在**遥测报告**这一步生效,不改写原始日志本身——原始日志里的明文依然存在,这条不变式今天没有 100% 落实。 |
| 12 | sandbox 不可用时高风险操作故障关闭 | 🟡 部分通过 | `FailClosedCommandPolicy`（`command-policy.ts:30-40`）在 policy 求值本身出错时拒绝而不是放行，这条测过。但跟第9条同一个理由——没有真沙箱，"sandbox 不可用"这个场景本身在 `CodeRuntime` 这一层不存在对应的检测/拒绝机制。 |
| 13 | Agent、child、workflow 都受深度/并发/Token/时间/工具次数预算约束 | ✅ 通过（有一处收窄） | `AgentLoopOptions.maxSteps`/`maxToolCalls`/`maxTokens`（`agent-loop.ts:34,41,82,151,177`）管单个 Agent；`DelegationBudget`（Day26）管委派树的并发/总数/深度/Token/时间。`WorkflowRunner.maxAgents`（Day27）是执行前对树的静态叶子数检查，不是运行时滚动预算——两种检查方式合起来才是完整的,单独任何一层都不够,但两层确实都在。 |
| 14 | 客户端断线重连后通过 baseline/cursor 收敛，不把通知流误当可靠状态存储 | ✅ 通过 | `Conversation`/`runReconnectingStream()`（Day23），8 个种子的故障注入验证过；Day29 `load-and-chaos.test.ts` 额外验证了一次真实大规模长 stream 场景。 |
| 15 | goal 完成需验证器或用户确认，不能只相信模型自报 | ✅ 通过 | `GoalStore.close()`（Day24）强制要求一个跟模型输出无关的 `verify()`。 |
| 16 | telemetry sink 故障不能破坏主任务，且出站前经过脱敏 | 🟡 部分通过 | `AuditingApprovalStore`（Day28）今天被 Day29 `load-and-chaos.test.ts` 真实验证过"sink 抛错不影响主流程"，且修复成真的吞掉了错误（`audit-log.ts` 的 `notify()`）。**这条保护只覆盖了 `AuditSink` 这一个具体的 sink**——`Agent`/`session.ts` 里更早（Day9）就存在的 `SessionSink.append()` 完全没有同样的保护（`agent-handle.ts:121`、`session.ts:305` 都是裸调用）。实测过这条路径真实会发生什么：`send()`/`whenIdle()` 都正常返回、`agent.records` 里这个 turn 完全没被记录，错误本身变成一次没人认领的 unhandled promise rejection（真实 Node 进程会因此崩溃）——这不是"故意选择不吞、让错误暴露"，是"从来没有人设计过这条失败路径"的自然后果，比 `AuditSink` 那种"吞掉、丢一条审计记录"和"干净地报错给调用方"都更糟。`SessionSink` 需要的是一个专门设计过的降级策略（比如标记 session 进入持久化失败状态、让调用方能查询到），不是简单套用 `AuditSink` 的 `try/catch` 方案就能解决，这是留给 Day30 `failure-model.md` 展开的诚实缺口。 |
| 17 | 相同事件日志的全量 replay 与增量 projection 结果一致 | ✅ 通过 | `projectSummary()`/`deriveMessages()`（Day10）与真实崩溃恢复场景（Day14）反复验证过一致性。 |
| 18 | 任何副作用都能关联到用户、session、审批、tool call 和执行结果 | 🟡 部分通过 | session/tool call/执行结果三者靠 `turn`/`step`/`callId` 稳定关联（Day8）。"审批"这一环靠 `ApprovalRequest.argsHash`（Day19）。"用户"这一环今天只有 Day28 刚补上的 `principal: string`字段——一个调用方自称、未经验证的身份，不是真正的用户认证结果（这条诚实缺口在 Day22 bearer token、Day28 `AuditingApprovalStore` 两处都记录过）。 |

**汇总**：18 条里 11 条完全通过，7 条部分通过，0 条完全未通过——部分通过的共同特征不是"机制不存在"，而是"机制存在但覆盖范围/强度有一个明确记录过的边界"（要么是刻意的范围收窄，要么是诚实记录的缺口，两者在上表里都点名了是哪一种）。**没有一条不变式是靠"假装通过"蒙混过去的**——这本身也是一条隐含的、贯穿整个课程的纪律。
