# 白话讲解：Client model、Conversation 与重连语义

> 素材来源：DSH `docs/subsystems/web-client.zh.md`、`docs/subsystems/conversation.zh.md`。Day22 让服务端能流式推送事件；今天站到客户端这一侧——网络连接会断、会乱序、会重复投递，今天要写的是"断了之后怎么正确地接回去"，不是"正常情况下怎么收消息"。

## 0. 前置知识：为什么"断线重连"不是"再连一次就好了"

前端代码里"网络断了"通常意味着 `fetch()` 抛了个错，重试一次拿到新数据就完事——因为大多数请求是"要一份完整的当前状态"，不关心中间错过了什么。但今天的场景不一样：`GET /sessions/:id/events`（Day22）是一条会持续推送事件的连接，断线意味着**中间某一段事件可能根本没收到**——重新发起一次连接,如果服务端只给你"从现在开始的新事件",你会永远缺一段历史,派生出来的对话就是错的、缺失的。

这也是为什么 Day22 的 `StreamEnvelope` 要带 `seq`（`increment.event.seq`，复用 Day8 `SessionEvent.seq`）——**游标**（cursor）就是"我确认收到到哪里了"的书面记录,重连时把它带上,服务端才知道该从哪里继续给你补。今天要写的 `Conversation`/`ReconnectingStream` 就是客户端这一侧"怎么维护这个游标、怎么正确使用它"的具体实现。

## 1. 今天要加的是什么能力

Day22 的服务器已经能推流；但一个真实的客户端要面对四种服务端从不需要操心的情况：同一条事件被送达两次（网络层重传、或者客户端自己重连时重叠了一段）、事件到达的顺序跟它们被产生的顺序不一致、中间有一段彻底没收到（缺口）、以及连接在任务还没做完的时候断掉。今天新增的三个核心文件——`conversation.ts`（怎么合并）、`reconnecting-stream.ts`（怎么知道该重连、什么时候算真的完成）、`fault-injecting-transport.ts`（怎么在测试里可控地制造这四种情况）——分别回答"合并逻辑该怎么写"和"这个逻辑到底对不对"这两个问题。

## 2. 一次重连要经过哪些代码

```
runReconnectingStream(options, signal)                    ← reconnecting-stream.ts
  │
  ├─ since = conversation.cursor（-1 就传 undefined，意思是"给我完整历史"）
  │
  ▼
connector.connect(since, signal)                           ← StreamConnector 接口
  │        真实场景：HttpStreamConnector 打 GET /sessions/:id/events
  │        测试场景：FaultInjectingConnector 在内存里重放、故意制造故障
  ▼
for await (envelope of connector.connect(...))
  │
  ├─ conversation.applyEnvelope(envelope)                  ← 合并逻辑，见第3节
  │
  ├─ envelope.kind === 'terminal'   → 记下 lastSeq
  └─ envelope.kind === 'transport-error' → 记下失败
  │
  ▼
这次 connect() 的 for-await 循环结束了（正常结束，或者抛异常）
  │
  ├─ 收到了 terminal，且没有失败，且 conversation.cursor >= terminal.lastSeq
  │    → 真的完成了，返回
  └─ 否则 → 等一下（retryDelayMs），带着更新过的 cursor 重新 connect()
```

## 3. `Conversation`：为什么一个 `Map<seq, SessionEvent>` 加一个"确认到哪了"的指针就够

```ts
class Conversation {
  private readonly events = new Map<number, SessionEvent>()
  private highestContiguousSeq = -1
  // ...
}
```

