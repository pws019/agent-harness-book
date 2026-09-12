# Day 3 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. 用一层 Adapter 隔离 provider 差异**

`GenerateOptions{provider, model, messages, system?, ...}` 是跟具体 provider 无关的请求；`AdapterRegistry` 是一张 `provider 字符串 -> LlmAdapter 实例` 的表；`LlmAdapter` 抽象类只要求实现一个 `stream(options): AsyncIterable<StreamChunk>`。Agent loop、`BlockAssembler`（Day2）永远只 import `./types.js`/`./adapter.js`，不会有任何一行 import 具体供应商的包——这样运行时换/加 provider 不需要改 Agent loop 一行代码。

**2. 一次模型请求必须可重建**

`generateWithRetry` 会先把 `GenerateOptions` 深度冻结（`freezeRequest`/`deepFreeze`）再传给适配器——请求一旦要发出去就不能被中途篡改。深冻结只递归冻结"纯数据"（普通对象/数组），遇到 `AbortSignal` 这类"活的"平台对象直接跳过，不冻结也不递归进去（这个细节 Day6 会正式讲为什么必须这样）。

**3. 统一的错误分类**

`LlmFailureCode`（`EMPTY_RESPONSE`/`TIMEOUT`/`RATE_LIMITED`/`SERVER_ERROR`/`CONTEXT_WINDOW_EXCEEDED`/`ABORTED`/`UNSUPPORTED_OPTION`）是稳定、跟 provider 无关的机器路由码。"消费方按 code 路由，绝不依赖提供方文本"——不同 provider 报错文案千差万别，按统一 code 判断换 provider 不会失效。重试策略只对白名单里的可恢复 code 生效（`EMPTY_RESPONSE`/`TIMEOUT`/`RATE_LIMITED`/`SERVER_ERROR`），`ABORTED` 永远不在白名单里。

**4. 一次适配器调用 = 一次 provider attempt**

适配器内部禁止自己做库级重试——重试逻辑必须只存在于 `generateWithRetry()` 这一层，如果适配器内部也偷偷重试，上层的重试计数、日志、退避时间全部会失真。测试用的 `FlakyAdapter`（`tests/adapter.test.ts`）每次调用只代表一次 provider attempt，重试循环完全在 `generateWithRetry()` 里。

## 验收自查

**为什么"provider 说的 `retryAfterMs`"和"我们要不要重试"是两回事**：`providerRetryAfterMs` 是"经校验、由提供方请求的正数延迟"，只是一个**事实输入**（provider 说"请等 5 秒"）；是否真的重试、重试几次，是 `RetryPolicy` 这一层单独决定的策略。两者职责分开：provider 只负责汇报事实，重试与否、退避多久是我们自己的策略层说了算，不能让 provider 的建议直接替代我们的重试决策。

**如果适配器内部自己又做了一层重试，会破坏哪个假设**：会破坏"一次 `generateWithRetry` 循环体内只调用一次 `adapter.stream()` = 一次 provider attempt"这条假设——`attempts` 计数、日志记录的"这是第几次尝试"、指数退避的延迟计算全部基于这个假设。如果适配器自己偷偷重试了 3 次，上层看到的还是"1 次 attempt"，出问题排查时完全对不上实际发生的网络请求次数,退避策略的意义也被架空了（本该等 2 秒才重试，结果适配器内部立刻重试了好几次）。
