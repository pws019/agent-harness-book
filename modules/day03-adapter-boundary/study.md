# 白话讲解：Adapter 边界与请求信封

> 素材来源：DSH `docs/subsystems/llm-streaming.zh.md`、`docs/cookbook/adding-an-llm-adapter.zh.md`。

## 1. 为什么 Agent loop 不该认识任何具体 SDK 类型

DSH 的 `LlmAdapter` 是一个抽象类，唯一必须实现的方法就一个：`stream(options): AsyncIterable<StreamChunk>`。`ctx.llm.registerAdapter(providers, adapter)` 把一个适配器实例注册到一组 provider 路由名（字符串）上，调用方用 `GenerateOptions.provider` 这个字符串去选适配器，`.model` 直接透传给该适配器处理。

cookbook 里举了个具体的价值案例："动态模型目录适配器无需重新配置生命周期即可提供新模型"——如果 Agent loop 直接 `import` OpenAI SDK 的类型或 Anthropic SDK 的类型，就没法在**运行时**通过配置切换/新增 provider。而且原文强调"重复提供方路由会原子失败"、注册基于副作用"可安全支持 HMR（热模块替换）"——这套接口是特意为"运行时可插拔"设计的，不是为了"看起来抽象"而加的一层包装。

**我们 MiniHarness 里的落地**：`LlmAdapter` 抽象类 + `AdapterRegistry`（今天的代码），Day2 写的 `BlockAssembler`、Day5 要写的 Agent loop，永远只 import `./types.js` 和 `./adapter.js`，不会有任何一行代码 import 具体供应商的包。

## 2. "一次模型请求必须可重建"是什么意思

这不是一句空洞的口号，原文给出了具体机制：调用配置（provider/model/reasoningEffort/采样参数）被存进一个专门的"请求信封"结构里，而不是每次都东拼西凑现算。更严格的是——**请求对象在真正发出前会被深度冻结**："到达 `llm/stream` 的请求会被深度冻结，因此变更会抛异常。" 如果哪个中间件想在请求送出去的路上偷偷改一个字段，会直接报错，而不是留下"实际发送内容和日志记录内容不一致"这种事后无法排查的隐患。

**类比**：这就像寄快递前先把包裹封箱贴好面单——面单上写的收件地址、物品清单，一旦封箱就不能再改，你要改只能重新拆开包一个新的。任何人想在运输途中偷偷往箱子里加东西，胶带（冻结）会直接告诉你"不行"。

**我们 MiniHarness 里的落地**：`generateWithRetry` 会先把 `GenerateOptions` 深度冻结（`Object.freeze` 递归），再传给 `adapter.stream()`。你可以在练习里试着去改一个字段，看它是怎么报错的。

## 3. 常见的 provider 错误分类

DSH 统一的失败载荷长这样（我们做了简化版）：

```ts
interface LlmFailure {
  readonly message: string          // 人类可读
  readonly code: string             // 稳定、跟 provider 无关的机器路由码
  readonly status?: number          // HTTP 状态码（如果有）
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}
```

关键的一条：`providerRetryAfterMs`——"是经校验、由提供方请求的正数延迟，而不是重试决策"。也就是说 provider 说"请等 5 秒"只是一个**事实输入**，是否真的重试、重试几次，是另一层策略（重试策略）决定的，两者职责分开，不能混在一起。

原文出现的错误 code 分类（我们照搬了这套思路）：

| Code | 含义 | 默认是否可重试 |
|---|---|---|
| `EMPTY_RESPONSE` | 模型返回了 `finish: stop` 但没有任何内容块 | ✅ 可重试 |
| `CONTEXT_WINDOW_EXCEEDED` | 上下文超限 | ❌（重试也没用，得先压缩上下文） |
| `TIMEOUT` | provider 响应超时（idle timeout） | ✅ 可重试 |
| `RATE_LIMITED` | 被限流 | ✅ 可重试 |
| `SERVER_ERROR` | provider 服务端错误 | ✅ 可重试 |
| `ABORTED` | 调用方主动取消 | ❌ 永远不重试 |
| `UNSUPPORTED_OPTION` | 某个字段这个 provider 不支持 | ❌ |

原文特别强调"消费方按 code 路由，绝不依赖提供方文本"——不同 provider 报错的文案千差万别（"rate limit exceeded" vs "too many requests"），如果按文本字符串判断，换个 provider 逻辑就失效了；按统一 code 判断则不会。

**为什么 `UNSUPPORTED_OPTION` 要显式报错，而不是静默忽略？** cookbook 原话："如果 `GenerateOptions` 中某个字段你的提供方无法支持……抛出 `LlmError(..., 'UNSUPPORTED_OPTION')`，而非静默丢弃。" 这是"用设计定义掉特殊情况"的又一个例子——宁可显式报错，也不要悄悄忽略一个用户配置的参数，让用户以为设置生效了但实际没生效。

## 4. "一次适配器调用 = 一次 provider attempt"

这条规则原文写得很直接："适配器禁用库重试。agent 层恢复会打开另一个持久、带编号的轮次；直接调用 `ctx.llm.stream()` 的调用方仍然只尝试一次。"

**白话理解**：假设你用的 HTTP 客户端库自带"网络超时自动重试 3 次"的功能，DSH 明确要求关掉它。为什么？因为重试逻辑必须**只**存在于一个地方（Agent loop / `generateWithRetry` 这一层），如果适配器内部也偷偷重试，上层的重试计数、日志记录、退避时间全部会失真——你以为只请求了一次，实际上背地里发生了 4 次网络请求，出问题排查的时候完全对不上。

**我们 MiniHarness 里的落地**：`FakeAdapter.stream()` 每次调用只代表"一次 provider attempt"，重试循环在 `generateWithRetry()` 里，不在适配器内部。今天的练习会让你写一个"前两次失败、第三次成功"的假 adapter，来验证这条边界。

## 5. 重试策略：什么时候退、退多久

我们的 `RetryPolicy` 有两种模式：

- `normal`：有限次数（`maxRetries`），超过就放弃，把最后一次的错误原样返回给调用方。
- `always`：没有上限，一直重试（配合外层的用户主动取消一起用，比如"帮我盯着这个任务直到完成"这种场景）。

退避延迟用指数退避 + 抖动（jitter）：`delay = min(maxDelayMs, initialDelayMs * 2^(attempt-1))`，再加一点随机抖动防止多个并发请求同时在同一时刻重试造成"惊群效应"。

**一条不能违反的规则**：不管重试策略是什么，`ABORTED`（用户主动取消）永远不在可重试白名单里。这是刻意的——用户已经说了"不要了"，任何重试都是对用户意图的违背。

## 一句话总结

Adapter 层做的事情，本质上是把"provider 之间千差万别的协议、错误文案、计费口径"这些**必然存在的复杂性**，收进一个统一接口内部，让上层 Agent loop 只需要跟"一个抽象的模型"打交道。这正是"深模块"哲学在这一层的体现：接口很窄（`stream()` 一个方法），但要处理的边界情况一点不少。
