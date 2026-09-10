# Day 12・Token 计量、预算与成本控制

> 阶段：II. 可回放的状态与上下文　|　产出：`src/core/token-meter.ts`，`runTurn` 新增 `maxTokens` 预算

## 今天要学会什么

1. 理解为什么"没有上报用量"必须记成 `unknown`，不能记成 `0`，以及这个原则在"缓存字段"这种可选子字段上为什么不适用。
2. 理解预算检查在"数据不完整"时的两种设计选择（fail-open vs fail-closed），以及为什么这里选了后者。
3. 再练一次 Day8 就讲过的坑：往事件里塞一个可选字段时，"键不存在"和"键存在但值是 undefined"的区别。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码：`src/core/token-meter.ts`，再看 `agent-loop.ts` 里新增的预算检查那几行，以及 `agent-handle.ts` 里 `assistant/message` 那个条件展开写法。
3. 跑 `tests/token-meter.test.ts` 和 `tests/agent-loop.test.ts` 里 `maxTokens` 那个 describe 块。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：为什么 `TokenMeter` 一旦收到一次 `undefined`，之后就再也回不到数字状态了？
- 你能解释：为什么 `maxTokens` 预算检查选择 fail-closed，而不是 fail-open？你能想到一个 fail-open 更合适的场景吗？
- `pnpm test` 全绿。
