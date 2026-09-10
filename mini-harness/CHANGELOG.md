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

## Day7：里程碑一——可测试的单 Agent CLI

新增：
- `src/heuristic-adapter.ts` —— `HeuristicInvestigationAdapter`：不连真实模型的演示适配器，按固定策略调用 `list_files` → `search_text`，根据真实工具结果组织带证据的总结；接入真实模型只需另写一个实现 `LlmAdapter` 的类，`Agent`/`runTurn` 不用改。
- `src/cli.ts` —— `parseArgs()`/`runInvestigation()`/`main()`：把 Day1-6 的每一层（Agent → runTurn → generateWithRetry → ToolRegistry → 三个只读工具）接成一个可以 `pnpm cli` 直接跑的命令行调查工具。
- `tests/scenarios.test.ts`（20 条）—— 阶段一毕业验收：成功、证据不足、工具失败（未知工具/非法参数/文件不存在/路径越界）、预算耗尽、取消（含 dispose）、模型层错误重试/耗尽/不可重试、跨天回归守卫（Day5 冻结 bug、重复工具调用不误去重）。

至此 `pnpm test` 共 181 条测试全绿，`pnpm typecheck` 无错误。

## 增量补充：Day5-7 练习题落地

阶段一收尾之后，陆续把几天 exercise.md 里的练习任务补进了参考实现（不是新的一天，附在对应天数下）：

- **Day5 任务3**：`executeToolCall()` 对 `ToolTimeoutError`/`ToolAbortedError` 原样抛出而不是转成 `isError` 结果，`runTurn()` 接住后让整个 turn 提前以 `cancelled` 收场，跳过这一步剩下的工具调用（`agent-loop.ts`、`agent-loop.test.ts` +2 条）。
- **Day6 任务2**：`Agent.steer()`——在下一个 step 边界（而不是当前 step）插入引导消息，`AgentLoopOptions.pollSteering` 每个 step 开头轮询一次（`agent-handle.ts`、`agent-loop.ts`、`agent-handle.test.ts` +2 条）。
- **Day6 任务3**：竞态测试从1种交错模式扩到3种，各跑100轮（`agent-handle.test.ts` +2 条）。
- **Day6 任务4**：验证 `dispose()` 的 promise resolve 前后 `agent.status` 分别是什么，不只测最终状态（`agent-handle.test.ts` +1 条）。
- **Day7 任务3**：补场景21——验证连续两次 `send()` 之间，第二轮发给模型的请求确实带着第一轮的完整问答（`scenarios.test.ts` +1 条）。

至此 `pnpm test` 共 189 条测试全绿。

## Day8：仅追加事件日志与真源

新增：
- `src/core/session.ts` —— `Session`：仅追加事件日志，`append()` 写入前校验 payload 是无损 JSON（`isJsonValue`，跟 Day3/Day6 判断"纯数据"同一个思路）、校验 turn/step/tool-call 的开闭配对不变式，任何一条不满足直接抛 `SessionAppendError`。`deriveMessages(events)`：唯一允许把事件日志派生成 `Message[]` 的纯函数，`tool/result` 按 `(turn,step)` 分组合并成一条 tool 消息，跟 `runTurn()` 现在的行为对齐。
- `tests/session.test.ts`（18 条）—— JSON 校验的正反例、七种开闭配对非法序列、`deriveMessages` 的分组/纯函数/忽略非 surface 事件行为。
- 刻意没做的事：`Agent`/`runTurn` 还没有真的接到 `Session` 上（留给 Day9 引入持久化时一起做）；`system/message`/`request/header`/`session/end-seed` 等 DSH 完整事件表里的字段，等对应话题出现真实需求再加。

至此 `pnpm test` 共 207 条测试全绿，`pnpm typecheck` 无错误。

## Day9：持久化、flush 与崩溃恢复

