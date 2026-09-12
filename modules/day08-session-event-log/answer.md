# Day 8 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. 事件溯源**

不直接维护当前状态，而是维护一份只能追加的事件日志，当前状态永远从日志派生。类比 Redux：`actions` 数组是事件日志，`reducer` 是派生函数——`Session`（事件日志）对应 `actions` 数组，`deriveMessages()`（派生函数）对应 `reducer`，只是一次性把所有事件"reduce"成最终消息列表。

**2. 持久事实 vs 瞬态控制状态**

持久事实是写进日志、构成真源的东西（`turn/start`/`user/message`/`tool/call` 等八种事件）。瞬态控制状态是 `Session` 内部用来校验开闭配对的簿记（当前开着的 turn/step、这个 step 里还没等到结果的 `callId` 集合）——这些不进日志，只是运行时辅助判断"下一条事件合不合法"的临时状态。

**3. 为什么"仅追加日志 + 派生函数"比手动维护可变数组更适合支撑崩溃恢复、审计、多视图共享**

裸数组一旦进程退出就没了，没有"怎么一步步变成现在这样"的记录（崩溃恢复答不出来）；只有最终状态,答不出"第17步发生了什么"（审计答不出来）；多份视图分别手动维护容易产生"UI 说完成了但发给模型的历史其实还差一条"这种漂移（多视图共享答不出来）。今天先做前半部分（`Session`/`deriveMessages()` 独立验证），`Agent`/`runTurn` 还没真的接上——这是"设计两次"的实践：先独立验证新抽象，再考虑怎么嵌入旧系统。

**4. 日志开闭配对不变式，校验为什么放在写入时**

`Session.append()` 写入前做两件事：JSON 校验（`isJsonValue`，跟 Day3/Day6 判断"纯数据"是同一个思路）和开闭配对校验（`turn/start` 不能在已有 turn 开着时再开、`tool/result` 的 `callId` 必须在"当前 step 等待结果"的集合里等）。放在 `append()` 而不是留给 `deriveMessages()` 事后检查，是因为 `deriveMessages()` 是纯函数，只管"把已经写进日志的东西派生成消息"，让 `append()` 在写入那一刻就拒绝非法序列，`deriveMessages()` 才能放心假设"日志里的东西都是合法的"，不用重复防御。

## 验收自查

**为什么 `deriveMessages()` 不需要自己再校验一遍"这条日志合不合法"**：因为合法性已经在 `Session.append()` 那一刻被强制保证了——任何会破坏开闭配对不变式的写入都会被 `SessionAppendError` 直接拒绝，永远不会真正进入日志。`deriveMessages()` 作为消费方，可以放心假设传进来的 `events` 数组内部自洽，只需要专心做"把 surface 事件派生成消息"这一件事，不用重复做一遍写入时已经做过的防御——这是职责分层：写入时校验一次，消费时无条件信任。

**任务4"`runTurn` 签名要怎么改"的初步想法**：`runTurn()` 目前操作的是一个内存 `Message[]` 草稿数组，不知道 `Session` 的存在。Day9 实际的做法是**不改** `runTurn()` 的签名——翻译工作放在离 `Session` 最近的 `Agent.drain()` 里，它本来就在用 `for await` 消费 `runTurn()` 吐出的每个 `AgentLoopEvent`，只是额外把每个事件同步翻译成一条 `Session.append(...)`。这样"要不要接 Session"这个决定放在离 `Session` 最近的翻译层，`runTurn()` 继续对"历史怎么持久化"一无所知。
