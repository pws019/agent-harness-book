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

## Day3：Adapter 边界与请求信封

新增：
- `src/llm/adapter.ts` —— `LlmAdapter` 抽象类、`AdapterRegistry`（原子注册/幂等 dispose）、`LlmError`、`freezeRequest()`（深冻结请求）、`classifyFinish()`（空 completion → 可重试错误）、`RetryPolicy`/`generateWithRetry()`（指数退避、取消永不重试、"一次适配器调用=一次 provider attempt"）。
- `tests/adapter.test.ts` —— 14 条测试：注册表原子性/幂等、重试成功/耗尽/白名单外不重试、取消短路、请求冻结、退避延迟增长曲线。

## Day4：工具设计与执行管线

新增：
- `src/tools/types.ts` —— `JsonSchema`、`ToolDefinition`、`ToolResult`、分类错误（`ToolArgsError`/`ToolOutputError`/`ToolNotFoundError`/`ToolTimeoutError`/`ToolAbortedError`/`ToolExecutionError`）。
- `src/tools/schema-validate.ts` —— 极简 JSON Schema 校验器 + `assertExplicitAdditionalProperties()`（定义期强制工具作者声明未知参数策略）。
- `src/tools/registry.ts` —— `ToolRegistry`：统一的参数校验 → 取消检查 → 超时/取消赛跑 → 执行 → 结果渲染管线。**修了一个真实 bug**：取消检查必须在调用 `tool.execute()` 之前，而不是把已创建的 Promise 传进去再检查（调用 async 函数会同步跑到第一个 await）。
- `src/tools/workspace.ts` —— `resolveWithinRoot()`：字符串层面的路径越界防护（symlink 逃逸留给 Day15）。
- `src/tools/fs-tools.ts` —— 三个只读深工具：`read_file`/`list_files`/`search_text`，均带输出上限保护（截断+报告总数，不静默丢弃）。
- `tests/tools.test.ts`（19 条）+ `tests/fixtures/workspace/` —— 覆盖 schema 不泄漏实现细节、路径越界、参数校验、超时、取消时机等坏路径。

## Day5：Agent Loop

新增：
- `src/core/agent-loop.ts` —— `runTurn()`：turn/step 骨架，事件流（`turn-start`/`step-start`/`model-response`/`tool-call`/`tool-result`/`step-end`/`turn-end`），四态终止（`completed`/`cancelled`/`budget_exhausted`/`error`），工具失败转译为 `isError` 结果而不是让异常冒泡。
- `tests/agent-loop.test.ts`（8 条）—— 单步完成、工具调用往返、未知工具/非法 JSON 参数的故障注入、`max_steps`/`max_tool_calls` 预算耗尽、取消短路、终态事件与返回值一致性。
- **修了一个真实 bug**：`generateWithRetry` 的深度冻结会把 `messages: history` 这个可变数组本身冻住，导致 `history.push()` 抛异常——改传快照 `[...history]` 修复，细节见 `modules/day05-agent-loop/study.md` 第4节。

## Day6：生命周期、取消与并发

新增：
- `src/core/agent-handle.ts` —— `Agent` 类：`send()`（inbox 排队）、`cancel(cause, {keepInbox?})`（类型化取消原因、默认清空排队消息）、`dispose()`（幂等）、`whenIdle()`、单 writer 的 `drain()` 循环、`TurnRecord` 历史。
- `tests/agent-handle.test.ts`（9 条）—— 基本生命周期、排队处理、`whenIdle()` 语义、取消（含 `keepInbox`）、幂等释放、100 轮 cancel/send 竞态测试。

修了两个真实 bug：
- `agent-loop.ts`：`generateWithRetry` 通过异常路径传出的 `ABORTED` 失败被归类成了 `finish.kind === 'error'` 而不是 `'aborted'`，导致取消有时会被误判为普通错误。统一判定逻辑同时检查两种路径。
- `llm/adapter.ts`（Day3 埋下的雷）：`freezeRequest()` 的深冻结把 `options.signal` 指向的 `AbortSignal` 本身也递归冻结了，导致 `controller.abort()` 直接抛异常。改为只递归冻结纯数据（普通对象/数组），跳过 `AbortSignal` 等"活的"平台对象。
