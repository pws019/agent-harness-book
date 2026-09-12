# Day 5 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. turn、step、模型请求、工具调用、停止原因的层级关系**

`session`（整本书，还是内存数组）→ `turn`（一章，一次 `runTurn()` 调用）→ `step`（一段，"请求一次模型 + 处理它要求的工具调用"）→ 一个 turn 可能横跨多个 step。`StopReason`（`completed`/`cancelled`/`budget_exhausted`/`error`）是 `runTurn()` 这个 generator 的 **return 值**，不是某一次 `yield`。

**2. 为什么不能只信模型自报"完成了"**

判定完成的代码是 `if (toolCalls.length === 0 && result.finish.kind !== 'tool-calls')`——真值表：

| `toolCalls.length` | `finish.kind` | 结果 |
|---|---|---|
| 0 | `'stop'` | 判定完成 |
| >0 | `'tool-calls'` | 正常执行工具 |
| >0 | `'stop'` | 照样执行工具（有活就干，不管嘴上说没说完） |
| 0 | `'tool-calls'` | **畸形响应，保守当成"还没完成"，继续下一步** |

最后一行是关键：模型"声明"要调用工具（`finish.kind`），但由于流被截断等原因实际没有解析出任何工具调用块（`toolCalls.length===0`），系统选择相信**结构性事实**（真实解析出的 `toolCalls`），而不是模型的**自我声明**（`finish.kind`）。

**3. Agent loop 骨架**

`turn-start → (step-start → 请求模型 → 有无工具调用？→ 执行工具/判定完成 → step-end) 循环 → turn-end`。工具调用失败被转成 `isError: true` 的结果塞回历史，不是让异常冒泡打断整个 turn。

**4. 每个 turn 必须产生唯一终态**

`runTurn()` 里每一个分支（取消、错误、预算耗尽、完成）都直接 `yield turn-end` + `return`，不存在"跑完了但没有明确终态"这种悬而未决的情况。

## 验收自查

**为什么工具调用失败要转成 `isError` 结果而不是抛异常打断 turn；取消/超时又为什么应该是例外**：工具调用失败（未知工具、参数 JSON 非法、业务逻辑抛错）是**预期内**会发生的事——模型偶尔会编造工具名或生成语法错误的参数，这是正常业务的一部分。转成 `isError` 结果塞回历史，让模型下一步自己看到错误、决定怎么应对，比让整个 turn 崩溃更符合"错误代价可控"的目标。但 `ToolTimeoutError`/`ToolAbortedError` 不属于这类——超时/取消是运行时层面"这次调用没能安全跑完"的信号，不是可以留给模型自己想办法应对的业务失败。`executeToolCall()` 对这两种错误原样往上抛，`runTurn` 接住后让整个 turn 提前以 `cancelled` 收场，不再处理这一步剩下的工具调用，也不伪造一条结果——这条边界在 [agent-loop.ts](../../mini-harness/src/core/agent-loop.ts) 里已经实现（exercise.md 任务3）。
