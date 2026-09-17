# invariants.md：18 条核心不变式，逐条落地证据

`modules/day29-load-chaos-security-gate/release-checklist.md` 已经把这18条不变式逐条打过勾（11通过、7部分通过）。这份文档不重复那张表,是给每一条"完全通过"的不变式补上具体的、可核对的落地证据（哪个文件的哪个机制、哪条测试），给"部分通过"的补上今天（Day30）新观察到的证据（如果有）。

| # | 不变式 | 落地机制（file:line 或测试） |
|---|---|---|
| 1 | 每个 run/turn/step/tool call 只有一个合法终态 | `agent-handle.ts` `TurnRecord.stopReason` 只写一次；`workflow-runner.ts:79-83` `settled` 标志位；`tests/workflow.test.ts:179`"终态竞态"测试 |
| 2 | 所有模型可见输入都能从持久日志重建 | `session.ts` `deriveMessages()`；`tests/graduation-demo.test.ts` 第三条用真实重建的 `restoredAgent.history` 验证 |
| 3 | seq 连续、仅追加、可验证；历史不被压缩/恢复过程改写 | `session.ts` `Session.append()` 单调 seq；`compaction.ts` 只追加三条声明事件,不删除/改写原始事件 |
| 4 | tool result 必须对应已存在且未闭合的 tool call | `session.ts` `checkInvariant()` |
| 5 | 未完整组装的工具调用绝不执行 | `block-assembler.ts`（Day2/3）只在 `block-end` 后交出完整参数 |
| 6 | 取消从入口传播到模型/工具/进程/Job/workflow/subagent | Day6/16/17/26 各自的取消测试；`WorkflowRunner.cancel()` 是唯一收窄过的例外（见下方"缺口"） |
| 7 | dispose 幂等且有界 | `Agent.dispose()`/`JobRuntime.dispose()`/`SubagentManager.disposeAll()` |
| 8 | 未知用量是 unknown，不是 0 | `token-meter.ts` `TokenMeter.record()`；`telemetry.ts:80-83`（Day28 真实踩到并修复过一次相关 bug） |
| 9 | policy/审批/sandbox 强制执行是三层不同机制 | `command-policy.ts`（Day18）、`approval.ts`（Day19）两层是真实独立机制；sandbox 强制执行这层的诚实边界见下方 |
| 10 | 审批绑定具体动作和参数，不能跨调用重放 | `approval.ts` `ApprovalRequest.argsHash` + 一次性 `consume()` |
| 11 | secret 不进入 prompt/会话日志/普通错误/trace/工具展示 | `credentials.ts`/`workspace-context.ts`（Day20）结构化字段安全；`tool/result.content` 这条路径的缺口见下方 |
| 12 | sandbox 不可用时高风险操作故障关闭 | `command-policy.ts:30-40` `FailClosedCommandPolicy` |
| 13 | Agent/child/workflow 都受深度/并发/Token/时间/工具次数预算约束 | `agent-loop.ts:34,41,82,151,177`（单 Agent）、`delegation-budget.ts`（Day26，委派树）、`workflow-runner.ts`（Day27，静态叶子数检查） |
| 14 | 客户端断线重连后通过 baseline/cursor 收敛 | `conversation.ts`/`reconnecting-stream.ts`（Day23）；今天 `demonstrateReconnect()` 又真实跑了一次真断线场景 |
| 15 | goal 完成需验证器或用户确认 | `goal.ts` `GoalStore.close()`；今天的 `verify()` 真的读了磁盘文件内容 |
| 16 | telemetry sink 故障不能破坏主任务，且出站前经过脱敏 | `audit-log.ts` `notify()`（Day29 修的）；覆盖范围的边界见 `failure-model.md` |
| 17 | 全量 replay 与增量 projection 结果一致 | `session-projection.ts`（Day10）；`persistence-integration.test.ts` |
| 18 | 任何副作用都能关联到用户、session、审批、tool call 和执行结果 | `turn`/`step`/`callId`（Day8）+ `ApprovalRequest.argsHash`（Day19）+ `principal`（Day28）；"用户"这一环的边界见下方 |

## 三条仍然只是"部分落地"的不变式，今天没有新增证据能推翻这个结论

- **第6/7条**：`WorkflowRunner.cancel()` 保证自己的终态记账有界，不保证被取消的子 Agent 真正停止运行（`workflow-runner.ts` `forceCancel()`）。
- **第9/12条**：`node:vm`（`CodeRuntime`，Day25）不是真沙箱,这条边界从 Day25 写下来那天起就没有被掩盖过。
- **第11条**：`tool/result.content` 可能带出凭据明文进原始 `SessionEvent` 日志——`redact.ts` 只在遥测报告这一步生效,不改写日志本身（Day28 `study.md` §4.2）。
- **第16条**：`AuditSink` 的保护今天验证有效,但没有推广到 `Agent` 的 `SessionSink`（Day29 真实验证过后者未受保护时的具体后果，见 `failure-model.md`）。
- **第18条**：`principal` 是调用方自称的身份，不是验证过的身份（跟 Day22 bearer token 同一类缺口）。
