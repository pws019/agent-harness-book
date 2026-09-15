# mini-harness

这是《企业级 Agent / Agent Harness：30 天进阶学习计划》里贯穿全程、逐天演进的同一个工程。不要把它当成一次性写完的项目——每一天的代码都建立在前一天的基础上，接口会持续演进。

## 使用方式

```bash
cd mini-harness
pnpm install
pnpm test        # 跑当前进度的全部测试
pnpm typecheck    # 类型检查
```

## 如何对照每天的进度

每天的学习里程碑都会打一个 git tag（`day01` ~ `day27`）。如果你写练习时卡住了，想看"官方参考实现长什么样"，可以：

```bash
git log --oneline --all --tags   # 看看有哪些里程碑
git diff day03..day04            # 看 Day4 相对 Day3 具体改了什么
git checkout day04 -- mini-harness/src   # 只取出 Day4 结束时的代码状态看看（不会切分支）
```

建议的做法是：先看对应 `modules/dayXX/exercise.md` 里的任务描述，自己动手写一版，卡住超过 30-40 分钟再对照 tag 里的参考实现，而不是一上来就抄。

## 目录说明（会随天数增长）

- `src/llm/` —— 消息模型、流式组装、Adapter（Day2、Day3 引入）
- `src/tools/` —— 工具注册表与执行管线（Day4 引入）、workspace 越界检测/hash/diff/原子写这类文件操作辅助与写工具 `edit_file`（Day15 引入）、子进程执行 `run_command`（Day16 引入）、后台任务工具 `start_job`/`job_status`/`cancel_job`（Day17 引入）、命令策略 `CommandPolicy`（Day18 引入）、网页搜索/抓取 `web_search`/`web_fetch`（Day25 引入）
- `src/core/` —— Agent loop、生命周期与取消（Day5、Day6 引入）、事件日志与消息派生（Day8 引入）、持久化与崩溃恢复（Day9 引入）、投影/查询/标题/Spill（Day10 引入）、系统提示词（Day11 引入）、Token 计量与预算（Day12 引入）、上下文压缩（Day13 引入）、真实文件持久化（Day14 引入）、后台任务生命周期 `JobRuntime`（Day17 引入）、审批 `ApprovalStore` 与权限预设（Day19 引入）、凭据引用 `CredentialRef`/`CredentialStore`、分层设置 `mergeSettings`、`WorkspaceContext`（Day20 引入）、按需加载技能 `SkillRegistry`、人触发命令 `Command`/`CommandRegistry`、`PlanModeController`、目标状态机 `GoalStore`、定时提醒 `scheduleReminder`（Day24 引入）、真实 tsserver 协议客户端 `TsserverClient`、语义查询+降级 `semantic-query.ts`、`node:vm` 代码运行时 `CodeRuntime`（Day25 引入）、子 Agent 委派 `SubagentManager`、预算 `DelegationBudget`、`StructuredResult`（Day26 引入）、可审计编排 `WorkflowNode`/DSL 构建函数/`WorkflowRunner`（Day27 引入）
- `src/propose-edit.ts` —— 里程碑三：把 `edit_file`/`run_command`/`ApprovalStore`/权限预设串成一条端到端链路，`cli.ts` 的 `propose-edit` 子命令（Day21 引入）
- `src/server/` —— 把 `Agent` 接进真实 `node:http` 服务器：流式协议 `StreamEnvelope`、幂等 `IdempotencyStore`、慢客户端积压上限 `createBacklogWriter`、session 生命周期 `SessionRegistry`（Day22 引入）
- `src/client/` —— 断线重连客户端：合并去重 `Conversation`、重连循环 `ReconnectingStream`、故障注入测试工具、终端客户端（Day23 引入）
- `cli.ts` 的 `run-workflow` 子命令 —— 里程碑四：把 Day22-26 各自独立建好的每一块串成一条能跑的编排命令（Day27 引入）
- `tests/` —— 单元测试、场景测试、故障注入测试

详细记录见 [CHANGELOG.md](./CHANGELOG.md)。
