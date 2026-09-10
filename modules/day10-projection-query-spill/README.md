# Day 10・投影、查询、标题与 Spill

> 阶段：II. 可回放的状态与上下文　|　产出：`src/core/session-projection.ts`、`src/core/spill.ts`

## 今天要学会什么

1. 理解"同一份仅追加日志，可以派生出多种互不干扰的视图"——今天是这条原则第一次真正兑现，不再只是理论。
2. 理解为什么分页要用 `seq` 游标而不是数组下标，以及这个选择在什么时候才会真正显出差别（Day13）。
3. 理解 Spill（引用/内容分离）和 Day4 `search_text`（截断）解决的是同一类问题，但适用场景不同，学会判断该用哪种。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码：`src/core/session-projection.ts`、`src/core/spill.ts`，都是独立的纯函数，不涉及 `Agent`/`runTurn`，读起来应该比前两天轻松。
3. 跑 `tests/session-projection.test.ts`、`tests/spill.test.ts`。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：为什么 `queryEvents` 用 `seq` 而不是数组下标做分页游标？今天这个选择看不出差别，为什么还是要现在就选对？
- 你能解释：Spill 和 Day4 `search_text` 的截断策略，分别适合什么场景？
- `pnpm test` 全绿。
