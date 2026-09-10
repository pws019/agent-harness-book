# Day 9 实践任务

## 任务 1：读代码，追一遍完整链路

打开 `mini-harness/src/core/agent-handle.ts`，对着 study.md 第2节的翻译表，在 `drain()`/`translateLoopEvent()` 里逐行找到每一条对应的代码。然后打开 `tests/session-integration.test.ts` 第一条测试，跑一遍调试器（或者手动加 `console.log(agent.sessionEvents)`），确认自己能预判一次"纯文本回答"的 turn 最终会产生哪6个事件、顺序是什么。

## 任务 2：多个工具调用里，只有一个挂起时的收尾

`closeDanglingActivity` 现在的测试（`session.test.ts`）覆盖了"两个工具调用都挂起"和"一个工具调用都没发生"这两种情况。请补一条介于两者之间的场景：一个 step 里模型请求了两个工具调用（`c1`、`c2`），`c1` 正常执行完拿到了结果，`c2` 因为超时/取消导致整个 turn 提前终止。

1. 写一条测试（可以放在 `session.test.ts` 或 `session-integration.test.ts`），验证：`c1` 的 `tool/result` 是真实执行产生的（不是合成的），`c2` 的 `tool/result` 是 `closeDanglingActivity` 补写的合成结果（`isError: true`）。
2. 想一想：`deriveMessages()` 会把这两条 `tool/result` 合并成同一条 `{role:'tool', blocks:[...]}` 消息吗？为什么？（提示：回忆 Day8 study.md 第5节"按 `(turn,step)` 分组"的规则）

## 任务 3：故障注入——在 `tool/call` 和 `tool/result` 之间"杀掉进程"

写一条集成测试：

1. 用真实的 `Agent` + `sink`（接 `JsonlSessionStore`）跑一个会请求工具调用的 turn，但**不要**让它跑完——在 `tool/call` 事件被写进 store 之后（可以用一个自定义的 sink 包装一层，写到 `tool/call` 类型就抛异常，模拟"这里断电了"），手动从 `raw.readLines()` 里截出这份"半成品"日志。
2. 用 `JsonlSessionStore.open()` + `load()` 加载这份日志，验证 `truncated`（要看你截的位置是不是在最后一行）。
3. 用 `Agent.restore()` 从加载出的事件恢复一个新 Agent，验证 `history`/`sessionEvents` 都被正确收尾了。

## 任务 4（进阶）：flush 时机

现在的实现是"每次 `Session.append()` 都立刻同步转发给 `sink`"，相当于每个事件都单独 flush 一次——真实场景下这可能对性能不利（一个 turn 可能产生几十条事件，等于几十次磁盘 I/O）。

DSH 原文提到"loop 不在 turn 边界等待 flush，由专门的 checkpoint 策略决定持久化时机"。想一想：如果要把"每条事件都立刻 flush"改成"攒够一批或者到某个边界再 flush"，你会把这个决策放在哪一层（`Session`？`Agent`？`JsonlSessionStore`？还是一个新的中间层）？这样改动之后，"崩溃恢复"这件事本身的语义要不要跟着变（比如"最后一批未 flush 的事件全部丢失"算不算可以接受）？不需要写代码，写下你的思路。

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的任务2、任务3测试。
- [ ] 我能解释：`closeDanglingActivity` 为什么要接受一个可选的 `sink` 参数，这个参数解决的是哪个真实发生过的问题？
- [ ] 我对任务4"flush 时机该放在哪一层"有一个初步判断，能说出至少一条支持自己判断的理由。
