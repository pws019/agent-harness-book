# Day 26 答案

> 对照 [README.md](./README.md)「今天要学会什么」、[exercise.md](./exercise.md)「验收自查」和其中的思考题逐条作答。

## 今天要学会什么

**1. 为什么不需要 Day22 的 HTTP 层**

`Agent`（Day6）本身就是一个纯粹的进程内对象，父 `Agent` 可以直接在同一个 Node 进程里 `new Agent(...)` 构造出子 `Agent`，两者之间不隔着任何网络连接。委派要处理的问题（历史会不会串、权限会不会升级、预算要不要控制）在"两个对象活在同一个进程里"这个最简单的场景下就真实存在，不需要先绑定"必须走网络"这个假设。

**2. 为什么子 Agent 需要独立的 `Session`**

如果子 Agent 共享父 Agent 的 `Message[]`/`Session` 实例，子 Agent 产生的 `turn/step` 事件会跟父 Agent 自己的搅在一起——父 Agent 后续调用 `deriveMessages()` 得到的历史会包含"父 Agent 从来没有真正说过"的内容，`Session` 的开闭配对不变式（Day8）也可能被并发写坏。这正是 Day8 事件溯源要消除的"历史被跨 turn 污染"那一类问题,只是场景从"同一个 Agent 内部的多个 turn"换成了"父子两个 Agent"。

**3. 为什么只有 `StructuredResult` 能跨边界**

`createStructuredResult()` 复用 Day8 `isJsonValue()`——跟 `Session.append()` 保证"日志里只能有无损 JSON"是同一条纪律，只是应用场景从"事件能不能安全落盘"换成了"结果能不能安全跨越父子边界"。子 Agent 想返回函数、`undefined`、循环引用这类值会在这里被直接拒绝，不会带着一个"看起来像 JSON 但其实不是"的值一路传到父 Agent 手里才出问题。

**4. `presetRank()` 的六种组合**：见 study.md 第4节的真值表。

**5. 为什么 `recordStart()` 必须在真正启动之前调用**

亲手验证过（exercise.md 任务1）——如果推迟到子 Agent 跑完才记账，两次几乎同时发起的 `startChild()` 调用会在各自的 `canStart()` 检查那一刻都看到"当前 0 个在跑"（因为都还没有任何一次调用真正记过账），于是都被放行，`maxConcurrent` 的限制完全失效。

**6. `maxTokens` 和 `maxTimeMs` 生效程度不同**

`maxTokens` 是追溯性的——只影响"下一个要不要被允许启动"，拦不住一个已经在跑的子 Agent 自己超支。`maxTimeMs` 是真的会生效：`startChild()` 挂一个 `setTimeout`，到点真的调用 `agent.cancel()`，复用 Day6 已有的取消机制。

## 验收自查

**任务1：为什么两次背靠背的同步调用也会让 `maxConcurrent` 失效**：`startChild()` 本身从"检查 `canStart()`"到"返回 handle"之间原本是完全同步的（没有任何 `await`）——但把 `recordStart()` 挪到 `resultPromise` 这个异步 IIFE 内部之后，它真正执行的时机变成了"`await agent.whenIdle()` 完成之后"，这是一个真正的异步边界，不会在 `startChild()` 这次同步调用返回之前执行。测试里两次 `manager.startChild(...)` 是背靠背的同步调用，中间没有 `await`——第一次调用里，`recordStart()` 排在 `agent.whenIdle()` 后面的异步链条上，还没有机会真正执行；第二次调用的 `canStart()` 检查发生的时候，"当前有几个在跑"这个计数器依然是初始值 0（第一次调用根本还没来得及记账），所以两次都通过了检查。"记账"这件事被推迟到了远晚于"这次启动已经确定会发生"的那一刻，中间这段时间窗口里，预算检查看到的是一个过时的、还没反映出"其实已经有一个在跑了"的数字。

**任务2：`listRunning()` 该从哪里获取开始时间**：`Agent` 本身没有暴露"这个 turn 是什么时候开始的"这类信息——`records`/`sessionEvents` 里虽然有 `SessionEvent.time`（每条事件的时间戳），但那是给事件溯源用的，不是给"外部调用方查询一个还在跑的进程/任务活了多久"这种场景设计的直接 API。做法应该跟 Day17 `JobRuntime`（`elapsedMs` 冻结语义那道题）一样——`SubagentManager` 自己在 `startChild()` 里记录一个 `startedAt = Date.now()`，跟 `id`/`agent` 一起存进内部的记录结构里；`listRunning()` 遍历还在 `children` 里的记录，用 `Date.now() - startedAt` 算出每个的 `elapsedMs`。这是"谁掌握这个信息、谁负责提供查询接口"这条原则的又一次体现——`Agent` 不知道、也不需要知道自己是被谁在什么场景下委派出来的，"活了多久"这种委派语境下的元信息，应该由发起委派的那一方（`SubagentManager`）自己记录，不该反过来要求 `Agent` 为了配合这个用例而扩展自己的接口。

**任务3：实时超支检测该加在哪一层**：应该复用 Day12 `TokenMeter`/`AgentLoopOptions.maxTokens`，不该在 `DelegationBudget`/`SubagentManager` 这一层重新做一遍。理由：`TokenMeter` 生效的时机点是"每次 provider attempt 返回 usage 之后立刻检查"（`agent-loop.ts` 内部,`tokenMeter.record(result.usage)` 紧跟着请求返回),这是唯一一个真正能在"最新的 token 用量刚出炉"那一刻做判断的地方——`SubagentManager` 站在子 Agent 外面,只有在 `await agent.whenIdle()` 真正 resolve（也就是子 Agent 已经完全跑完）之后才能拿到它的 `sessionEvents`,这个时间点从定义上就已经"太晚了",不可能实现"立刻取消"。真要让子 Agent 精确遵守一个更小的 token 上限,正确做法是在 `spec.deps.loopOptions` 里给子 Agent 传一个比 `DelegationBudget.maxTokens`（针对整棵委派树的累计上限）更小的、针对这一个子 Agent 自己的 `maxTokens`（Day12 已有的单 Agent 内部预算机制）——两层预算各自管好自己最擅长的范围："这一个子 Agent 自己不能超支"交给它自己内部的 `TokenMeter`,"这一整棵委派树累计不能超支"交给 `DelegationBudget`,不是让外层的 `DelegationBudget` 越权去做只有内层才做得到的实时拦截。
