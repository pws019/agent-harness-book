# Day 2 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. `Message` 不是一段文本，是一个类型化内容块数组**

```ts
interface Message {
  readonly role: Role
  readonly blocks: readonly ContentBlock[]
}
```

`ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock`——这是我们 MiniHarness 有意先做的简化子集，不是 DSH 的能力上限。DSH 真实的 `ContentBlockMap` 还多了 `image`/`file`，但新增一种模态的门槛很高（要适配器/UI/压缩/持久回放路径同时支持），只砍到四种是为了先把 Runtime/组装/工具这套核心机制吃透。

**2. wire event vs `StreamChunk`**

`wire event` 是某个具体 provider（OpenAI/Anthropic）在网络上传输的原始格式，字段名、粒度、结束标记各家不同。`StreamChunk` 是一个封闭的、跟 provider 无关的联合类型（七种：`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`），适配器的活儿就是把 wire event 翻译成这七种之一。封闭联合类型 + `assertNever` 保证新增变体时,忘记处理它的地方会编译报错，不会留到运行时"某个事件类型悄悄没人处理"。

**3. 流式响应不能当字符串拼接**

流式协议的复杂性来自两层"分片"：网络层分片（TCP/HTTP，客户端库已经帮你缝合好了）和业务层分片（模型故意把内容拆碎发送，比如 `{"path": "a` 和 `/b.ts"}` 分两条 delta）。工具调用参数全程是字符串,不是对象,因为中间态是不完整 JSON,只有 `block-end` 触发、所有分片收齐之后才能安全 `JSON.parse`。`BlockAssembler` 就是那个把碎片折叠回完整块的组装器。

## 验收自查

**为什么 `arguments` 必须是字符串而不是对象**：因为流式传输中间态是不完整 JSON（比如流到一半只有 `{"path": "a/b`），对它调用 `JSON.parse` 会直接抛异常。只有等这个块所有分片都收齐、`block-end` 触发时，才拿到一个完整、可以安全解析的字符串——"先攒够，再统一解析"，不是"边流边解析"。

**"已闭合 index 拒绝新 delta"防的是什么问题**：防的不是网络乱序（同一条 TCP 连接本身就保证严格有序，`BlockAssembler` 不需要处理这类乱序），防的是**发送方自己的语义错误**——provider 服务端 bug 对同一个 index 发了两次 `block-end`，或者 `block-end` 之后又手滑发了一条 delta。这是"用设计定义掉特殊情况"：组装器直接拒绝处理垃圾输入，不让一个行为异常的适配器无限增长内存或破坏一个已经完成的块。
