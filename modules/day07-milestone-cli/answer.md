# Day 7 答案

> Day7 是里程碑收尾日，README 没有单独的「今天要学会什么」列表——它的任务是把 Day1-6 拼起来验证。这里直接对照 [exercise.md](./exercise.md)「验收自查」和 README「阶段门禁」逐条作答。

## 验收自查

**时序图能不能让没读过代码的人看懂 turn/step/tool call 的关系**：见 [modules/day05-agent-loop/exercise/task1.md](../day05-agent-loop/exercise/task1.md)（"模型第一次请求返回工具调用，工具执行成功，模型第二次请求返回文本并完成"这个场景，mermaid 时序图，用背景色块分别框出两个 step，note 标出完成判定条件）。任务2要求补的是场景19（多步 tool call 后完成）专属的一版，结构模式相同：`CLI → Agent → runTurn → generateWithRetry/adapter → ToolRegistry`，每个 step 的边界用背景色块标出，`history` 数组的增长在每一步 note 里注明。

**对照阶段门禁清单，逐条说出怎么满足、证据在哪**：

| 门禁 | 怎么满足 | 证据 |
|---|---|---|
| 单元测试覆盖组装器、schema、loop 终态和取消竞态 | Day2-6 每天各自的单元测试 | `tests/block-assembler.test.ts`（111条）、`tests/tools.test.ts`、`tests/agent-loop.test.ts`、`tests/agent-handle.test.ts` |
| 20 条场景全部产生合法终态；不以"程序未抛异常"作为成功标准 | `tests/scenarios.test.ts` 每条断言的是具体的 `stopReason`/事件内容，不是"没抛异常就算过" | `tests/scenarios.test.ts`（20条，覆盖成功、证据不足、工具失败、预算耗尽、取消、模型层错误重试/耗尽/不可重试、跨天回归守卫） |
| 能画出一次 turn 中多个 step 和 tool call 的时序图 | 见上一条 | `modules/day05-agent-loop/exercise/task1.md` |

一句话总结这一天在验证什么：六天搭的骨架能不能撑起一个真实可跑的 CLI，并且在各种坏路径下行为可预期——**不是"能不能接入某个具体模型 API"**，`HeuristicInvestigationAdapter` 全程没连真实模型，接入真实模型只需要照着 Day3 的 `LlmAdapter` 接口写一个新实现，`Agent`/`runTurn` 不需要改一行代码,这本身就是 Day3"适配器边界"设计价值的一次实战验证。