**为什么用 `Map<seq, SessionEvent>` 天然解决"重复"和"乱序"**：`Map.set(seq, event)` 用同一个 key 写两次，第二次只是把内容原样覆盖一遍（`SessionEvent` 不可变，同一个 `seq` 对应的内容不会变）——重复投递不需要专门判断"这条是不是已经收过了",`Map` 的键唯一性本身就是去重逻辑。乱序也不需要专门处理：`Map` 不记录插入顺序对"最终有哪些 key"这件事的影响,`confirmedEvents`（[conversation.ts:52-58](../../mini-harness/src/client/conversation.ts#L52-L58)）读取时按 `seq` 数值从小到大遍历,不看写入的先后。

**为什么"缺口"不能用同样的思路解决，需要专门的 `highestContiguousSeq`**：`deriveMessages()`（Day8）要求输入是一段**连续、完整**的事件日志——它靠顺序处理 `turn/step` 的开闭配对来重建对话结构,如果中间缺了一段（比如 `seq=5` 没到，但 `seq=6/7/8` 已经到了）,直接把 `events` 里已有的内容（乱序但去重过的）一股脑扔给 `deriveMessages()` 会产生错误结果——不是"缺一段"这么简单,是"顺序被打乱的输入喂给一个假设顺序正确的函数"。`advanceContiguous()`（[conversation.ts:44-48](../../mini-harness/src/client/conversation.ts#L44-L48)）只在"下一个 seq 也已经到齐"的时候才前进指针,`confirmedEvents` 只读取 `0..highestContiguousSeq` 这一段——哪怕 `seq=6/7/8` 已经在 `Map` 里躺着,只要 `seq=5` 没来,`highestContiguousSeq` 就卡在 4,`confirmedEvents`/`messages` 也就只算到 `seq=4` 为止,不会把提前到达的 6/7/8 错误地并入派生结果。

**为什么 `cursor` 是 `highestContiguousSeq`,不是"见过的最大 seq"**：如果重连时带的游标是"见过的最大 seq"（比如上面例子里的 8）,服务端会以为"你已经拿到 0-8 的全部内容了",重发从 9 开始——但 `seq=5` 那个缺口永远不会被补上。`cursor` getter（[conversation.ts:69-71](../../mini-harness/src/client/conversation.ts#L69-L71)）返回的是确认连续的那个点,重连请求的是"缺口之前",服务端才会把缺口那一段重新发一遍。

## 4. `ReconnectingStream`：一个真实踩到的坑——"收到 terminal"不等于"真的同步完了"

第一版实现（写的时候没想到会有问题）判断"是否可以停止重连"的条件是"这次连接有没有收到 `terminal`"。写完故障注入测试、真的跑起来之后，8 个种子里有 4 个卡住：`Conversation` 最终的 `cursor` 明明已经追上了 `fullLog` 的最后一个 `seq`,但测试报的是"重试了 50 次还是没完成",不是断言失败——是真的抛出了 `StreamGaveUpError`。

**根因**：一次 `connect()` 里，如果中途丢了一条**不是最后一条**的事件（`dropProbability` 命中了中间某条,不是末尾那条),`connector` 依然会正常发出 `terminal`（因为"最后一条事件"本身确实送到了）——但这条连接实际上留下了一个缺口，`conversation.cursor` 卡在缺口那里,没有真的追到 `terminal.lastSeq`。第一版逻辑一看到 `terminal` 就直接判定"完成、不用再连了"，实际上缺口永远没有机会被下一次重连补上。

更隐蔽的第二层：修好第一层之后（加上"`cursor >= terminal.lastSeq` 才算数"这个校验)，还是有种子卡住——这次是因为**如果客户端带着一个已经追上了全部内容的 `since` 重连**（比如上一次连接因为 `disconnectProbability` 在快结束时被掐断,但缺口已经在那次连接里补完了),新一次 `connect()` 要重放的 `queue`（`fullLog.filter(seq > since)`）会是**空的**——服务端没有任何新东西要发，但这种情况下"最后一条事件是不是刚刚被送达"这个判断（只看"这次连接有没有新发出最后一条"）会认为"没有",于是不发 `terminal`，重连方永远等不到那个"可以停下来"的信号。

**修复**（[reconnecting-stream.ts:79-84](../../mini-harness/src/client/reconnecting-stream.ts#L79-L84) + [fault-injecting-transport.ts](../../mini-harness/src/client/fault-injecting-transport.ts) 里的 `alreadyCaughtUp` 判断）：两处都要改——`runReconnectingStream` 判断"能不能停"时,不能只看"这次有没有收到 `terminal`"，还要看 `conversation.cursor` 是不是真的追上了 `terminal.lastSeq`；连接器判断"要不要发 `terminal`"时,不能只看"这次连接有没有刚发出最后一条事件"，还要看"客户端带来的 `since` 是不是已经足够新，本来就不需要再发任何东西"。这两处任何一处漏掉，都会在"数据其实已经齐了，但信号系统没对上"这种边界情况下死循环重连。

这条坑跟 CLAUDE.md 点名的三个历史 bug（Day9 sink 转发漏掉、Day13 压缩区间重叠、Day14 截断续写）是同一个模式——**"合并逻辑"和"什么时候算完成"分别看都没问题,只有真的把两者串起来、带着大量随机故障组合跑很多轮，才会暴露"两边对'完成'这件事的理解不一致"这种问题**。这也是为什么故障注入测试要覆盖好几个不同的种子（`tests/client-reconnection.test.ts` 用了 8 个），只跑一个种子很可能永远不会踩中这个特定的时序组合。

## 5. `FaultInjectingConnector`：为什么不需要起真实 socket

Day22 的 backlog 超限已经示范过"把不确定的真实 IO 和确定的判断逻辑分开测"这个原则；今天的合并算法同样适用——`createFaultInjectingConnector`（[fault-injecting-transport.ts](../../mini-harness/src/client/fault-injecting-transport.ts)）拿一份**真实跑出来的**事件日志（用一个真 `Agent` 实例跑一个完整 turn 得到,不是手写的假数据）当权威真相,重放时用跟 Day2/3 `FakeAdapterOptions.seed` 同一个 `mulberry32` 种子 PRNG 决定"这一条要不要丢/复制/换序/提前断线"——同一个种子每次跑出同样的故障序列，测试结果可复现。真实 socket 层面的故障（连接真的断了、真的乱序）已经在 Day22 `tests/http-server.test.ts` 用真实 socket 验证过；今天要验证的是"合并算法本身对不对"，跟"真实网络会不会真的这样表现"是两个独立的问题，拆开测更容易定位问题出在哪一层。

## 一句话总结

`Conversation` 用一个按 `seq` 去重的 `Map` 加一个"确认连续到哪了"的指针，把重复/乱序两类问题变成数据结构天然解决的事，把缺口这一类问题变成一个显式的"不能提前跳过去"的规则；`ReconnectingStream` 的坑告诉我们，"收到了结束信号"和"数据真的完整了"必须分开验证,不能假设两者总是同步发生——这跟 Day19 `ApprovalStore` "全部校验通过才真正标记消费"是同一种谨慎：不要因为看到了一个看起来像"完成"的信号,就直接相信状态真的达成了,该检查的还是要真的检查一遍。
