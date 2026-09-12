# 白话讲解：Adapter 边界与请求信封

> 素材来源：DSH `docs/subsystems/llm-streaming.zh.md`、`docs/cookbook/adding-an-llm-adapter.zh.md`。

## 0. 前置知识：重试与退避策略（面向没写过后端调用的读者）

前端调接口通常是"发一次请求，成功就用，失败就提示用户重试"，重试逻辑很少自己写。但调用外部服务（这里是 LLM provider）时，网络抖动、限流、服务端临时故障都是常态，"自动重试"是后端调用第三方服务的标配套路，这里补几个概念：

- **为什么不能无脑重试**：如果错误是"参数错了"（比如 400），重试 100 次结果都一样，纯粹浪费；只有"这次大概率是暂时性问题"（超时、503、429 限流）才值得重试。所以第一步永远是**把错误分类**（本节表格里的 `code`），而不是无差别地"失败就重试"。
- **指数退避（exponential backoff）**：第一次重试等 1 秒，第二次等 2 秒，第三次等 4 秒……延迟随失败次数指数增长。直觉：如果服务端正在被打垮，你越快重试只会让它更垮，间隔拉长给它恢复的时间。
- **抖动（jitter）**：在退避延迟上再加一点随机数。原因是如果 1000 个客户端同时在 t=0 失败，都严格按"等 2 秒"重试，2 秒后又会有 1000 个请求同时打过去，制造第二波过载（这叫"惊群效应"，thundering herd）。加一点随机抖动，让 1000 个客户端分散在 2~2.3 秒之间重试，就不会再次同时打满。
- **HTTP 状态码速查**（本节表格里 `status` 字段对应的东西）：`429` = 被限流（Too Many Requests，通常配合 `Retry-After` 响应头告诉你等多久）；`5xx` = 服务端错误，一般可重试；`4xx`（除 429）多数是你的请求本身有问题，重试没用。

`Object.freeze` 你可能在前端见过（防止某个配置对象被意外改写），这里的"深冻结"（deep freeze）只是递归版本：不只冻结最外层对象的属性，连它内部嵌套的每一层对象也一起冻结，这样"改嵌套字段"也会被拦下来。

## 1. 为什么 Agent loop 不该认识任何具体 SDK 类型

**先讲人话，画个图**：我们要解决的问题是——Agent loop 每一步都要"问模型接下来干什么"，但市面上有 Anthropic、OpenAI 好几家模型服务商，各家的 SDK 调用方式、参数名、返回格式全不一样。如果 Agent loop 的代码里直接写"调用 Anthropic 的 SDK"，以后想换成 OpenAI，就得把 Agent loop 内部到处改一遍。解法是在 Agent loop 和"具体某家 SDK"之间插一层"接线员"：Agent loop 只管往这个接线员那儿丢一个标准化的请求，接线员再负责翻译成具体某家 SDK 认识的格式。

调用关系画成图是这样：

```
Agent loop（调用方，今天的主角还不是它，Day5 才写）
    │
    │  ① 我要发一个请求，provider 想用 'anthropic'，model 想用 'claude-opus-4'
    ▼
AdapterRegistry（接线员总机，今天要写的东西）
    │
    │  ② 查表：'anthropic' 对应哪个适配器实例？
    ▼
AnthropicAdapter 实例（具体某个 provider 的接线员，以后接真实模型时才会写）
    │
    │  ③ 把请求翻译成 Anthropic SDK 认识的调用，真正发出网络请求
    ▼
Anthropic 的服务器
```

对应到代码里，"① 请求长什么样"和"接线员总机怎么查表"分别是这两个类型（对照 `mini-harness/src/llm/adapter.ts`）：

```ts
// ① Agent loop 要发的请求，跟具体哪家 provider 完全无关
interface GenerateOptions {
  readonly provider: string   // 比如 'anthropic'，告诉总机"我要找哪个接线员"
  readonly model: string      // 比如 'claude-opus-4'，具体型号，总机不关心它的含义，原样转交
  readonly messages: readonly Message[]
  readonly system?: string    // 一段用户看不见的独立指令（Day11 才会真正讲它是什么、怎么产出），今天先知道有这么个字段
  // ...其他采样参数
}

// 所有 provider 适配器的公共基类，唯一必须实现的方法就一个
abstract class LlmAdapter {
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

`AdapterRegistry`（②的总机）内部就是一个 `provider 字符串 -> LlmAdapter 实例` 的表（类似 `Map`）。整个流程串起来：调用方（以后是 Agent loop）构造一个 `GenerateOptions` 对象 → 总机读它的 `provider` 字段去表里查出对应的适配器实例 → 把整个 `GenerateOptions`（包括 `model` 字段）原样转交给这个适配器实例的 `stream()` 方法。`model` 字段在①②这两步里没人读懂它的含义、只是被当行李一样原样转发——只有到了③（具体的 `AnthropicAdapter` 内部）才会真正被读取、用去调用真实的 Anthropic SDK。DSH 原文里 `ctx.llm.registerAdapter(providers, adapter)` 就是做"往总机里登记一个接线员"这件事的 API。

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

**我们 MiniHarness 里的落地**：任何一个实现了 `LlmAdapter` 的适配器，它的 `stream()` 方法每被调用一次，只代表"一次 provider attempt"，重试循环在 `generateWithRetry()` 里，不在适配器内部。今天的练习会让你写一个继承 `LlmAdapter` 的 `FlakyAdapter`（`tests/adapter.test.ts` 里已有骨架），实现"前两次失败、第三次成功"的行为，来验证这条边界。

## 5. 重试策略：什么时候退、退多久

我们的 `RetryPolicy` 有两种模式：

- `normal`：有限次数（`maxRetries`），超过就放弃，把最后一次的错误原样返回给调用方。
- `always`：没有上限，一直重试（配合外层的用户主动取消一起用，比如"帮我盯着这个任务直到完成"这种场景）。

退避延迟用指数退避 + 抖动（jitter）：`delay = min(maxDelayMs, initialDelayMs * 2^(attempt-1))`，再加一点随机抖动防止多个并发请求同时在同一时刻重试造成"惊群效应"。

**一条不能违反的规则**：不管重试策略是什么，`ABORTED`（用户主动取消）永远不在可重试白名单里。这是刻意的——用户已经说了"不要了"，任何重试都是对用户意图的违背。

## 一句话总结

Adapter 层做的事情，本质上是把"provider 之间千差万别的协议、错误文案、计费口径"这些**必然存在的复杂性**，收进一个统一接口内部，让上层 Agent loop 只需要跟"一个抽象的模型"打交道。这正是"深模块"哲学在这一层的体现：接口很窄（`stream()` 一个方法），但要处理的边界情况一点不少。
