# Day 28 实践任务

## 任务 1：亲手复现"没上报用量被悄悄当成 0"这条坑

在 `src/core/telemetry.ts` 的 `deriveTelemetry()` 里,把无条件调用改回"只在有值时才调用"的第一版写法：

```ts
case 'assistant/message': {
  const startedAt = stepStartedAt.get(`${event.turn}:${event.step}`)
  const latencyMs = startedAt !== undefined ? event.time - startedAt : 'unknown'
  if (typeof latencyMs === 'number') totalLatencyMs += latencyMs
  if (event.usage) meter.record(event.usage)   // ← 改成这样
  records.push({ kind: 'model-call', turn: event.turn, step: event.step, latencyMs, usage: event.usage })
  break
}
```

重新跑：

```bash
pnpm vitest run tests/telemetry.test.ts
```

确认"unreported usage makes totals — and therefore cost — unknown"那条测试失败——`report.totals.inputTokens` 变成了 `0`,不是期望的 `'unknown'`。想一想：`TokenMeter.record(usage)` 的设计本来就是"传 `undefined` 就翻成 `'unknown'`"，为什么"只在 `event.usage` 为真值时才调用 `record()`"这个看起来很自然的写法,反而让这条纪律失效了（提示：`meter` 的初始状态是什么？"从来没被调用过 `record(undefined)`"和"被调用过 `record(undefined)`"，对 `meter` 内部状态分别意味着什么）。跑完记得改回来，确认全绿。

## 任务 2：给 `AuditingApprovalStore` 加一个不依赖外部 sink 的历史查询

现在要看审计记录，只能靠调用方自己在构造时传一个 `AuditSink` 并且自己攒记录（`tests/audit-log.test.ts` 里的 `recordingSink()` 就是这么干的）。补一个 `history(): readonly AuditRecord[]` 方法，让 `AuditingApprovalStore` **无论有没有配置外部 `sink`**，都自己保留一份完整的记录历史,可以随时查询。想一想：

1. 这份内部历史列表要不要有上限（类比 Day22 `IdempotencyStore` 目前"完全没有清理机制、会无限增长"那条已经记录过的诚实缺口——`history()` 是不是正在重蹈同一个覆辙）？
2. `record()` 这个动作现在同时要做两件事——发给外部 `sink`（如果有）、追加进内部历史（一定要）——这两件事的顺序重不重要？如果外部 `sink.record()` 自己抛错了，内部历史还应不应该照常追加（提示：想一想根 `README.md` 企业级不变式清单第16条"telemetry sink 故障不能破坏主任务"，这条原则在这里具体应该怎么体现）？

补至少两条测试：一条验证没配置 `sink` 时 `history()` 依然能拿到完整记录；一条验证 `sink.record()` 抛错时,`create()`/`consume()`/`revoke()` 本身依然正常返回（不被这个错误传播出去打断），`history()` 里该有的记录也确实有。

## 任务 3：一道思考题（不用写代码）

`createRedactor()` 是纯字符串精确匹配——把传进去的每一个敏感值,在文本里原样替换成 `[REDACTED]`。想一想：如果某个凭据的真实值本身很短、很常见（比如一个只有三位数字的测试用 API key `'123'`，或者恰好是一个常见英文单词），把它当成"敏感值"逐字匹配替换,可能带来什么问题？这跟"正则猜测敏感信息"（比如"看起来像不像一串随机字符"）的思路相比，各自的风险点在哪（提示：一个是"精确匹配但可能误伤无关内容"，另一个是"模糊匹配但可能漏掉/滥杀更多"，两种脱敏思路适合放在同一个系统里叠加使用,还是应该二选一）？

## 验收自查

- [ ] `pnpm test` 全绿，包括你在任务1里临时改坏又改回来之后的状态、任务2新增的方法和测试。
- [ ] `pnpm typecheck` 无错。
- [ ] 我能解释：为什么"只在 usage 为真值时才调用 `record()`"这个看起来无害的写法，会让"未上报用量"和"上报了 0 用量"变成同一个结果——具体是 `meter` 内部哪个初始状态导致的。
- [ ] 我写完了任务2的 `history()` 方法，明确回答了要不要给历史列表设上限、`sink` 抛错要不要影响内部历史记录，给出了理由。
- [ ] 我写完了任务3的判断，具体说了精确匹配脱敏和模糊匹配脱敏各自的风险，不是笼统地说"两种都有道理"。
