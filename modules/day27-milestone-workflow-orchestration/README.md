# Day 27・里程碑四：Workflow——可审计编排

> 阶段：IV. 平台化与编排（收尾）　|　产出：`src/core/workflow-types.ts`/`workflow-dsl.ts`/`workflow-runner.ts`、`cli.ts` 的 `run-workflow` 子命令、`phase-iv-test-index.md`

## 今天要做什么

不引入新概念，把 Day22-26 各自独立建好的每一块第一次串成一条真正能跑的命令——这是阶段四的毕业考核，跟 Day7/Day14/Day21 是同一种性质的收尾。

```
Day25 CodeRuntime（node:vm）
  └─ 跑一段脚本，脚本调用 Day27 四个纯构建函数 agent()/parallel()/pipeline()/phase()
       └─ 拼出一棵 WorkflowNode 描述符树（buildWorkflowFromScript() 校验它真的是一棵合法的树）
            └─ WorkflowRunner.run(tree, {maxAgents}) 解释这棵树
                 ├─ agent 叶子 → Day26 SubagentManager.startChild()（真正的子 Agent）
                 ├─ parallel → Promise.all 并发解释子节点
                 ├─ pipeline → 依次解释子节点（不做"上一步结果喂给下一步"，见下方诚实记录的缺口）
                 └─ phase → 带名字的审计检查点，透传内层结果
```

```bash
cd mini-harness
cat > /tmp/my-workflow.js <<'EOF'
pipeline(
  agent('scout', 'find evidence'),
  parallel(agent('a', 'sub task a'), agent('b', 'sub task b')),
)
EOF
pnpm cli -- run-workflow --workspace <你自己的项目路径> --script /tmp/my-workflow.js --query "Agent"
```

## 今天要学会什么

1. 理解 `agent()`/`parallel()`/`pipeline()`/`phase()` 为什么"调用它不会执行任何东西"——具体跟 React 的 `createElement()`/JSX 是同一个形状,`WorkflowNode` 是纯 JSON 数据这件事怎么支撑这个形状。
2. 理解 `WorkflowNode.agent` 为什么只带一个字符串 `agentId`,不直接嵌入真实的 `AgentDeps`——这个决定跟"这棵树要能安全地从 `node:vm` 沙箱里构建出来"有什么关系。
3. 理解 `WorkflowRunner.cancel()` 为什么能在有界时间内 resolve,即使某个子 Agent 的 adapter 完全不理会自己的 `AbortSignal`——具体是牺牲了什么保证换来的（提示：读 `forceCancel()` 的实现和它旁边的注释）。
4. 理解"唯一终态"（`completed | cancelled | error`）是怎么保证的——`cancel()` 和自然完成赛跑时,谁赢由什么机制决定,不会出现两条终态记录。
5. 理解 `maxAgents` 为什么在 `WorkflowRunner.run()` 里最早一步就检查,而不是等真正跑起来发现超了才失败。
6. 能解释 `pipeline` 这天故意没做的事：每一步的 `task` 文本是脚本写死的,不会把上一步的执行结果喂给下一步。

## 怎么学

1. 读代码，建议顺序：`src/core/workflow-types.ts` → `src/core/workflow-dsl.ts` → `src/core/workflow-runner.ts` → `cli.ts` 里的 `runWorkflowCommand`。
2. 跑 `tests/workflow.test.ts`（12 条：DSL 本身、`CodeRuntime` 接入、`WorkflowRunner` 解释四种节点、`maxAgents` fail-closed、卡死子任务下的有界取消、终态竞态）。
3. 手动跑一遍上面 `pnpm cli -- run-workflow ...` 的例子，看真实输出的 JSON 结果树。
4. 读 [phase-iv-test-index.md](./phase-iv-test-index.md)——汇总阶段四（Day22-27）各天已经各自验证过的故障注入/边界测试，不是重新写一遍。
5. 做 [exercise.md](./exercise.md)。

