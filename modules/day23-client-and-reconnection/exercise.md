# Day 23 实践任务

## 任务 1：亲手复现 study.md §4 那个真实的坑（分两步）

**第一步**：在 `src/client/reconnecting-stream.ts` 里，把判断"能不能停止重连"的那一行改回最初的（错误的）版本——只看有没有收到 `terminal`，不检查游标是否真的追上：

```ts
if (terminalLastSeq !== undefined && failure === undefined) return
```

重新跑：

```bash
pnpm vitest run tests/client-reconnection.test.ts
```

观察：8 个种子里有几个失败（提示：不是全部，也不是一个）。读一下失败信息——是断言失败，还是 `StreamGaveUpError`？想一想这个区别意味着什么（提示：`cursor` 最终有没有追上 `fullLog` 的最后一个 `seq`，和"要不要继续重连"这两件事被判断成了什么关系）。跑完改回来，确认全绿。

**第二步**：把第一步改回来之后，再去 `src/client/fault-injecting-transport.ts` 里，把 `alreadyCaughtUp` 这个判断去掉，回到"只看这次连接里有没有刚发出最后一条事件"：

```ts
if (deliveredFinalEvent && lastEvent?.type === 'turn/end') {
```

重新跑同一条测试命令。观察：这次失败的种子数量和第一步一样多吗？（提示：先自己猜一下，再跑出来验证——这两个坑是不是"只要修一个就够了"的关系,还是"两个必须都修"？）跑完记得也改回来，确认全绿。

## 任务 2：给 `runReconnectingStream` 加指数退避

现在 `retryDelayMs` 是一个固定值——不管连续失败了几次，每次重连前都等同样久。真实网络场景下，如果服务端本身就在过载（这也是为什么会一直连不上的原因之一），固定间隔的重连反而会持续给它增加压力。改成指数退避：第 N 次重试前，等待时间是 `retryDelayMs * 2^(N-1)`（可以设一个上限，别无限增长下去）。补至少两条测试：验证等待时间确实随失败次数指数增长、验证设了上限之后不会无限增长。

## 任务 3：一道思考题（不用写代码）

`study.md` §0 提到"持久流"（有 `seq`，可以按游标补洞）和"瞬态控制流"（没有历史可补，只能整份重发）是两种不同的东西——但今天的 `StreamEnvelope`/`Conversation`/`ReconnectingStream` 全部是按"持久流"这一种设计的。如果要给"模型正在流式吐第 N 个还没提交成正式 `SessionEvent` 的 token"这种瞬态状态也接一条独立的流，想一想：

1. 这条流还需不需要 `baseline`/`increment` 这两种 envelope？如果需要，它们的语义跟现在的定义一样吗（提示：现在的 `baseline.snapshot` 是"缺口之前的完整历史"，瞬态流有没有"历史"这个概念）？
2. `Conversation.cursor` 这个概念——按 `seq` 补洞——对瞬态流还成立吗？如果不成立，断线重连时客户端该怎么知道"该从哪里继续显示"？

## 验收自查

- [ ] `pnpm test` 全绿，包括你在任务1里临时改坏又改回来之后的状态、任务2新增的测试。
- [ ] 我能解释：任务1两步分别复现的是什么问题，为什么两个判断都要改，改一个不够。
- [ ] 我写完了任务3的思考题，给出了具体的设计方向，不是"应该也能用同一套"这种没有论证过的回答。
