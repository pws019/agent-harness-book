# Day 30・里程碑五：毕业设计与架构答辩

> 阶段：V. 生产验证与毕业设计（收尾）&nbsp;&amp;&nbsp;全课程收尾　|　产出：`src/graduation-demo.ts`（`runGraduationDemo()`）、`cli.ts` 的 `graduation-demo` 子命令、`Agent.compact()`（把 Day13 压缩第一次接进真实 Agent）、一份完整设计包

## 今天要做什么

不引入新概念，把 Day1-29 建好的每一块，第一次真的串成大纲原文那条完整叙事跑一遍——建 session → 调查多个来源 → 长上下文触发 compaction → 提出文件修改 → 精确审批 → 沙箱内执行 → 启动后台验证 → 断线重连 → 模拟服务重启并恢复 → 验证目标 → 输出证据、审计和成本。跟 Day7/14/21/27 同一种性质的收尾——考验"能不能把已经分别可靠的部件组装成一条可靠的链路"，这次考验范围是整整 30 天。

```bash
cd mini-harness
pnpm cli -- graduation-demo --workspace /tmp/my-demo --query "MY_NEEDLE"
```

## 这条叙事是怎么拼起来的

```
runGraduationDemo()
  ├─ 阶段一：new Agent({sink: JsonlSessionStore.create(...)})（Day6/9）
  │    └─ 调查 sources/ 目录下两个文件（Day4 只读工具 + Day7 HeuristicInvestigationAdapter）
  ├─ 阶段二：再发几轮消息堆出历史 → Agent.compact()（今天新接的调用方,见下方）
  ├─ 阶段三：proposeEdit()（Day21 里程碑：edit_file + ApprovalStore + run_command 验证）
  ├─ 阶段四：AuditingApprovalStore（Day28）批准 → JobRuntime.start()（Day17）后台验证
  ├─ 阶段五：demonstrateReconnect() —— 真实 Day22 HTTP server + Day23 Conversation，
  │    真断线（读到 baseline 就 cancel reader）→ 带 cursor 重连 → 收到完整 terminal
  ├─ 阶段六：agent.dispose() → 丢弃引用 → JsonlSessionStore.open().load() →
  │    Agent.restore()（Day9/14 崩溃恢复同一条路径）
  ├─ 阶段七：GoalStore（Day24）——verify() 真的读了磁盘上的文件，不是模型自称完成
  └─ 阶段八：deriveTelemetry()（Day28）——从重建出来的 Agent 事件日志算证据/成本
```

## 一个真实补上的缺口：`Agent.compact()`

Day13 `planCompaction()`/`applyCompaction()` 写完那天起就是两个纯函数，从来没有一个真正的调用方从 `Agent` 内部触发过它们——`agent-handle.ts` 的 `session` 字段是私有的，外部代码根本拿不到能喂给 `applyCompaction()` 的那个 `Session` 实例。写这条端到端演示第一次撞上了这个真实存在的接缝：今天补了 `Agent.compact(options)`，内部调用 `planCompaction()`/`applyCompaction()`，并且让 `applyCompaction()` 新增一个可选的 `sink` 参数（跟 Day9 `closeDanglingActivity()` 同一个模式）——不然压缩产生的三条事件只会进内存，不会镜像进持久化 store。过程中真实踩到一个 bug：第一版把三次 `sink?.append(session.append(...))` 写成链式调用，`sink` 是 `undefined` 时可选链会连同参数表达式一起短路，`session.append()` 根本不会被求值，压缩变成完全没发生过——拆成"先求值、再转发"两条语句才是对的。

## 一个真实排查掉的环境问题：tsserver 的 references() 在大项目下会卡死

写完 `graduation-demo.ts`（一个 import 了近 20 个模块的大文件）之后，`tests/tsserver-client.test.ts` 里"查 `Agent` 类的所有引用"那条测试开始稳定超时——用 `ps` 实测确认过 tsserver 进程当时 CPU 占用几乎是 0（不是在算，是卡住了），把超时从 5 秒一路加到 120 秒依然拿不到响应。二分排查确认了这跟 `graduation-demo.ts` 具体写了什么无关，是 `Agent` 这个类的引用集合本身越过了某个门槛（这门课到 Day30 为止，几乎每一个测试文件都 import `Agent`）——换一个引用数小得多但依然"不止一处"的真实符号（`GoalStore`），同样的查询 10 毫秒级返回。测试改成查 `GoalStore`，不改变这条测试原本要验证的东西（真实查询能找到不止一条引用）。

