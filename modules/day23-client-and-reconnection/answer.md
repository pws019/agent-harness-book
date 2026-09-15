# Day 23 答案

> 对照 [README.md](./README.md)「今天要学会什么」、[exercise.md](./exercise.md)「验收自查」和其中的思考题逐条作答。

## 今天要学会什么

**1. 为什么游标必须是"确认连续"的 seq**

如果重连时带的是"见过的最大 seq"，中间有缺口的情况下服务端会以为"你已经拿到这之前的全部内容了"，重发从更靠后的地方开始——缺口那一段永远补不上。`Conversation.cursor` 是 `highestContiguousSeq`，只在"下一个 seq 也已经到齐"时才前进，保证重连请求的永远是"缺口之前"，服务端才会把缺口重新发一遍。

**2. `Map` 天然解决重复/乱序，缺口为什么不行**

`Map<seq, SessionEvent>` 的键唯一性让重复投递的第二次只是原样覆盖一遍（无副作用）；读取时按 `seq` 排序让写入顺序不影响最终结果。但 `deriveMessages()`（Day8）要求输入是连续、完整的日志——直接把 `Map` 里已有的（去重、但可能有洞的）内容喂给它会产生错误结果，不是"缺一段"这么简单。`highestContiguousSeq` 这个显式指针只在没有洞的前提下前进，`confirmedEvents`/`messages` 只读到这个指针为止,即使更靠后的内容已经提前到达,也不会被错误地并入派生结果。

**3. "收到 terminal"为什么不等于"同步完了"**

真实踩到的坑（见 study.md §4）：如果一次连接里中途（不是最后一条）丢了一条事件，`terminal` 依然会被正常发出——因为发 `terminal` 的判断只看"最后一条事件有没有送到"，不管中间有没有洞。第一版 `runReconnectingStream` 只要收到 `terminal` 就直接判定"完成、不用再连"，于是带着一个永远补不上的洞提前收工。修复需要两处都改：`reconnecting-stream.ts` 判断"能不能停"要加上"`cursor` 真的追到 `terminal.lastSeq`"这个校验；`fault-injecting-transport.ts` 判断"要不要发 terminal"要加上"客户端带来的 `since` 已经足够新、这次连接本来就没有新内容要发"这种情况（`alreadyCaughtUp`）——否则数据已经补齐了，但因为这次连接的 `queue` 是空的、没有"刚刚送达最后一条"这个信号，`terminal` 永远发不出去，同样会死循环。

**4. 为什么故障注入要用真实跑出来的事件日志**

手写一份假的事件序列很容易漏掉真实 `Agent` 会产生的边界情况（比如具体的 `turn/step` 开闭配对细节）。`recordRealSession()`（`tests/client-reconnection.test.ts`）真的构造一个 `Agent`、跑一个完整 turn、拿到 `agent.sessionEvents`——这样"权威真相"本身就是被 Day5-8 已经验证过的、真实可能产生的事件序列，不是凭空想象出来的测试夹具。

## 验收自查

**任务1两步分别复现了什么，为什么两个判断都要改**：亲手验证过——只回退 `reconnecting-stream.ts` 那一行判断（保留 `fault-injecting-transport.ts` 的 `alreadyCaughtUp` 修复），8 个种子里有 4 个失败（seed=2/4/42/1337，断言 `cursor` 没追到 `fullLog` 的最后一个 seq）；反过来只回退 `fault-injecting-transport.ts` 的 `alreadyCaughtUp`（保留 `reconnecting-stream.ts` 的修复），只有 1 个种子失败（seed=2），报的是 `StreamGaveUpError`（重试 50 次放弃），不是断言失败。这两个数字不一样（4 vs 1）说明两个坑不是"改一个就顺带解决另一个"的关系：前者是更根本、更容易触发的问题（一次连接中途丢一条非末尾事件就会中招）；后者是更边缘的情况（客户端带着已经追上的 `since` 重连、这次连接恰好没有新内容可发）——两者独立存在，`reconnecting-stream.ts` 那处修复不会自动让 `fault-injecting-transport.ts` 的问题消失,反之亦然,必须两处都改。

**任务2：指数退避设计方向**：`delay()` 函数（`reconnecting-stream.ts:37-46`）目前只接受一个固定 `ms`。改法是把 `attempt` 传进去，等待时间变成 `Math.min(retryDelayMs * 2 ** (attempt - 1), maxDelayMs)`——`attempt` 已经在 `runReconnectingStream` 的循环里维护着，不需要新增状态。测试上要验证两件事：连续失败时，第 N 次和第 N+1 次之间的等待时间确实是两倍关系（可以用 `vi.useFakeTimers()` 配合 `vi.advanceTimersByTimeAsync()` 精确控制，不用真的等）；以及设了 `maxDelayMs` 之后，重试次数再多，等待时间也不会超过这个上限。

**任务3：瞬态流的设计方向**：

1. **`baseline`/`increment` 的区分对瞬态流不再适用，至少语义完全不同**——现在的 `baseline.snapshot` 装的是"缺口之前的完整历史"，这个概念依赖"历史是可以被重新读取、重新发送的"（服务端记得住这些事件）。瞬态流按定义就是"没有被记录下来的、转瞬即逝的状态"（比如"模型正在流式吐的、还没提交成一条正式消息的 token"）——断线的时候，服务端根本没有"之前的" token 可以重发，因为那些 token 从来没有被当成需要持久化的东西对待。如果瞬态流也要有一个类似 `baseline` 的东西，它的语义应该是"当前这一刻的完整快照"（比如"目前为止已经吐出来但还没提交的完整文本"），而不是"过去某个时间点之后发生的一切"——本质上更接近"给我现在的状态"而不是"给我错过的历史"。
2. **`cursor`（按 `seq` 补洞）这个概念对瞬态流不成立**——瞬态流的内容根本没有一个持久化的、服务端愿意记住的编号序列，"缺口"这个概念本身就不存在（不存在"漏掉的历史"，只存在"当前状态"）。断线重连时,客户端该怎么知道"从哪里继续显示"这个问题的答案应该是：不需要知道，直接丢弃断线前收到的瞬态内容，重连成功后直接展示服务端立刻推来的"当前完整快照"——这跟持久流"不能丢任何一条、必须补全"的要求正好相反,是瞬态流"允许丢、只要能拿到最新状态就行"这条设计前提决定的。
