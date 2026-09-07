# Day 2 实践任务

## 任务 1：读代码，别只读讲解

打开这三个文件，逐行看懂再往下走：

- `mini-harness/src/llm/types.ts` —— `ContentBlock`、`Message`、`StreamChunk`、`FinishReason`、`TokenUsage` 的定义。
- `mini-harness/src/llm/block-assembler.ts` —— `BlockAssembler` 的实现。
- `mini-harness/src/llm/fake-adapter.ts` —— 一个假的、按随机分片吐出 `StreamChunk` 的 adapter，用来在没有真实模型的情况下测试组装器。

## 任务 2：动手改坏它，再修好

1. 运行 `pnpm test` 确认现有测试全绿。
2. 打开 `mini-harness/tests/block-assembler.test.ts`，找到 `"assembles a message identically across 100 random chunkings"` 这条属性测试，把随机种子改几次、把分片粒度调更细（比如每次只发 1 个字符），确认测试依然稳定通过。
3. 故意在 `block-assembler.ts` 里注释掉"已闭合 index 拒绝新 delta"的那段防御代码，重新跑测试，观察哪条测试会失败——这能帮你直观理解这条规则到底在防什么。改完记得恢复。

## 任务 3：先自己实现一遍 `interruptedBlocks()`，再对照参考实现

仓库里 `block-assembler.ts` 已经是**完整的参考实现**（这样你随时能跑通后续几天的代码）。真正的练习是：

1. 把 `interruptedBlocks()` 方法体临时删掉（或者复制一份 `block-assembler.ts` 改名成 `block-assembler.practice.ts` 再删），只留方法签名。
2. 不看参考实现，按 study.md 第 4 节的规则自己写一遍：
   - 已闭合的块：保留。
   - 未闭合但非空的 text/reasoning 块：保留。
   - 未闭合的 tool-call 块：丢弃。
3. 跑 `mini-harness/tests/block-assembler.test.ts` 里 `"interruption"` 这组测试，通过了再用 `git diff` 对比你写的和参考实现有什么不同——重点看边界条件（空文本块、多个未闭合块的顺序）是不是也一致。

## 任务 4：故障注入

在 `fake-adapter.ts` 里增加一个可配置的故障模式（保持现有正常模式不变，新增一个 `faultMode` 选项），至少覆盖：

1. 在一个 UTF-8 多字节字符中间断流。
2. 在一个未完成的 JSON 参数中间断流。
3. 返回一个没有任何内容块的空 `finish: stop`。
4. 连续发送两次 `finish` 事件。

针对每种故障写一条测试，断言 `BlockAssembler`/上层消费代码的行为符合预期（尤其是第3种，应该被判定为"可重试错误"而不是"正常完成"——可以先把这个判断逻辑写成一个 `classifyFinish()` 函数占位，Day3 会正式实现错误分类）。

## 验收自查

- [ ] `pnpm test` 全绿，100 种随机分片组装结果一致。
- [ ] 我能不看代码，讲清楚为什么 `arguments` 必须是字符串而不是对象。
- [ ] 我能解释"已闭合 index 拒绝新 delta"这条规则具体防住了什么问题。
