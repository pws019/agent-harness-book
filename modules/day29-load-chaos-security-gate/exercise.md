# Day 29 实践任务

## 任务 1：亲手复现"客户端先等完成、再开流"这个 bug

在 `src/server/http-server.ts` 的 `handleEventsStream()` 里，删掉 baseline 发完之后新加的那段"已经追上"检查：

```ts
const snapshot = agent.sessionEvents.filter((event) => event.seq > since)
write({ kind: 'baseline', snapshot })

// 删掉下面这一整块
const lastEvent = agent.sessionEvents.at(-1)
if (!closed && lastEvent?.type === 'turn/end' && lastEvent.seq > since) {
  closed = true
  unsubscribe()
  write(terminalEnvelope(lastEvent.reason, lastEvent.seq))
  res.end()
}
```

重新跑：

```bash
pnpm vitest run tests/load-and-chaos.test.ts -t "30 concurrent"
```

确认这条测试**超时失败**（5秒）——因为这条测试的每个 session 都是先 `await` 发完消息、拿到响应之后才去开 `GET /events`，这时候 turn 已经彻底结束了，删掉的那段检查正是防住这种情况的关键。想一想：`tests/load-and-chaos.test.ts` 里另一条"200 次工具调用的长 stream"测试，为什么删掉这段代码之后**依然会通过**，不会暴露同一个问题（提示：看那条测试里"开流"和"发消息"这两步的先后顺序，跟你刚刚改坏的这条有什么不一样）。跑完记得把删掉的代码加回来，确认全部测试恢复通过。

## 任务 2：亲手验证 `Agent` 的 `SessionSink` 目前没有 Day28 那种保护

`study.md` §2 提到一个不对称的设计决定：`AuditingApprovalStore` 的 `AuditSink` 抛错会被吞掉，但 `Agent`/`session.ts` 的 `SessionSink` 抛错不会。写一条新测试，亲手证明这件事——构造一个 `Agent`，`deps.sink` 传一个 `append()` 永远抛错的假 sink，`send()` 一条消息，断言这次调用**确实会**导致问题传播出去（可能是 `agent.whenIdle()` 之后 `agent.records` 里出现异常状态，也可能是错误没有被吞掉、以某种方式冒出来——具体现象取决于 `Agent` 内部怎么处理，你需要先跑一遍看看实际会发生什么，再把观察到的现象写成断言，不要凭空猜一个期望值）。想一想：这个观察到的现象，跟"数据没有真的被持久化，但调用方毫不知情"比起来，哪个更糟——这也是 `study.md` 那张真值表想说明的道理。

## 任务 3：一道思考题（不用写代码）

`release-checklist.md` 里有 7 条标"部分通过"。挑其中一条（除了第16条,那条 `study.md` 已经讲得很细了），想一想：如果真的要把它从"部分通过"推到"完全通过"，具体需要补什么——是一段新代码,还是一个范围更大的重新设计？这个投入值不值得（提示：想一想这条不变式在什么场景下真的会被触发,触发的后果有多严重,再决定"部分通过"是不是已经是一个合理的止损点）。

## 验收自查

- [ ] `pnpm test` 全绿，包括你在任务1里临时改坏又改回来之后的状态、任务2新增的测试。
- [ ] `pnpm typecheck` 无错。
- [ ] 我能解释：为什么"30个并发session"那条测试会暴露这个 bug，"200次工具调用的长 stream"那条测试却不会——具体是哪一步的先后顺序不一样。
- [ ] 我写完了任务2的测试，亲眼观察到了 `SessionSink` 抛错时的真实行为（不是凭空猜的），并且能说出这个行为跟"数据没真的持久化、调用方却毫不知情"相比哪个更危险。
- [ ] 我写完了任务3的判断，挑了一条具体的"部分通过"不变式，给出了"值不值得推到完全通过"的理由。
