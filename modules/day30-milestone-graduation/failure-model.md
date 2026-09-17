# failure-model.md：这门课至今讨论过的所有故障模式

跟 `threat-model.md`（"模型/攻击者可能故意做什么"）不同的问题——这里问的是"系统的各个部件各自可能怎么坏掉，坏了之后现在的应对策略是什么，诚实的缺口在哪"。按故障发生的层次分组。

## 1. 模型层

| 故障 | 应对策略 | 诚实缺口 |
|---|---|---|
| provider 返回可重试错误（429/500） | `generateWithRetry()`（Day3）按 `RetryPolicy` 重试，指数退避+抖动 | 不可重试错误（如 401）立即失败，`tests/load-and-chaos.test.ts` 验证过一次多步 turn 中途遇到不可重试错误依然收敛到明确 `stopReason` |
| 模型返回空/畸形响应 | `classifyFinish()`（Day2）判别真值表覆盖"工具调用为空但 finish 不是 tool-calls"等边界组合 | — |
| 模型被诱导执行危险操作 | policy/审批/沙箱三层（见 `threat-model.md`） | `node:vm` 不是真沙箱（Day25） |

## 2. 工具/子进程层

| 故障 | 应对策略 | 诚实缺口 |
|---|---|---|
| 子进程卡死/超时 | `spawnManaged()`（Day16）超时后 `killProcessTree()` 杀整棵进程树 | — |
| 子进程 fork 出孙进程 | 同上，`red-team-regression.test.ts` 场景5 验证过 | — |
| 工具执行超时/被取消 | `ToolRegistry.execute()`（Day4）统一处理超时+取消 | — |
| 后台任务（Job）长期占用资源 | `JobRuntime.dispose()`（Day17）幂等释放,创建者拥有清理责任 | — |

## 3. 持久化/网络层

| 故障 | 应对策略 | 诚实缺口 |
|---|---|---|
| 进程崩溃、日志写到一半 | `JsonlSessionStore`（Day9/14）识别截断、诚实收尾成 cancelled | — |
| 客户端断线 | `Conversation`/`ReconnectingStream`（Day23）按 cursor 补洞 | `WorkflowRunner.cancel()` 不保证子 Agent 真正停止（Day27） |
| 服务端积压/慢客户端 | `createBacklogWriter`（Day22）硬上限+诊断消息 | 上限本身没有自适应机制,只能靠调用方配置 `maxBacklogBytes` |
| **客户端先等 turn 完全结束再开事件流** | `handleEventsStream()` 主动检查"是否已经追上"（Day29 修复） | 这是本课程唯一一处"发现了会导致永久挂起的 bug 并修复"的记录 |

## 4. 遥测/审计/幂等 sink 层——今天新整理的一节

这是 Day29 意外发现的最有教学价值的一类故障：**"给一个 sink 接口加保护"这个决定，不能不看这个 sink 背后具体是什么就套用同一个答案**。

| sink | 背后是什么 | 抛错时该怎么办 | 现状 |
|---|---|---|---|
| `AuditSink`（Day28） | 纯观测旁路，没有任何持久化/一致性职责 | 吞掉,主流程继续 | ✅ 已修复（`audit-log.ts` `notify()`） |
| `SessionSink`（Day9） | 兼职持久化（`JsonlSessionStore`）+ 广播（Day22） | **不该**简单吞掉——静默吞错会让"事件已追加"和"其实没落盘"两个不一致状态被隐藏 | ❌ 未修复，`agent-handle.ts:121`/`session.ts:305` 仍是裸调用 |
| `IdempotencyStore`（Day22） | 内存去重表，无清理机制 | 不是"抛错"问题，是无限增长问题 | ❌ 未修复（Day22 study.md 已记录，`exercise.md` 任务4留作设计题） |

**`SessionSink` 真实实测过的具体后果**（Day29 亲手验证）：`send()`/`whenIdle()` 都正常返回、这个 turn 完全没被记录进 `agent.records`、错误变成一次没人认领的 unhandled promise rejection——真实 Node 进程会因此崩溃。这不是"故意选择不吞、让错误暴露"这种深思熟虑的设计，是"从来没有人设计过这条失败路径"的自然产物，比"吞掉丢一条记录"和"干净报错给调用方"都更糟。**正确的修复方向**（今天没有实现，留给这门课之外的练习）：`SessionSink` 需要一个专门设计过的降级策略——比如给 `Agent` 加一个可查询的"持久化健康状态"，写失败时翻转这个状态而不是无声无息,让调用方（比如 `graduation-demo.ts` 这类编排层）有机会主动检查、决定要不要继续。

## 5. 委派/编排层

| 故障 | 应对策略 | 诚实缺口 |
|---|---|---|
| 子 Agent 权限升级 | `presetRank()`（Day26）显式偏序,不认识的名字 fail-closed | — |
| 委派预算耗尽 | `DelegationBudget`（Day26）并发/总数/深度/Token/时间五个维度 | `maxTokens` 是追溯性的,拦不住已经在跑的子 Agent 自己超支 |
| Workflow 卡死子任务 | `WorkflowRunner.forceCancel()`（Day27）有界收尾 | 不保证子 Agent 底层真正停止（见上，跟"客户端和进程"同一类"能控制记账、不能控制底层"问题） |
