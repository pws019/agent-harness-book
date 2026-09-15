# Day 26・Subagent——隔离、委派与预算

> 阶段：IV. 平台化与编排　|　产出：`src/core/subagent.ts`（`SubagentManager`）、`src/core/delegation-budget.ts`（`DelegationBudget`）、`src/core/structured-result.ts`（`StructuredResult`）

## 今天要学会什么

1. 理解为什么子 Agent 不需要 Day22 的 HTTP 层——委派这件事本质上是什么形状的问题，跟"能不能被网络访问"完全无关。
2. 理解为什么子 Agent 必须有一份独立的 `Session`，不能共享父 Agent 的 `Message[]` 历史——具体会带来什么问题，跟 Day8 事件溯源解决的是不是同一类问题。
3. 理解为什么只有 `StructuredResult` 能跨越父子边界，不是子 Agent 完整的事件日志——`createStructuredResult()` 复用的是哪个更早的机制。
4. 理解 `presetRank()` 的显式偏序表——父子 preset 的六种组合分别是什么结果，为什么"不认识的 preset 名字"要走拒绝这一支。
5. 理解 `DelegationBudget.recordStart()` 为什么必须在真正启动子 Agent 之前调用，不能等它跑完再补记账——具体会导致哪个限制失效。
6. 理解 `maxTokens` 和 `maxTimeMs` 这两个预算维度，实际生效的程度为什么不一样。

## 怎么学

1. 读 [study.md](./study.md)——§0 先破除"子 Agent 需要走网络"这个容易顺着课程顺序产生的误解。
2. 读代码，建议顺序：`src/core/structured-result.ts` → `src/core/delegation-budget.ts` → `src/core/subagent.ts`。
3. 跑 `tests/structured-result.test.ts`、`tests/delegation-budget.test.ts`、`tests/subagent.test.ts`（真实构造多个 `Agent` 实例做端到端验证，不是纯粹的 mock）。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：全局并发（`maxConcurrent`）、总 child 数（`maxTotalChildren`）、深度（`maxDepth`）、Token（`maxTokens`）、时间（`maxTimeMs`）这五个预算维度，哪些是真正被强制执行的，哪些是"只挡得住下一次启动，挡不住已经在跑的那一个"——具体是哪个维度、为什么。
- 你能解释：父 Agent 结束之后，为什么不会有"孤儿"子 Agent 继续留在内存里跑——具体是哪个方法、依赖了哪个更早的幂等设计。
- 你能解释：子 Agent 的权限为什么不能超过父 Agent——如果子 Agent 传了一个 `PermissionPreset` 但父 Agent 没有指定 preset，会发生什么（提示：读一下 `startChild()` 那个判断条件的完整写法）。
- `pnpm test` 全绿。
