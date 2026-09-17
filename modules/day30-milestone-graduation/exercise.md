# Day 30 实践任务

## 任务 1：跑起来，指向你自己的项目

```bash
cd mini-harness
pnpm cli -- graduation-demo --workspace /tmp/my-demo --query "关于你项目里某个真实存在的关键词"
```

读一遍完整的 JSON 输出——八个阶段各自留下了什么痕迹（`evidence`/`editOutcome`/`backgroundJobAudit`/`telemetry.records`）。把 `--query` 换成你自己项目里真实存在、真实能被 `search_text` 找到的关键词,再跑一遍,确认 `evidence` 字段里的内容确实变了。

## 任务 2：亲手复现"可选链短路参数求值"这个坑

在 `src/core/compaction.ts` 的 `applyCompaction()` 里,把拆开的两条语句合并成一行链式调用（这是第一版真实写出来过的写法）：

```ts
export function applyCompaction(session: Session, plan: CompactionPlan, sink?: SessionSink): void {
  if (!isJsonValue(plan.summary)) {
    throw new SessionAppendError('...')
  }
  sink?.append(session.append('compaction/start', { fromSeq: plan.fromSeq, toSeq: plan.toSeq }))
  sink?.append(session.append('compaction/summary', { message: plan.summary }))
  sink?.append(session.append('compaction/end', {}))
}
```

重新跑：

```bash
pnpm vitest run tests/compaction.test.ts tests/agent-compact-integration.test.ts
```

确认有测试失败——`session.events.length` 没有真的增加 3 条，`deriveMessages()` 派生出来的历史条数也不对。想一想：`sink?.append(x)` 这种可选链调用,当 `sink` 是 `undefined` 时,`x` 这个参数表达式到底有没有被求值（提示：这不是"调用被跳过、但参数已经算出来了"，是"整个表达式——包括参数——一起被短路了"，用 `node -e "undefined?.foo(console.log('evaluated') || 1)"` 亲手验证一遍,看看"evaluated"到底有没有被打印出来）。这条坑在这门课绝大多数已有代码里都不存在——`closeDanglingActivity()`（Day9）从一开始就是"先 `const event = session.append(...)`，再单独一行 `sink?.append(event)`"这个写法,今天是第一次真的因为写反了顺序而踩到。跑完记得改回来，确认全绿。

## 任务 3：把这套方法套到你自己的毕业项目上

你自己的"只读代码库调查 Agent"项目（`docs/product-scope.md`、`docs/adr/001-agent-vs-workflow.md`、`docs/task-catalog.md`）目前处于设计阶段。挑其中一个已经落了地、或者你计划近期落地的具体能力（比如"调查多个文件、给出带证据的结论"这一步），仿照今天 `graduation-demo.ts` 的做法，写一份端到端演示脚本大纲（不需要真的写完整实现,但至少要列出：这个流程要经过哪几个真实模块、每一步之间传递的是什么类型的数据、哪些步骤需要审批/验证、失败时应该收敛到什么状态）。再挑一条 `invariants.md`/`failure-model.md` 里今天写下来的不变式或故障模式，判断它在你自己的项目里成不成立、需不需要对应的机制。

## 任务 4（毕业问答，写在自己的笔记里）

不需要写代码，用你自己的话回答——如果有人问你："企业级 Agent 跟一个能调用工具的聊天机器人，本质区别是什么？"，结合这 30 天学到的东西，你会怎么回答？至少提到：

1. "仅追加事件日志是唯一真源"（ADR-001）这条设计,解决的是聊天机器人不需要面对的什么问题。
2. fail-closed 和 fail-open 不是二选一的立场，是同一个判定标准（"会不会导致不可逆副作用"）在不同场景下的自然结果（ADR-002）——举一个具体例子。
3. 举一个"诚实记录缺口，而不是假装解决了"的具体例子（这门课里到处都是——挑一个你印象最深的），说说为什么"诚实记录"本身就是一种工程纪律，不只是文档礼貌。

## 验收自查

- [ ] `pnpm test` 全绿，包括你在任务2里临时改坏又改回来之后的状态。
- [ ] `pnpm typecheck` 无错。
- [ ] 我亲手跑过 `pnpm cli -- graduation-demo`，指向真实存在的项目，读过完整的输出报告，不是只看测试绿了就算完成。
- [ ] 我做完了任务2：亲手把 `applyCompaction()` 改成链式调用，观察到测试真的失败，用 `node -e` 验证过可选链短路参数求值这件事本身，改回来后全部测试恢复通过。
- [ ] 我写完了任务3的端到端演示脚本大纲，明确列出了会经过哪些真实模块、审批/验证点在哪、失败时收敛到什么状态。
- [ ] 我写完了任务4的毕业问答，每一条都有具体机制支撑，不是空话。
