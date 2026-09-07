# 白话讲解：实现 Agent Loop

> 素材来源：DSH `docs/subsystems/core.zh.md`（1276行）、`docs/agent-lifecycle.zh.md`。

## 1. turn、step、attempt：三层嵌套关系，用"写连载小说"类比

- **session**（整本书）：所有历史的容器。我们 MiniHarness 现在还只是一个内存数组（`history: Message[]`），Day8 起会换成仅追加事件日志。
- **turn**（一章）：用户发一条消息触发的一整段处理，`runTurn()` 一次调用就是一个 turn。
- **step**（一段/一次落笔）：turn 内部，"请求一次模型 + 处理它要求的工具调用"算一个 step。一个 turn 可能横跨多个 step——模型要工具、拿到结果、再请求，这是同一个 turn 里的第二个 step，不是新 turn。
- **provider attempt**（一次投稿尝试）：Day3 `generateWithRetry` 内部的一次具体网络请求，可能因为可重试错误而失败重来。

原文有一句话把 turn/step 的持久性讲得很直接：

> "轮次和步骤边界是持久会话事件，而不是 agent emit。"——`core.zh.md`

这句话在 DSH 真实系统里的意思是：turn/step 的开合是**写进日志的持久事实**，不是内存里跑一跑就没了的临时状态。我们 MiniHarness 今天还没有事件日志（Day8 才引入），但 `AgentLoopEvent` 里的 `turn-start`/`step-start`/`step-end`/`turn-end` 就是在为"以后这些要变成持久事件"预留位置——你会发现这几个事件类型和 DSH 的持久事件名几乎一一对应，这不是巧合。

## 2. 为什么不能只信模型自报"完成了"

`runTurn()` 里判断"这个 turn 该不该结束"的代码是这样：

```ts
if (toolCalls.length === 0 && result.finish.kind !== 'tool-calls') {
  // 完成
}
```

**为什么不是简单地"模型这次没请求工具调用就算完成"？** 因为存在一种畸形情况：`finish.kind === 'tool-calls'`（模型说"我要调用工具"），但由于某种 bug（比如流被截断、组装器丢了数据），最终解析出来的消息里其实一个 `tool-call` 块都没有。如果这时候我们直接判定"完成"，就是在没有真正验证的情况下相信了模型的自我报告。我们的处理是：只要 `finish.kind === 'tool-calls'`，哪怕暂时没解析出工具调用，也保守地当作"还没完成"，让循环继续下一步——**系统只信"数据确实显示没有欠工作"，不信"模型说它已经调用了工具"这句话本身**。

DSH 原文对应的机制是 `agent/turn-stopping` 事件：

> "The turn is about to close: the model owes no response (no live tool calls, no fresh steering)... Data decides, so listener order cannot change the outcome."——`core.zh.md`

"Data decides"（数据说了算）——这是本节最核心的一句话。不是"模型的文字说了算"，是"当前状态数据（有没有存活的工具调用）说了算"。

## 3. Agent loop 骨架

```
turn-start
  ┌─→ step-start
  │     请求模型（Day3 的 generateWithRetry，内部处理重试）
  │     model-response
  │     ├─ finish.kind === 'error'  → turn-end(error)
  │     ├─ finish.kind === 'aborted' → turn-end(cancelled)
  │     ├─ 没有工具调用且不是 tool-calls → step-end → turn-end(completed)
  │     └─ 有工具调用：
  │           tool-call → 执行 → tool-result（每个调用都不让异常冒泡出整个 turn）
  │           把所有工具结果打包成一条 tool 消息追加进历史
  │           step-end
  └─── 回到 step-start，继续下一步
（撞到 maxSteps / maxToolCalls / deadline / 取消 → turn-end(budget_exhausted 或 cancelled)）
```

## 4. 我们在实现时真实踩到的两个坑

### 坑一：`freezeRequest` 和"可变历史数组"打架

Day3 的 `generateWithRetry` 会把传给它的请求对象**深度冻结**。第一版 `runTurn` 是这么写的：

```ts
const result = await generateWithRetry(deps.adapter, {
  ...,
  messages: history,   // 直接把可变数组传进去
})
history.push(result.message) // 💥 TypeError: Cannot add property, object is not extensible
```

`freezeRequest` 会递归冻结它接触到的**每一个对象**，包括 `messages` 指向的这个数组本身。`history` 和 `options.messages` 是同一个数组引用，冻结了后者，前者也被冻住了——回来想 `history.push()` 直接抛异常。

**修复**：给 `generateWithRetry` 传一份快照（`messages: [...history]`），而不是原始数组：

```ts
messages: [...history], // 冻结这份快照，不影响我们后面继续 push 的 history 本身
```

**这个坑值得记住的地方**：Day3 学的"请求冻结"和 Day5 学的"可变历史"，看起来是两个独立知识点，但一旦组合起来就会互相冲突。这正是"设计两次"的价值——如果只孤立地测试每一层，你不会发现这个问题；只有把两层拼在一起跑一次集成测试，才会暴露。

### 坑二：取消检查必须在调用异步函数体之前

这个坑我们在 Day4 工具管线里已经踩过一次（详见 Day4 study.md 第5节），Day5 的教训是：**同一类 bug 会在不同层反复出现，因为它的根源是 JavaScript 异步函数的一个通用特性**（调用 `async function` 会同步执行到第一个 `await`），不是某个特定模块的问题。写检查取消/超时逻辑的时候，养成"先检查信号，再调用可能有副作用的函数"这个习惯，比针对每个模块单独修一次更重要。

## 5. 工具调用失败为什么不能让整个 turn 崩溃

`executeToolCall()` 把"参数不是合法 JSON""工具不存在""工具执行抛异常"这几种情况全部转换成一条 `isError: true` 的工具结果，而不是让异常一路冒泡打断 `runTurn`：

```ts
try {
  args = JSON.parse(call.arguments)
} catch {
  return { content: `invalid JSON arguments for tool "${call.name}": ...`, isError: true }
}
```

**为什么这么设计？** 因为工具调用失败是**预期内**会发生的事情——模型偶尔会编造一个不存在的工具名，或者生成的参数 JSON 有语法错误。这些不是系统故障，是"正常业务的一部分"。把它们转换成一条错误结果、追加进历史、让模型在下一步看到这个错误并自己决定怎么应对（换个工具名重试、换个思路），比直接让整个 turn 崩溃更符合"错误代价可控"的设计目标。

**但要注意边界**：如果是工具执行超时或者被取消（`ToolTimeoutError`/`ToolAbortedError`），我们目前的实现**也**把它们当成普通的 isError 结果处理了——这是一个简化。严格来说，"用户主动取消"应该让整个 turn 提前终止（`cancelled`），而不是继续跑完剩下的工具调用再问模型怎么办。这个细节我们留到 Day6 讲取消传播的时候正式处理，今天先建立"loop 骨架"这个大框架。

## 一句话总结

Agent loop 的核心不是"循环"本身（那只是几行 for 循环），而是**每一次分支都要有明确、可测试、不可能被绕过的终态判断**。DSH 花了大篇幅去区分 turn/step/attempt，本质上是在强调："循环什么时候继续、什么时候停"这件事，必须建立在可观察的数据状态上，而不是建立在"模型好像说完了"这种不可靠的信号上。