新增：
- `src/core/agent-handle.ts` —— **真正把 `Session` 接进 `Agent`**：`history` 从手动维护的字段变成 `get history() { return deriveMessages(session.events) }` 派生视图；`drain()` 新增翻译层 `translateLoopEvent()`，把每个 `AgentLoopEvent` 同步翻译成 `Session.append(...)`；`runTurn()`/`agent-loop.ts` 未改一行。新增 `appendEvent()` 统一包一层"顺手转发给可选的 `deps.sink`"。新增 `static restore(deps, events)`：用 `Session.restoreFrom()` 从持久化事件重建，收尾任何挂起的活动。
- `src/core/session.ts` —— 新增 `Session.danglingActivity()`（读出当前挂起着什么）、`Session.restoreFrom(events)`（从既有事件重建，保留原始 seq/time）、`closeDanglingActivity(session, reason, sink?)`（诚实收尾：挂起的 tool/call 补一条 isError 的 tool/result，再补 step/end，最后写 turn/end；正常完成的 turn 也走这个函数，只是不需要补前两步）。
- `src/core/persistence.ts` —— `RawStore`/`InMemoryRawStore`（可注入的"假磁盘"，带 `corruptLine()` 故障注入接口）、`JsonlSessionStore`：仅追加 JSONL，header 校验格式版本号，`load()` 区分"最后一行损坏（丢弃，`truncated:true`）"和"中间一行损坏（整份拒绝）"。
- `tests/session-integration.test.ts`（6条）、`tests/persistence.test.ts`（6条）、`tests/persistence-integration.test.ts`（3条）、`tests/session.test.ts` 新增 11 条（`danglingActivity`/`restoreFrom`/`closeDanglingActivity`）。
- **修了一个真实 bug**：`closeDanglingActivity` 第一版直接调 `session.append()`，绕开了 `Agent.appendEvent()` 那层"顺手转发给 sink"的包装，导致收尾产生的事件（尤其是每个 turn 都会有的那条 `turn/end`）只进了内存里的 Session，没有镜像进持久化 store——集成测试一跑，`agent.sessionEvents` 和 `store.load().events` 对不上。修复：给 `closeDanglingActivity` 加一个可选 `sink` 参数。细节见 `modules/day09-persistence-and-crash-recovery/study.md` 第4节。

至此 `pnpm test` 共 233 条测试全绿，`pnpm typecheck` 无错误。

## Day10：投影、查询、标题与 Spill

新增：
- `src/core/session-projection.ts` —— `projectSummary(events)`（turn 数、按名字统计的工具调用次数、最后一次结束原因）、`queryEvents(events, {afterSeq, limit})`（按 seq 游标分页，不用数组下标）、`deriveTitle(events)`（摘第一条 user/message 当标题，记录来源 seq）。三个都是跟 `deriveMessages` 平级的纯函数，只挑自己关心的事件类型。
- `src/core/spill.ts` —— `SpillStore`/`InMemorySpillStore`、`spillLargeToolResults(events, store, maxContentLength)`：把超阈值的 `tool/result.content` 搬进 store，原地换成占位引用文本。跟 Day4 `search_text` 的截断策略解决同一类问题，但换了"引用/内容分离"而不是"截断丢弃"的手法；刻意做成独立的日志变换函数，没有实时接进 `Agent`（YAGNI）。
- `tests/session-projection.test.ts`（7条）、`tests/spill.test.ts`（5条）。

至此 `pnpm test` 共 245 条测试全绿，`pnpm typecheck` 无错误。

## Day11：系统提示词与能力组装

新增：
- `src/core/system-prompt.ts` —— `buildSystemPrompt(sections)`：无状态纯函数，从身份/工作区/工具列表/任务上下文四个固定分段拼系统提示词，不缓存任何东西。
- `src/tools/registry.ts` —— 新增 `ToolRegistry.undefine(name)`：撤销一次注册，返回这个名字之前是不是真的注册过。
- `src/core/session.ts` —— `SessionEventPayloadMap` 新增 `system/message`（`{turn, message: string}`），纯审计记录，`deriveMessages()` 跳过它，不产出消息（`GenerateOptions.system` 本来就是独立字段，`Role` 类型里没有 `'system'`）。
- `src/core/agent-handle.ts` —— `AgentDeps` 新增可选 `systemPrompt?: Omit<SystemPromptSections, 'tools'>`：配置了才会在每个 turn 开头组装并记录一条 `system/message`；`tools` 字段被类型系统排除在外，只能来自 `deps.tools.schemas()` 的实时快照，杜绝"传一份过期工具列表"的可能性。
- `tests/system-prompt.test.ts`（4条）、`tests/tools.test.ts` 新增 2 条（`undefine`）、`tests/session-integration.test.ts` 新增 3 条（`systemPrompt` 集成，包括"工具被移除后重新组装的 prompt 确实变了"）。

至此 `pnpm test` 共 254 条测试全绿，`pnpm typecheck` 无错误。