## 怎么学

1. 读代码：`src/graduation-demo.ts`（建议对照上面的调用链图逐段读），再看 `agent-handle.ts` 新增的 `compact()` 方法。
2. 跑 `tests/agent-compact-integration.test.ts`（4条，`Agent.compact()` 这条新接缝本身）、`tests/graduation-demo.test.ts`（3条，完整叙事端到端）。
3. 手动跑一遍 `pnpm cli -- graduation-demo --workspace <目录> --query <关键词>`，读一遍真实产出的 JSON 报告。
4. 读设计包：[architecture.md](./architecture.md)、[invariants.md](./invariants.md)、[threat-model.md](./threat-model.md)、[failure-model.md](./failure-model.md)、[eval-plan.md](./eval-plan.md)、[runbook.md](./runbook.md)、[adr/](./adr/)（6 条 ADR）。
5. 做 [exercise.md](./exercise.md)。

## 毕业门禁（对照原 30 天大纲）

| 维度 | 状态 | 理由 |
|---|---|---|
| 正确性 | 🟡 部分通过 | 关键场景（`propose-edit`/`Goal`/`Workflow`）都有可执行验收器；但"不存在只凭模型自报完成的任务"这条不是普遍强制的——只有接了 `GoalStore` 的场景才有这条保证，普通 `Agent.send()` turn 本身不强制任何外部验证。 |
| 可恢复 | ✅ 通过 | 模型（Day3 重试）、工具（Day16/17 超时/取消）、持久化（Day9/14 崩溃恢复，今天再验证一次）、后台任务（Day17 `JobRuntime.dispose()`）边界中断都有明确恢复语义。`WorkflowRunner.cancel()`（Day27）是唯一一处明确收窄过的例外，`release-checklist.md` 第6/7条记录过。 |
| 安全 | ✅ 通过 | 默认最小权限（Day4 只读工具是起点）；高风险副作用经 `CommandPolicy`（Day18）、`ApprovalStore`（Day19）、`CodeRuntime`+policy（Day25）三层约束；`node:vm` 本身不是真沙箱这条诚实缺口全程没有被掩盖。 |
| 一致性 | ✅ 通过 | `Session`（Day8）是唯一真源；`deriveMessages()`/`projectSummary()`（Day10）的全量 replay 与增量 projection 反复验证过一致；今天的"模拟重启"阶段又验证了一次。客户端最终收敛：Day23 + Day29 修的那个 bug。 |
| 可观测 | 🟡 部分通过 | 能关联完整轨迹（`turn`/`step`/`callId`）、成本（Day28，今天诚实地是 `unknown`——没有真实 provider）、审批（Day28 `AuditingApprovalStore`）和副作用（`SessionEvent`），且经过脱敏（`redact.ts`）。`principal`/审计"谁做的"这个维度仍然只是调用方自称,不是验证过的身份。 |
| 可测试 | ✅ 通过 | fake adapter（`streamFake`/`HeuristicInvestigationAdapter`）、contract test（`EvalHarness`，Day28）、scenario eval（同上）、chaos test（Day29 `load-and-chaos.test.ts`）分层齐全。 |
| 可演进 | ✅ 通过 | provider 只需要实现 `LlmAdapter.stream()`（Day3）；工具/权限/委派都是可替换的接口,没有把插件化和核心不变式混在一起。 |
| 可运维 | 🟡 部分通过 | 有明确的操作手册（[runbook.md](./runbook.md)）；没有真实的 SLO/容量假设/告警系统——这是"零新依赖、不接真实基础设施"这条课程主线的必然结果，`runbook.md` 里诚实记录了这条边界。 |

汇总：8 个维度里 5 个完全通过，3 个部分通过——跟 `modules/day29-load-chaos-security-gate/release-checklist.md` 的整体基调一致（大部分机制真实存在,少数几条有明确记录过的边界,没有一条是靠"假装通过"蒙混过去的）。
