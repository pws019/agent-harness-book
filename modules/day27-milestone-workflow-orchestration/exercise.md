# Day 27 实践任务

## 任务 1：跑起来，指向你自己的项目

```bash
cd mini-harness
cat > /tmp/my-workflow.js <<'EOF'
pipeline(
  agent('scout', 'find evidence'),
  parallel(agent('a', 'sub task a'), agent('b', 'sub task b')),
)
EOF
pnpm cli -- run-workflow --workspace <你自己的项目路径> --script /tmp/my-workflow.js --query "TODO"
```

观察输出的 JSON：确认最外层是 `pipeline`，`steps` 里第一项是 `scout` 那个 `agent` 结果，第二项是一个 `parallel`，里面并列着 `a`/`b` 两个 `agent` 结果。把 `--query` 换成你工作区里真的存在的关键词，对比总结内容有没有跟着变化。再故意写一个语法错误的脚本（比如漏掉一个右括号）跑一遍，观察报错信息——是 `node:vm` 自己的语法错误，还是 `buildWorkflowFromScript()` 包装过的错误？

## 任务 2：亲手验证"取消不等子 Agent 真正退出"这个设计决定

`src/core/workflow-runner.ts` 里 `forceCancel()` 现在是这样写的：

```ts
private forceCancel(): void {
  for (const handle of this.startedChildren) {
    void handle.dispose().catch(() => {})
  }
  this.settle({ kind: 'cancelled' })
}
```

它**不等** `dispose()` 真正完成就已经把终态定成 `cancelled` 了。把它改成"等 dispose 全部跑完再定终态"这个看起来更"正确"的版本：

```ts
private async forceCancel(): Promise<void> {
  await Promise.all(this.startedChildren.map((handle) => handle.dispose()))
  this.settle({ kind: 'cancelled' })
}
```

（`cancel()`/`run()` 里调用它的地方不用改，`await`/不 `await` 都能编译通过。）重新跑：

```bash
pnpm vitest run tests/workflow.test.ts -t "stuck child"
```

确认这条测试从之前的"79ms 内通过"变成 5 秒后**超时失败**——因为 `StubbornAdapter` 的 `stream()` 永远不 resolve、也完全不监听 `options.signal`，`Agent.dispose()` 内部的 `await this.runLoopPromise` 永远等不到，`Promise.all(...)` 自然也永远不会 settle。

想一想：这个"更等一等看起来更完整"的版本，实际上重新引入了 `study.md`（README）里点名记录的那个缺口——`WorkflowRunner` 自己的有界取消保证，本质上是"选择不等一个可能无限期挂起的操作"，不是"真的有办法强制终止它"。再想一层：如果把 `dispose()` 换成一个真的会杀掉底层进程的操作（比如 Day17 `spawnManaged()` 杀一个真实子进程），`Promise.all(...)` 还会永远不 settle 吗？为什么子 Agent（纯 JS 对象）和子进程（操作系统实体）在"能不能被外部强制终止"这件事上有本质区别？

跑完记得把 `forceCancel()` 改回原来不等待的版本，确认 `pnpm vitest run tests/workflow.test.ts` 12 条全部恢复通过。

## 任务 3：设计一个 `retry` 节点

`WorkflowNode` 现在是 `agent | parallel | pipeline | phase` 四选一。设计（不要求写完整实现，但至少写出类型定义 + `WorkflowRunner.interpret()` 里对应 case 的核心逻辑）一个新的 `retry` 节点：

- `{ kind: 'retry', node: WorkflowNode, maxAttempts: number }`——内层节点失败（`StructuredResult.ok === false`，或者更深处抛错）就重试，最多 `maxAttempts` 次。
- 想一想：`countAgentLeaves()` 该怎么算一个 `retry` 节点包着的 `agent` 叶子数——按 1 次算，还是按 `maxAttempts` 次算？这个选择直接决定了 `maxAgents`/`DelegationBudget` 的上限到底在防什么（是"树的静态结构大小"还是"最坏情况下实际会启动多少个子 Agent"）。
- 想一想：`retry` 内层如果是一个 `agent` 叶子，每次重试是不是应该用同一个 `agentId`（同一份 `AgentDeps`，比如同一个 adapter 配置），还是应该允许重试时换一个不同的 `agentId`（比如第一次用便宜的模型，重试时换更贵的）？两种设计对应的类型签名分别长什么样？

## 任务 4（毕业问答，写在自己的笔记里）

不需要写代码，用你自己的话回答——如果面试官问你："什么时候应该用 workflow 编排多个 Agent，什么时候一个 Agent 自己循环调用工具就够了？"，结合阶段四这六天（Day22-27）学到的东西，你会怎么回答？至少提到：

1. `WorkflowNode` 是**静态**树（脚本先把整棵树建完，`WorkflowRunner` 才开始跑）这件事，换来的是什么（提示：想一想"执行前就能审查/记录"这个属性），又放弃了什么（提示：模型能不能根据中途某一步的结果，动态决定接下来该并行跑三个子任务还是跳过）。
2. `parallel`/`pipeline` 两种组合方式分别适合什么场景——具体举一个"必须用 `pipeline` 不能用 `parallel`"的例子，和一个"必须用 `parallel` 不能用 `pipeline`"的例子。
3. Day26 `SubagentManager`/`DelegationBudget` 和 Day27 `WorkflowRunner` 是什么关系——`WorkflowRunner` 自己发明了新的隔离/预算机制吗，还是完全复用了 Day26 已经验证过的那一套？这个选择本身说明了什么设计原则。

## 验收自查

- [ ] `pnpm test` 全绿，包括 `tests/workflow.test.ts` 的 12 条。
- [ ] `pnpm typecheck` 无错。
- [ ] 我亲手跑过 `pnpm cli -- run-workflow`（正常脚本 + 语法错误脚本各一遍），不是只看单元测试绿了就当完成。
- [ ] 我做完了任务2：亲手把 `forceCancel()` 改成"等 dispose 完成"的版本，观察到"卡死子任务"那条测试真的从 79ms 变成 5 秒超时，并且改回来之后全部测试恢复通过。
- [ ] 我能解释任务2的两个"想一想"：为什么这个设计换掉之后会暴露缺口，以及子 Agent 和子进程在"能不能被强制终止"上的本质区别。
- [ ] 我写完了任务3的 `retry` 节点设计，明确回答了 `countAgentLeaves()` 该怎么算、`agentId` 要不要在重试时可变，给出了理由。
- [ ] 我写完了任务4的毕业问答，每一条都有具体机制支撑，不是空话。
