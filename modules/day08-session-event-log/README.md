# Day 8・仅追加事件日志与真源

> 阶段：II. 可回放的状态与上下文（开始）　|　产出：`src/core/session.ts`（`Session`、`deriveMessages`）

## 今天要学会什么

1. 理解"事件溯源"这个模式：不直接维护当前状态，而是维护一份只能追加的事件日志，当前状态永远从日志派生。
2. 区分"持久事实"（写进日志、构成真源的东西）和"瞬态控制状态"（比如 `Session` 内部用来校验开闭配对的那点临时簿记，不进日志）。
3. 理解为什么"仅追加日志 + 派生函数"比"手动维护一个可变数组"更适合支撑崩溃恢复、审计和多视图共享同一份真相（Day9-10 会陆续用上）。
4. 亲手写出/读懂几条"日志开闭配对"的不变式，并理解为什么校验要放在写入时，不能指望事后补救。

## 怎么学

1. 读 [study.md](./study.md)——今天的核心类比是 Redux 的 `actions` 数组 + `reducer`，如果你写过 Redux/Vuex，这一天会比想象中好懂。
2. 读代码：`mini-harness/src/core/session.ts`，重点看 `Session.append()` 里的 `checkInvariant()` 和 `deriveMessages()`。
3. 跑测试：`pnpm test -- session`，看 `tests/session.test.ts` 里每一条"应该被拒绝"的用例，对着 study.md 第4节那张表逐条核对。
4. 做 [exercise.md](./exercise.md)。

## 今天刻意没做的事（不是遗漏）

- `Agent`/`runTurn` 还没有真的改成往 `Session` 里写事件——`Session` 今天是一个独立、有完整测试的新模块，还没有被接进 Day1-7 搭好的循环里。这个集成留到 Day9（引入持久化时一起做，因为"要不要持久化"直接决定了"集成时该在哪些边界 flush"）。
- 系统提示词（`system/message`）、请求信封快照（`request/header`）、fork/resume 分界（`session/end-seed`）——DSH 真实事件表里有，今天全部不做，等对应话题（Day11 前后）出现真实需求再加。

## 验收标准

- 你能不看代码，口头说清楚"为什么 `deriveMessages` 必须是纯函数"，以及这条约束具体防住了什么问题。
- 你能解释 `Session.append()` 里那几条开闭配对校验，分别对应"同一 turn/step 的开闭必须配对"这条不变式的哪个具体场景。
- `pnpm test` 全绿（新增 `tests/session.test.ts`）。
