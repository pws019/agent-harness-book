# runbook.md：如果 mini-harness 是一个真的要运维的服务

## 怎么起服务

```bash
cd mini-harness
pnpm install
pnpm test && pnpm typecheck   # 部署前先确认全绿

# 起 HTTP server（Day22）——生产环境需要自己写一个入口脚本调用 createHttpServer()，
# 这门课没有提供现成的"pnpm start"，因为 createAgentDeps 工厂函数必须由调用方
# 决定接哪个真实 provider（这门课全程用 HeuristicInvestigationAdapter 演示）。
```

## 怎么看一个失败的 session

```bash
pnpm cli -- inspect-session <path/to/session.jsonl>   # 概览：turn 数、最后停止原因、是否截断
pnpm cli -- replay-session <path/to/session.jsonl>     # 完整对话文本重放
```

如果 `inspect-session` 报告 `truncated: true`——说明进程在写这份日志的过程中被杀过，`Agent.restore()` 会自动诚实收尾成 `cancelled`，不需要手动修复文件。

## 怎么读一份 `graduation-demo` 报告

```bash
pnpm cli -- graduation-demo --workspace <目录> --query <关键词>
```

产出的 JSON 里，`telemetry.estimatedCostUsd`/`telemetry.totals` 是 `'unknown'` 是正常的（这门课没有接真实 provider,不会上报 token 用量）；`backgroundJobAudit` 应该恰好有 `created`/`consumed` 两条；八个阶段任何一个布尔字段是 `false`（`compactionApplied`/`reconnectConverged`/`restartRecovered`/`goalClosed`）都值得手动排查——命令行退出码会是非零。

## 怎么处理一个卡死的 workflow

`WorkflowRunner.cancel()`（Day27）保证自己的终态记账在有界时间内落定，不保证被取消的子 Agent 底层真的停止运行（`failure-model.md` 第5节）。如果观察到进程里有残留的、不再被任何 `WorkflowRunner`/`SubagentManager` 引用的子 Agent 对象——目前没有一个统一的"列出所有还活着的 Agent 实例"的运维接口，这是一条已知缺口，真要排查得靠 Node 本身的堆快照/进程监控。

## 怎么处理审计/遥测 sink 故障

`AuditingApprovalStore`（Day28）的 sink 抛错已经被吞掉（`audit-log.ts` `notify()`），不会拖垮批准流程——但也意味着**故障是静默的**，没有告警。真要运维，第一件事是给 `AuditSink.record()` 的实现自己加日志/告警,不能指望 `AuditingApprovalStore` 帮你发现这件事,它只保证"不拖垮主流程"，不保证"你会知道它坏了"。

`Agent` 的 `SessionSink` 抛错**没有**被吞掉，会变成一次 unhandled promise rejection——`failure-model.md` 第4节详细讲过为什么这条没有直接照抄 `AuditSink` 的修法。生产环境要用一份真的可能失败的持久化 sink（比如网络文件系统、远程数据库）之前，必须先处理这条缺口,不能假设它已经被这门课解决了。

## 已知缺口清单（求助前先看一遍）

- `IdempotencyStore`（Day22）、`AuditingApprovalStore` 的内部历史（Day28 思考题）都没有清理机制,长期运行会无限增长。
- `node:vm`（Day25 `CodeRuntime`）不是真沙箱,跑不可信代码需要 OS 级隔离,这门课没有做。
- 没有真实的用户认证/授权——`principal`/bearer token 都是自称/共享凭证,不是可验证身份。
- 没有 SLO、容量规划、告警系统——这门课全程"零新增运行时依赖",没有接任何真实的可观测性基础设施（Prometheus/Datadog 之类）。
- 委派/Workflow 的取消不保证底层真正停止运行,只保证记账有界（`failure-model.md` 第5节）。

## 数据保留与回滚

`JsonlSessionStore`（Day9）是仅追加的——没有内建的"删除某个 session"能力（要删就是直接删文件）。没有版本化/回滚机制——这门课的"回滚"概念仅限于 Day19 审批的"撤销一个还没消费的批准"，不涉及"撤销一次已经真正写盘的操作"。
