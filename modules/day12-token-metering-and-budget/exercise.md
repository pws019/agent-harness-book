# Day 12 实践任务

## 任务 1：读代码，跑一遍故障注入

打开 `tests/agent-loop.test.ts` 里 `maxTokens` 的4条测试，跑一遍调试器，确认自己能预判"fail-closed"那条测试为什么就算 `maxTokens` 设得很宽松（100万）也会立刻停止。

## 任务 2：给 `TokenMeter` 加一个"总花费"便捷方法

现在每次要判断"花了多少"都要自己写 `totals.inputTokens === 'unknown' || totals.outputTokens === 'unknown' ? undefined : totals.inputTokens + totals.outputTokens` 这种逻辑。给 `TokenMeter` 加一个方法：

```ts
totalKnownTokens(): number | 'unknown'  // input + output，任一为 unknown 则整体 unknown
```

改用它简化 `agent-loop.ts` 里的预算检查代码，补至少两条测试。

## 任务 3：实现 fail-open 模式（选做）

study.md 提到 fail-closed 不是唯一答案。给 `AgentLoopOptions` 加一个 `tokenBudgetMode?: 'fail-open' | 'fail-closed'`（默认 `'fail-closed'`，保持现有行为不变）。`fail-open` 模式下，如果用量变成 `unknown`，预算检查应该怎么做？（提示：完全跳过检查，还是用"最后一次已知的花费"继续判断？两种做法哪个更安全，为什么？）实现你认为更合理的一种，并写清楚为什么选它。

## 任务 4（思考题，不用写代码）

如果某天你要给"墙钟时间"（这个 turn 已经跑了多久）也做一个类似 `maxTokens` 的预算，`TokenMeter` 那套"一旦 unknown 就回不去"的逻辑还适用吗？墙钟时间有没有可能"这一步不知道花了多久"？如果没有，为什么"未知"这个状态对 token 计量有意义、对墙钟计时却不需要？

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的任务2测试。
- [ ] 我能解释：为什么 `usage` 字段没有的时候，代码里要写成条件展开，而不是直接 `usage: event.usage`？
