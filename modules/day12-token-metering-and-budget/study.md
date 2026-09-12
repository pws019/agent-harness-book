# 白话讲解：Token 计量、预算与成本控制

> 素材来源：DSH `docs/subsystems/token-meter.zh.md`。今天的主线是一条看起来简单、实际上很容易被写错的规则："不知道，就不能假装知道"。

## 0. 前置知识：为什么"没有数据"和"数据是0"必须严格分开

想象一个电商后台的销售报表，某天的数据因为日志系统故障没采集到。这时候报表该显示"0元"还是"数据缺失"？显示 0 会让人以为"这天真的没有任何销售"，做出错误的经营判断；显示"缺失"才诚实。**Token 计量要解决的是同一个问题**：如果某次调用 provider 没有返回用量数据（可能是网络问题、可能是这家 provider 压根不报告），程序不能因为"处理 `undefined` 比处理 `'unknown'` 更方便"就悄悄把它当成 0 用掉。

## 1. `TokenMeter`：一次"污染就回不去"的累加器

```ts
export interface TokenUsageTotals {
  readonly inputTokens: number | 'unknown'
  readonly outputTokens: number | 'unknown'
  readonly cacheReadTokens: number | 'unknown'
  readonly cacheWriteTokens: number | 'unknown'
}
```

`record(usage: TokenUsage | undefined)` 的行为,用真值表讲清楚："这次有没有报用量"和"之前累计的状态是不是已经变成 unknown"两个维度交叉：

| 之前的累计状态 | 这次 `record()` 收到的 | 之后的累计状态 |
|---|---|---|
| 数字 | 有 usage | 数字 + 这次的数字（正常累加） |
| 数字 | `undefined`（没报用量） | **永久变成 `'unknown'`** |
| `'unknown'` | 有 usage | 仍然是 `'unknown'`（回不去了） |
| `'unknown'` | `undefined` | 仍然是 `'unknown'` |

**"回不去"这条规则是故意的**：一旦有一次调用没有上报用量，你就已经**确定**漏掉了一段真实存在的用量。哪怕后面每次都乖乖报数字，把这些数字加回去也只能得到"一个更精确但依然错误的答案"——因为中间那段缺失的真实用量永远无法被还原。与其让一个"看起来完整"的数字给人虚假的安全感，不如坦白承认"这个总数已经不可信了"。

**缓存字段是例外**：`cacheReadTokens`/`cacheWriteTokens` 在一次正常上报的 `usage` 里如果缺失，记成 `0`，不会触发 `'unknown'`——因为很多 provider 压根不支持 prompt caching，"没有缓存用量"是一个正常、可预期的零，跟"这次调用整体的用量成谜"是完全不同的两件事。**同一个"缺失"，在不同的字段语境下代表完全不同的含义**，这是这个模块最容易被简化过头的地方。

## 2. `maxTokens` 预算：为什么选择 fail-closed

```ts
if (options.maxTokens !== undefined) {
  tokenMeter.record(result.usage)
  const totals = tokenMeter.totals()
  const spent =
    totals.inputTokens === 'unknown' || totals.outputTokens === 'unknown' ? undefined : totals.inputTokens + totals.outputTokens
  if (spent === undefined || spent > options.maxTokens) {
    // budget_exhausted / max_tokens
  }
}
```

这里有一个值得停下来想清楚的设计决定：**如果用量变成了 `'unknown'`，预算检查该怎么办？** 两个选项：

- **fail-open**（我们没选这个）：算不出确切花了多少，就跳过这次检查，让 turn 继续跑下去——赌"应该还在预算内"。
- **fail-closed**（我们选的）：算不出确切花了多少，就当作**已经超预算**处理，立刻停止。

选 fail-closed 的理由：`maxTokens` 存在的意义就是"控制成本、防止失控"，如果因为一次 provider 没报用量就悄悄放弃这项控制，`maxTokens` 这个配置在关键时刻反而形同虚设——而"关键时刻"往往就是出问题的时候（provider 异常、网络故障），这恰恰是最需要预算兜底的时候。这跟根 README 里"企业级 Agent 的核心不变式清单"第9条"sandbox 不可用时高风险操作故障关闭"是同一种思路：**能力失效时，选择更保守的一边,而不是悄悄放宽限制**。

