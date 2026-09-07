# Day 2・LLM 消息模型与流式协议

> 阶段：I. 最小但正确的内核　|　产出：`src/llm/types.ts`、`src/llm/block-assembler.ts`、`src/llm/fake-adapter.ts`

## 今天要学会什么

1. 理解一条对话消息（`Message`）不是一段文本，而是一个"类型化内容块"的数组。
2. 区分供应商各自的流式协议（wire event）和系统内部统一的 `StreamChunk` 事件。
3. 明白流式响应不能当字符串拼接：工具调用参数是分片到达的，中断时可能只有前缀，需要一个「组装器」把碎片拼回完整消息。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读 `mini-harness/src/llm/types.ts` 和 `mini-harness/src/llm/block-assembler.ts` 的源码和注释。
3. 做 [exercise.md](./exercise.md)：实现/补全 `BlockAssembler`，让它在 100 种随机分片下都能稳定组装出同一条消息，并跑通 `pnpm test`。

## 验收标准

- 同一条完整消息，经过 100 种随机分片方式喂给 `BlockAssembler`，组装结果字节级一致。
- 中断（`interruptedBlocks()`）时，未闭合的工具调用块绝不会出现在结果里；未闭合但有内容的文本/推理块会被保留并标记为已中断。
- 你能解释：为什么工具调用的 `arguments` 在流里必须是字符串而不是对象？