## 一个诚实记录的缺口：`WorkflowRunner.cancel()` 不等子 Agent 真正退出

`SubagentHandle.dispose()` 最终会调用 `Agent.dispose()`（Day6），而 `Agent.dispose()` 自己的实现是 `await this.runLoopPromise`——如果子 Agent 的 adapter 真的完全不理会 `AbortSignal`（不是慢，是彻底卡死），这个 `await` 会永远不 resolve。`WorkflowRunner.forceCancel()` 选择不等它：`dispose()` 照样在后台发出去（错误被 `.catch()` 吞掉），但 runner 自己的终态记录立刻落定成 `cancelled`,不会被一个不配合的子任务拖住。

这是 Day17 `spawnManaged()`"信号 → 宽限期 → 强杀"里"强杀"那一步在进程内 Agent 场景下的对应物,但不是完全等价——`SIGKILL` 对一个真实操作系统进程总是有效（内核会强制回收），但对一个卡在 `await` 上的纯 JS 循环,没有语言层面的"强杀"手段,只能选择不再等它。代价是：`cancel()` 保证了 `WorkflowRunner` 自己的记账在有界时间内落定,但不保证被取消的子 Agent 底层真的已经完全停止运行——如果那个 adapter 背后是一个真实的、正在打网络请求的 LLM 调用,请求本身可能还在继续跑,只是没人再等它的结果了。`tests/workflow.test.ts:151` 那条"卡死子任务"的测试验证的正是"runner 的记账不被拖住"这件事,不是"子任务真的被杀死了"。

## 阶段门禁（对照原 30 天大纲，阶段四：平台化与编排）

- [x] **HTTP Server 能流式推送 Agent 事件，慢客户端有积压上限**：Day22 `createHttpServer()`/`createBacklogWriter()`。
- [x] **客户端能断线重连，最终状态收敛到权威来源**：Day23 `Conversation`/`runReconnectingStream()`,`tests/client-reconnection.test.ts` 用真实故障注入验证收敛到 `deriveMessages()`。
- [x] **按需加载的 Skill、人类直接触发的 Command、可切换权限的 Plan mode、验证后才能关闭的 Goal**：Day24，五个概念权重不平均分配代码量,`Goal.close()` 必须有 `verify()` 才能真正关闭是一条具体的单元测试。
- [x] **外部内容（web/LSP）带不可信来源标记，语义查询失败能诚实降级**：Day25，`FetchResult`/`SemanticQueryResult` 都是判别联合,`withFallback()` 是这门课第一个刻意的 fail-open 例子。
- [x] **子 Agent 隔离执行，预算 fail-closed，权限不能升级**：Day26，`SubagentManager`/`DelegationBudget`/`presetRank()`。
- [x] **能编排多个 Agent（并行/串行/分阶段），编排可审计、可取消**：Day27，`WorkflowRunner`——树在执行前就已经建好,可以在执行前被记录/审查；取消保证有界时间收尾。
- [ ] **你能不看代码，解释清楚"为什么这门课的 workflow DSL 是静态树，不是模型在执行中途动态生成/分支的脚本，这个选择换来了什么、放弃了什么"**——这个由你自己在 exercise.md 里写下来。

## 复盘问题（写在你自己的笔记里，不需要提交）

- 阶段四这六天（Day22-27）里，哪些机制是"分布式/多进程"场景特有的（比如幂等 key、断线重连），哪些是即使 Agent 全部跑在同一个进程里也依然成立的（比如预算 fail-closed、权限不能升级、唯一终态）？
- `WorkflowRunner` 目前只有四种节点（`agent`/`parallel`/`pipeline`/`phase`）。如果要加一种"重试直到成功或达到上限"的节点，应该长什么样的类型定义？它跟已有的 `DelegationBudget` 应该怎么配合，而不是各建一套平行的计数逻辑？