**这不是唯一正确答案**——如果你的场景是"provider 偶尔不报用量是家常便饭，不该动不动就打断任务"，fail-open 也是合理的选择,只是需要额外的机制去补偿"预算可能被低估"的风险。今天选 fail-closed，是因为"控制成本"这个目标本身就应该偏保守。

## 2.5 已知简化：`maxTokens` 目前只管一个 turn，不管一次会话、更不管一个账号

`tokenMeter`（[agent-loop.ts:84](../../mini-harness/src/core/agent-loop.ts#L84)）是 `runTurn()` 函数体内的局部变量，每次调用都 `new` 一个全新实例——`maxTokens` 检查的是"这一个 turn 累计花了多少"，turn 一结束这份累计就清零，不会带到下一个 turn。

DSH 原始大纲里对 Day12 的要求其实是"建立单请求/单 turn/单 session **三层**预算"——我们只做了前两层（单请求靠 `TokenMeter.record()` 逐次累加，单 turn 靠这里的 `maxTokens` 检查），"单 session 累计"和更粗的"单账号累计"都没有实现。这是**刻意的简化，不是遗漏**：本课程是单用户单会话的学习项目，没有真实的多租户/控成本场景需要更粗粒度的预算兜底，提前搭这层复杂度只会增加认知负担却用不上——跟 Day6 不实现 `steer`/`inject`、Day9 Spill 不自动接进 `Agent.appendEvent()` 是同一类判断（YAGNI）。

**如果要升级到 `Agent` 层做会话级预算，大致方向是**：把 `TokenMeter` 的持有者从 `runTurn()` 内部的局部变量，提升成 `Agent` 类的一个实例字段（类似 `history`/`records`），每次 `drain()` 调 `runTurn()` 时传入这个共享实例而不是让 `runTurn()` 自己 `new` 一个；`maxTokens` 检查也要跟着变成两层——"这个 turn 花了多少"（沿用现在的逻辑）和"整个 session 至今累计花了多少"（读 `Agent` 持有的那份 `tokenMeter`）,两个上限可以配成不同的值。**如果还要再往上加"单账号"这一层**，就不能再放在某一个 `Agent` 实例身上了——一个账号完全可能同时开着好几个 `Session`/`Agent`,账号级别的累计必须存在**跨多个 `Agent` 实例共享**的地方（比如一个独立的 `AccountBudgetStore`，多个 `Agent` 在创建时注入同一个实例的引用），职责上更接近 Day26 大纲里"Subagent 全局并发/Token 预算"提到的那种"多个 Agent 实例共享同一份预算账本"的模式，而不是简单地在 `Agent` 类内部再加一个字段。

## 3. `usage` 存在哪：跟着 `assistant/message`，不单独开事件

```ts
'assistant/message': { readonly turn: number; readonly step: number; readonly message: Message; readonly usage?: TokenUsage }
```

`usage` 字段挂在 `assistant/message` 事件上，不是单独一种 `usage` 事件。原因：**这次调用的输出内容和这次调用的花费，是同一件事的两个侧面，不应该允许两者中的一个存在而另一个不存在**。如果分成两个独立事件，你就要考虑"万一 `assistant/message` 写进去了但 `usage` 事件因为某种原因没写"这种不该存在的中间态——合并成一个事件的可选字段，从结构上就排除了这种可能性。

**一个容易踩的实现细节**：`usage` 没有的时候,事件对象里**不能出现 `usage: undefined` 这个键**,必须是这个键完全不存在。原因是 Day8 定的 `isJsonValue` 规则——`undefined` 不是合法的 JSON 值,如果对象字面量里写了 `usage: event.usage`（`event.usage` 是 `undefined`）,这个属性依然会被 `Object.values()` 枚举到,导致校验失败。正确写法是用展开运算符按条件决定要不要带上这个键：

```ts
{ turn, step, message: event.message, ...(event.usage ? { usage: event.usage } : {}) }
```

## 一句话总结

今天的教训比前几天都朴素：**"不知道"和"零"是两个不同的事实,混淆它们会让系统在最需要诚实的时候（成本失控的边缘）撒谎**。`TokenMeter` 用一个"一旦污染就回不去"的累加器把这条原则钉死，`maxTokens` 的 fail-closed 选择把"不知道就当最坏情况处理"贯彻到预算控制上——两者都是同一条哲学在不同层面的落地。
