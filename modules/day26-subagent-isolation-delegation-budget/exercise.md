# Day 26 实践任务

## 任务 1：亲手复现"记账时机"这条坑

在 `src/core/subagent.ts` 的 `startChild()` 里，把 `this.budget.recordStart()` 挪到异步结果块里,跟 `recordEnd()` 放在一起（也就是说，改成只在子 Agent **跑完之后**才补记账，不是启动前就记）：

```ts
startChild(spec: SubagentSpec): SubagentHandle {
  if (!this.budget.canStart(this.depth)) throw new SubagentBudgetExceededError()
  if (spec.preset && this.parentPreset && presetRank(spec.preset) > presetRank(this.parentPreset)) {
    throw new SubagentPermissionEscalationError(spec.preset.name, this.parentPreset.name)
  }

  const id = `child-${this.nextId++}`
  const agent = new Agent(spec.deps)
  this.children.set(id, agent)

  // ... timer 设置、agent.send(spec.task) 不变 ...

  const resultPromise = (async (): Promise<StructuredResult> => {
    await agent.whenIdle()
    clearTimeout(timer)
    this.budget.recordStart()   // ← 挪到这里
    const record = agent.records[0]
    this.budget.recordEnd(sumTokens(record?.events ?? []))
    return extractStructuredResult(record)
  })()

  // ... 返回 handle 不变 ...
}
```

重新跑：

```bash
pnpm vitest run tests/subagent.test.ts
```

确认"exceeding maxConcurrent throws SubagentBudgetExceededError"这条测试失败——第二次调用 `startChild()` 没有抛错，`maxConcurrent: 1` 的限制完全失效了。想一想：两次 `startChild()` 调用在测试代码里是背靠背同步调用的，中间没有任何 `await`，为什么"记账时机"这一个改动就能让本该生效的限制失效（提示：`canStart()` 在两次调用里分别看到的"当前有几个在跑"是同一个数字吗？这个数字是什么时候才第一次变成非零的？）。跑完记得改回来，确认全绿。

## 任务 2：给 `SubagentManager` 加一个"列出所有还在跑的子 Agent 及其耗时"的方法

现在 `runningChildCount` 只能看到一个数字。补一个 `listRunning(): readonly {id: string; elapsedMs: number}[]` 方法，返回每个还在跑的子 Agent 的 id 和"从 `send()` 到现在过了多久"。想一想这个信息该从哪里来——`Agent` 本身有没有暴露"这个 turn 是什么时候开始的"这类信息？如果没有，`SubagentManager` 自己该在哪一刻记下开始时间（提示：可以类比 Day17 `JobRuntime`/exercise 任务2 "elapsedMs 冻结语义"那道题的做法）。补至少两条测试。

## 任务 3：一道思考题（不用写代码）

`study.md` §5 提到 `maxTokens` 是"追溯性"的——只在已经跑完的子 Agent 基础上决定要不要允许下一个启动，拦不住一个已经在跑的子 Agent 自己超支。想一想：如果要做到"一个子 Agent 一旦累计用量超过某个上限就立刻被取消，不等它自己跑完"，这个能力应该加在哪一层？是 `DelegationBudget`/`SubagentManager` 这一层，还是应该复用 Day12 `TokenMeter`/`AgentLoopOptions.maxTokens` 那一层已经有的机制？说出理由（提示：想一想"谁能在一次工具调用/一次模型请求刚返回的那一刻就立刻知道最新的 token 用量"——这个时机点在现在的代码里存在吗，在哪）。

## 验收自查

- [ ] `pnpm test` 全绿，包括你在任务1里临时改坏又改回来之后的状态、任务2新增的方法和测试。
- [ ] 我能解释：任务1里挪动 `recordStart()` 之后，为什么两次背靠背的同步调用也会让 `maxConcurrent` 失效——具体是"记账"这件事发生的时间点晚于了什么。
- [ ] 我写完了任务3的判断，给出了具体的层级建议和理由，不是"两边都做一点"这种没有取舍的回答。
