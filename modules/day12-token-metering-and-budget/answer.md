# Day 12 答案

> 对照 [README.md](./README.md)「今天要学会什么」、[exercise.md](./exercise.md)「验收自查」和其中的思考题逐条作答。

## 今天要学会什么

**1. 为什么"没有上报用量"必须记成 `unknown`，不能记成 `0`；这条原则对缓存字段为什么不适用**

如果某次调用 provider 没有返回用量数据，记成 `0` 会让人以为"这次真的没花任何 token"，做出错误的成本判断；记成 `'unknown'` 才诚实。`TokenMeter.record()` 的规则是"一旦污染就回不去"：只要有一次没上报用量，累计状态就永久变成 `'unknown'`，哪怕后面每次都乖乖报数字也回不去——因为中间那段缺失的真实用量永远无法被还原，一个"看起来完整"的数字反而给人虚假的安全感。**但 `cacheReadTokens`/`cacheWriteTokens` 是例外**：这两个字段在一次正常上报的 `usage` 里如果缺失，记成 `0`，不触发 `unknown`——因为很多 provider 压根不支持 prompt caching，"没有缓存用量"是正常、可预期的零,跟"这次调用整体的用量成谜"是完全不同的两件事。同一个"缺失"，在不同字段语境下代表完全不同的含义。

**2. 预算检查在数据不完整时的两种设计选择**

fail-open（算不出确切花了多少就跳过检查，赌"应该还在预算内"）vs fail-closed（算不出就当作已经超预算，立刻停止）。我们选 fail-closed：`maxTokens` 存在的意义就是"控制成本、防止失控"，如果因为一次 provider 没报用量就悄悄放弃这项控制，`maxTokens` 在关键时刻（provider 异常、网络故障——恰恰是最需要预算兜底的时候）反而形同虚设。这不是唯一正确答案——如果场景是"provider 偶尔不报用量是家常便饭"，fail-open 也合理，只是需要额外机制补偿"预算可能被低估"的风险。

**3. Day8 讲过的坑再练一次：可选字段"键不存在" vs "键存在但值是 undefined"**

`usage` 字段挂在 `assistant/message` 事件上，没有的时候事件对象里**不能出现** `usage: undefined` 这个键——`isJsonValue`（Day8）规则下 `undefined` 不是合法 JSON 值，即使字面量写 `usage: event.usage`（`event.usage` 是 `undefined`），这个属性依然会被 `Object.values()` 枚举到，导致校验失败。正确写法是用展开运算符按条件决定要不要带上这个键：`{ ...(event.usage ? { usage: event.usage } : {}) }`。

## 验收自查

**为什么 `usage` 字段没有的时候，代码里要写成条件展开，而不是直接 `usage: event.usage`**：直接写 `usage: event.usage`，当 `event.usage` 是 `undefined` 时，产生的对象是 `{ ..., usage: undefined }`——这个对象**有** `usage` 这个 key，只是值是 `undefined`。`isJsonValue()` 遍历 `Object.values()` 时会遍历到这个 `undefined` 值，因为 `typeof undefined` 走不进 `isJsonValue` 里任何一个合法分支（null/string/boolean/finite number/array/plain object），直接判定失败，整条 `Session.append()` 会抛 `SessionAppendError`。用 `...(event.usage ? { usage: event.usage } : {})` 这种条件展开，`event.usage` 为 `undefined` 时展开的是一个空对象 `{}`，最终产生的对象里**根本没有** `usage` 这个 key（不是"key 存在值为 undefined"），能顺利通过 `isJsonValue` 校验——这正是 Day8 那条规则"用不上就干脆不要这个键，不要留下一个 `undefined` 值"在这里的第二次实践。

## exercise.md 任务4思考题：墙钟时间预算需不需要"unknown"这种状态

**不需要**——`TokenMeter` 那套"一旦 unknown 就回不去"的逻辑，根源是 token 用量这个数字**必须靠 provider（一个隔着网络、不完全可控的外部系统）主动汇报才能知道**：provider 完全可能这次响应就是没带用量字段，我们自己的进程哪怕一切正常，也没有办法凭空补上这个真相，只能诚实记成"不知道"。

墙钟时间不是这样：这个数字从头到尾是**自己的进程自己量出来的**——`Date.now() - turnStartTime`，两次读本机时钟做减法，不依赖任何外部系统"愿不愿意告诉你"。只要代码还在执行（能跑到判断超时的那一行），这个减法就一定能算出来，不存在"这段代码正常执行着，但这次没被告诉这个数字"的中间态，因为压根没有"被告知"这个环节。

- **"一个 turn 可能会超时"**：这恰恰反过来证明了墙钟时间从不缺失——正因为随时能读到准确的已耗时,才能拿它去判断"是不是超时了"；超时检测是"墙钟时间从不缺失"这个前提能成立的结果,不是反例。
- **"跑了一半进程没了"**：这不是"墙钟时间这一项数据碰巧丢了、其他都还在"的场景,而是整个进程内存里的一切（`TokenMeter` 累计到一半的数字、正在跑的墙钟计时器、`history` 数组……）一起消失——这是完全不同量级的问题，答案在 Day9 持久化/崩溃恢复，不是靠给某个字段标记 `unknown` 能解决的。

一句话：`unknown` 这个状态对 token 计量有意义，是因为它描述"一个外部信息源本该汇报却没汇报"这种真实可能发生的情况；墙钟计时不需要，因为它从不依赖外部信息源，进程活着就测得到，进程死了是另一类问题。所以墙钟预算不需要专门造一个"TimeMeter"类，`agent-loop.ts` 现在直接用 `Date.now() > deadline` 判断 `deadlineMs` 的方式已经是最简单、够用的形式。
