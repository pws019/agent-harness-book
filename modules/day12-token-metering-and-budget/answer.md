# Day 12 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. 为什么"没有上报用量"必须记成 `unknown`，不能记成 `0`；这条原则对缓存字段为什么不适用**

如果某次调用 provider 没有返回用量数据，记成 `0` 会让人以为"这次真的没花任何 token"，做出错误的成本判断；记成 `'unknown'` 才诚实。`TokenMeter.record()` 的规则是"一旦污染就回不去"：只要有一次没上报用量，累计状态就永久变成 `'unknown'`，哪怕后面每次都乖乖报数字也回不去——因为中间那段缺失的真实用量永远无法被还原，一个"看起来完整"的数字反而给人虚假的安全感。**但 `cacheReadTokens`/`cacheWriteTokens` 是例外**：这两个字段在一次正常上报的 `usage` 里如果缺失，记成 `0`，不触发 `unknown`——因为很多 provider 压根不支持 prompt caching，"没有缓存用量"是正常、可预期的零,跟"这次调用整体的用量成谜"是完全不同的两件事。同一个"缺失"，在不同字段语境下代表完全不同的含义。

**2. 预算检查在数据不完整时的两种设计选择**

fail-open（算不出确切花了多少就跳过检查，赌"应该还在预算内"）vs fail-closed（算不出就当作已经超预算，立刻停止）。我们选 fail-closed：`maxTokens` 存在的意义就是"控制成本、防止失控"，如果因为一次 provider 没报用量就悄悄放弃这项控制，`maxTokens` 在关键时刻（provider 异常、网络故障——恰恰是最需要预算兜底的时候）反而形同虚设。这不是唯一正确答案——如果场景是"provider 偶尔不报用量是家常便饭"，fail-open 也合理，只是需要额外机制补偿"预算可能被低估"的风险。

**3. Day8 讲过的坑再练一次：可选字段"键不存在" vs "键存在但值是 undefined"**

`usage` 字段挂在 `assistant/message` 事件上，没有的时候事件对象里**不能出现** `usage: undefined` 这个键——`isJsonValue`（Day8）规则下 `undefined` 不是合法 JSON 值，即使字面量写 `usage: event.usage`（`event.usage` 是 `undefined`），这个属性依然会被 `Object.values()` 枚举到，导致校验失败。正确写法是用展开运算符按条件决定要不要带上这个键：`{ ...(event.usage ? { usage: event.usage } : {}) }`。

## 验收自查

**为什么 `usage` 字段没有的时候，代码里要写成条件展开，而不是直接 `usage: event.usage`**：直接写 `usage: event.usage`，当 `event.usage` 是 `undefined` 时，产生的对象是 `{ ..., usage: undefined }`——这个对象**有** `usage` 这个 key，只是值是 `undefined`。`isJsonValue()` 遍历 `Object.values()` 时会遍历到这个 `undefined` 值，因为 `typeof undefined` 走不进 `isJsonValue` 里任何一个合法分支（null/string/boolean/finite number/array/plain object），直接判定失败，整条 `Session.append()` 会抛 `SessionAppendError`。用 `...(event.usage ? { usage: event.usage } : {})` 这种条件展开，`event.usage` 为 `undefined` 时展开的是一个空对象 `{}`，最终产生的对象里**根本没有** `usage` 这个 key（不是"key 存在值为 undefined"），能顺利通过 `isJsonValue` 校验——这正是 Day8 那条规则"用不上就干脆不要这个键，不要留下一个 `undefined` 值"在这里的第二次实践。
