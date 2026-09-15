# Day 24 实践任务

## 任务 1：亲手验证"已关闭的 Goal 不能被重新标记"这条防线

在 `src/core/goal.ts` 里，把 `markPendingVerification()` 对"已经 closed"的检查去掉：

```ts
markPendingVerification(id: string): void {
  const goal = this.require(id)
  goal.status = 'pending-verification'
}
```

重新跑：

```bash
pnpm vitest run tests/goal.test.ts
```

确认"markPendingVerification() on an already-closed goal throws"那条测试失败——不再抛 `GoalNotPendingError`。想一想：光是这一个改动，会不会立刻造成数据错误（提示：`status` 被改回 `pending-verification` 之后，`close()` 还需要什么才能真的把它标回 `closed`）？再想一层：如果这个 goal 当初的 `verify()` 函数依赖的外部条件（比如"某个文件存在"）现在已经不再成立了，但函数本身因为某种原因（比如检查的是一个从未被清理的缓存标记）依然返回 `true`，会发生什么？跑完记得改回来，确认全绿。

## 任务 2：给 `PlanModeController` 加一个"禁止从 executing 直接跳过 planning 被外部重置"的规则

现在 `switchTo()` 允许在 `planning`/`executing` 之间任意切换，且不限制切换频率或者顺序。想一想：这样够不够，还是应该加一条"必须先回到 planning、再进 executing，不能反复横跳"之类的限制？如果你认为不需要限制,说出理由；如果你认为需要，实现它，并补至少两条测试（一条验证被拒绝的切换确实被拒绝、一条验证合法的切换序列确实成功）。

## 任务 3：一道思考题（不用写代码）

`study.md` §7 的判断表里，"Workflow"这一行是占位的——Day27 才会有真代码。提前想一想：如果让你现在就设计"这个能力该不该做成一个 Workflow"的判断标准（不用写代码，只用文字描述），你会怎么写？至少提到：

1. 跟"普通代码直接调用 `Agent`/`SubagentManager`"比，Workflow 应该在什么场景下才值得多这一层抽象？
2. 跟"模型在对话里动态决定调用哪个工具"（Day5-7 的 loop 本身就是这样）比，Workflow 解决的是哪一类问题，Day5-7 的循环解决不了？

## 验收自查

- [ ] `pnpm test` 全绿，包括你在任务1里临时改坏又改回来之后的状态、任务2的判断和（如果实现了限制）新增测试。
- [ ] 我能解释：任务1里去掉检查之后,一个已经 `closed` 的 goal 理论上可以被"重新标记、再次关闭一遍"，这在什么场景下是真正有害的（不是泛泛地说"违反了不变式"）。
- [ ] 我写完了任务3的判断标准，给出了具体的场景对比，不是"看情况"。
