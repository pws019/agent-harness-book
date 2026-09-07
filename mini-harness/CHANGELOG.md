# CHANGELOG

记录每个学习日在 `mini-harness/` 里新增/修改了哪些文件，方便对照 `modules/dayXX/` 的讲解内容。

## Day1（无代码）

Day1 是设计与决策日，产出在 `modules/day01-agent-vs-workflow/`（`product-scope.md`、ADR-001），本工程尚无代码。

## Day2：消息模型与流式组装

新增：
- `src/llm/types.ts` —— `ContentBlock`/`Message`/`StreamChunk`/`FinishReason`/`TokenUsage` 等内部统一类型。
- `src/llm/block-assembler.ts` —— `BlockAssembler`：把散乱到达的 `StreamChunk` 折叠成完整消息，支持中断恢复（`interruptedBlocks()`）、防御畸形流。
- `src/llm/fake-adapter.ts` —— `streamFake()`：确定性可复现的假流式 adapter，支持 4 种故障注入模式（`cut-mid-utf8`/`cut-mid-json`/`empty-response`/`duplicate-finish`）。
- `tests/block-assembler.test.ts` —— 111 条测试：100 种随机分片一致性、恶意/畸形流防御、中断恢复、故障注入。
