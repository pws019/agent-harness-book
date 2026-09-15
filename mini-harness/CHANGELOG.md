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

## Day12：Token 计量、预算与成本控制

新增：
- `src/core/token-meter.ts` —— `TokenMeter`：累加 input/output/cache token 用量；任何一次 `record(undefined)`（provider 没上报用量）会让 input/output/cache 全部**永久**变成 `'unknown'`，后续再正常上报也回不去数字；单次上报里缺失的 cache 字段视为合法的 0，跟"整体用量成谜"是不同语义。
- `src/core/agent-loop.ts` —— `AgentLoopOptions` 新增 `maxTokens?`；`StopReason.budget_exhausted.reason` 新增 `'max_tokens'` 分支；预算检查选择 **fail-closed**：累计用量一旦变成 `unknown`，视为已超预算立刻停止，而不是悄悄放行。`AgentLoopEvent.model-response` 新增 `usage?` 字段透传 `GenerateResult.usage`。
- `src/core/session.ts` —— `TurnEndReason.budget_exhausted.reason` 同步加 `'max_tokens'`；`assistant/message` 事件新增可选 `usage?: TokenUsage`，跟输出内容存在同一条事件里，不单独开事件，避免"消息写了但用量没写"这种不该存在的中间态。
- `src/core/agent-handle.ts` —— 翻译层用条件展开 `...(event.usage ? { usage: event.usage } : {})` 写入 `usage`，确保没有用量时事件里连 `usage` 这个键都不存在（不是 `usage: undefined`）——再次踩中 Day8 `isJsonValue` 那条"undefined 不是合法 JSON 值"的规则，这次是主动避开，不是踩了才修。
- `tests/token-meter.test.ts`（5条）、`tests/agent-loop.test.ts` 新增 4 条（`maxTokens` 预算，含 fail-closed 场景）、`tests/session-integration.test.ts` 新增 2 条（usage 是否正确挂在 `assistant/message` 上）。

至此 `pnpm test` 共 265 条测试全绿，`pnpm typecheck` 无错误。

## Day13：上下文窗口与压缩

新增：
- `src/core/session.ts` —— `SessionEventPayloadMap` 新增 `compaction/start`（`{fromSeq,toSeq}`，校验范围必须落在已存在的 seq 内）、`compaction/summary`（`{message}`）、`compaction/end`（`{}`），三者必须按顺序配对出现，不改写、不删除被压缩范围内的原始事件。`deriveMessages()` 从单趟扫描改成两趟：先 `collectCompactionRanges()`（现已导出）收集完整的压缩区间，再正式派生时把落在某个区间里的 surface 事件跳过、换成一条摘要消息（区间第一次出现的位置插入，只插一次）。
- `src/core/compaction.ts` —— `planCompaction(events, {keepRecentSurfaceEvents})`：纯函数，决定压缩范围和摘要（今天只做确定性裁剪——把被压缩范围内的文本原样拼接，不调用任何模型）；`applyCompaction(session, plan)`：真正追加那三条事件（文档注明这三次 append 不是原子的，留给 exercise 任务3 修）。
- **修了一个真实 bug**：`planCompaction` 第一版只看"全部 surface 事件"，对同一段历史重复压缩时，新旧两个区间会算出相同的 `fromSeq`，`deriveMessages` 按 `fromSeq` 去重的机制把第二个摘要误判成"已经插过"，直接丢失。修复：`planCompaction` 先排除已经被 `collectCompactionRanges()` 覆盖的 seq，只在未压缩过的部分里规划新区间。细节见 `modules/day13-context-compaction/study.md` 第3节。
- `tests/compaction.test.ts`（5条，含"needle in a haystack"和重复压缩场景）、`tests/session.test.ts` 新增 7 条（`compaction/*` 开闭校验、`deriveMessages` 压缩替换行为）。

至此 `pnpm test` 共 277 条测试全绿，`pnpm typecheck` 无错误。

## Day14：里程碑二——可恢复的长会话

阶段二收尾。把 Day8-13 全部接进 Day7 的 CLI，用一条端到端测试证明整条链路在真实文件系统上收敛。

新增：
- `src/core/persistence.ts` —— `FileRawStore`：真实文件版的 `RawStore`，`appendFileSync`/`readFileSync` 同步读写，不做内存缓冲。`RawStore` 接口新增可选的 `truncateTo(count)`；`JsonlSessionStore.load()` 检测到 `truncated: true` 时会自动调用它，把损坏的尾巴从物理文件上真正切掉。
- `src/cli.ts` —— `CliArgs` 新增 `--session-file <path>`：文件不存在就 `JsonlSessionStore.create()`，已存在就 `load()` + `Agent.restore()`；新增两个子命令 `inspect-session <path>`（跑 Day10 的 `projectSummary()`/`deriveTitle()`）、`replay-session <path>`（跑 Day8 的 `deriveMessages()` 打印完整对话）。
- **修了一个真实 bug**：`load()` 第一版只在内存里丢弃截断的最后一行，磁盘上那条没有结尾换行符的垃圾原样留着——下一次 `appendLine()` 会把新事件直接拼在这条垃圾后面，两行粘成一行完全读不出来，"半行损坏"被续写变成了"整份读不出来"。修复：`RawStore` 加 `truncateTo`，`load()` 检测到截断后立刻调用它物理修复。细节见 `modules/day14-milestone-two/README.md`。
- `tests/persistence.test.ts` 新增 4 条（`FileRawStore` 真实文件读写、截断修复行为）、`tests/session-milestone.test.ts`（2条，端到端：完整调查落盘 + 模拟崩溃后用同一份文件继续调查）。
- **修了第二个真实 bug（自动化测试测不出来的那种）**：`main()` 用 `argv[0] === 'inspect-session'` 判断子命令，但手动执行 `pnpm cli -- inspect-session <path>` 时直接报了个不相关的"缺少 --query"错误。原因：有的 pnpm 版本会把 `pnpm run <script> -- <args>` 里的 `--` 原样转发，`argv[0]` 实际是字符串 `'--'`，子命令判断直接失配、落到默认调查分支。测试测不出来是因为 `tests/session-milestone.test.ts` 直接调用 `runInvestigation(parseArgs([...]))`，绕开了 `main()`/`process.argv` 这层——这是"胶水层代码只有真的跑一遍 CLI 才能验证"的一个具体例子。修复：`main()` 开头剥掉开头那一个（如果有）字面量 `'--'`。

至此 `pnpm test` 共 283 条测试全绿，`pnpm typecheck` 无错误。**阶段二（Day8-14，可回放的状态与上下文）完成。**

## Day14 之后、Day15 之前：两个小修复（未各自成篇）

不是新的一天，是继续巩固 Day10-14 时顺手发现并修的两个问题，没有对应的 `modules/` 文档：
- `src/core/compaction.ts` 的 `applyCompaction`：见 `modules/day13-context-compaction/exercise.md` 任务3、`modules/day13-context-compaction/answer.md`——加了前置校验，防止 `compaction/summary` 校验失败时留下一个永远关不上的"半开压缩"。
- `src/core/session-projection.ts` 的 `SessionProjection` 新增 `previousStopReason`（倒数第二个 `turn/end` 的 reason）：`lastStopReason` 只反映"日志里最后一个 turn/end"，崩溃恢复后紧接着的新 turn 一旦正常完成，`lastStopReason` 立刻变回 `completed`，看不出"上一次其实崩溃过"——`cli.ts` 的 `inspect-session` 现在会在 `previousStopReason?.kind === 'cancelled'` 时额外提示"上一次是被中断的"。

跑完这两个修复，`pnpm test` 共 297 条测试全绿。

## Day15：文件系统能力与一致性

阶段三开篇。第一次给 Agent 加写文件的能力，同时兑现 Day4 就留下的伏笔——`resolveWithinRoot` 当年只做字符串层面的 `../` 检测，注释里明确写着 symlink 逃逸留到今天处理。

新增：
- `src/tools/workspace.ts` —— `resolveWithinRoot` 升级成两道关卡：字符串层面的 `../` 检测（原有）+ 新增的 `safeRealpath` 真实路径比对，挡住"字符串上没有 `..`，但中间某一段其实是指向 workspace 外面的符号链接"这类逃逸。`safeRealpath` 顺着路径往上找第一个真实存在的祖先目录做 `realpath`，再拼回还不存在的那段路径，因此目标文件本身还不存在（比如要新建）时也能正确判断。
- `src/tools/file-io.ts`（新文件）—— `contentHash()`（sha256）、`looksBinary()`（采样找 NUL 字节的二进制探测）、`writeFileAtomic()`（先写临时文件再 rename，避免半写状态）、`simpleDiff()`（裁掉公共前后缀的朴素行级 diff，不是真正的 LCS 算法，只够预览用）。
- `src/tools/fs-tools.ts` —— `read_file` 新增 `MAX_FILE_BYTES`（2MB）大小限制、二进制检测、输出新增 `contentHash` 字段。新增 `edit_file`：Day15 第一个写工具，一个深接口同时覆盖新建/覆盖/`dryRun` 预览三种意图，`expectedHash` 提供乐观并发控制（文件已存在必须提供且匹配当前磁盘哈希，否则拒绝覆盖，不做"最后写入者获胜"）。`edit_file` 目前只在工具层存在，没有接入 `cli.ts` 的调查 Agent（那个 Agent 按设计是只读调查工具，见 `docs/product-scope.md`）。
- `tests/tools.test.ts` 新增 7 条（`edit_file` 创建/覆盖/dryRun/hash 不匹配/二进制拒绝），`tests/fs-tools-integration.test.ts`（新文件，7条）：symlink 逃逸（`read_file`/`edit_file`/workspace 内部的合法 symlink 三种情况）、超大文件、二进制文件、只读目录权限失败、以及一条贯穿 `read_file` → `edit_file` → `read_file` → 用旧 hash 再编辑一次的跨工具集成测试（验证 hash 真的在两次调用之间正确传递、并在成功编辑后正确轮换，不是分别测试两个工具各自都对）。

至此 `pnpm test` 共 311 条测试全绿，`pnpm typecheck` 无错误。

## Day16：子进程与 Bash 执行

第一次让 Agent 跑真正的操作系统进程，不再是相对可控的文件读写——命令可能永不退出、可能自己再 fork 出别的进程、可能疯狂往外吐数据。

新增：
- `src/tools/process-runner.ts`（新文件）—— `runProcess(spec, signal)`：真正 spawn 子进程的底层函数。`spawn(command, args)` 不用 `shell: true`，`argv` 数组原样传给 `execve()`，`;`/`|`/`$()` 只是字面字符，从设计上排除命令注入。`BoundedCollector` 收集 stdout/stderr：永远消费管道数据（防止管道写满导致子进程被操作系统阻塞卡死），超过 `maxOutputBytes` 后只丢弃不再保留，标记 `truncated`。`detached: true`（POSIX）让子进程成为新进程组的组长，超时/取消都用 `process.kill(-child.pid, 'SIGKILL')` 杀整个进程组，不只是 `child.pid` 这一个进程——防住子进程自己 fork 出的孙进程变成孤儿继续跑。
- `src/tools/bash-tool.ts`（新文件）—— `createRunCommandTool(root)`：`run_command` 工具定义。`env` 是白名单（默认只有 `PATH` + 调用方显式传入的变量，不继承宿主进程 `process.env`）。`timeoutMs` 有调用方可请求的上限（60s），注册进 `ToolRegistry` 的 `timeoutMs` 故意设得更宽松——那只是"`runProcess()` 内部逻辑真的挂了"才会触发的安全网，真正杀进程靠 `runProcess()` 自己独立的超时/取消处理。`cwd` 复用 Day15 的 `resolveWithinRoot`。`run_command` 目前只在工具层存在，没有接入 `cli.ts` 的只读调查 Agent。
- **一个值得记录的设计陷阱（不是踩出来的 bug，是提前发现并绕开的）**：Day4 的 `ToolRegistry` 超时机制（`Promise.race`）只会让外层 Promise 提前落空，不会取消/杀掉 `tool.execute()` 内部真正启动的子进程——如果 `run_command` 只依赖这层超时，会造成真实的操作系统进程泄漏。`runProcess()` 必须自己维护独立的 `setTimeout` 去调用 `process.kill()`。细节见 `modules/day16-subprocess-and-bash/study.md` 第3节。
- `tests/process-runner.test.ts`（9条，底层故障注入）：输出洪水（bounded 且不卡死）、永不退出（超时杀掉）、fork 子进程（进程树被真正回收，用一个持续写 marker 文件的孙进程验证，不是猜的）、env 泄漏（宿主 secret 不会出现在子进程里）、取消竞态。`tests/run-command-tool.test.ts`（9条，工具层，含经过 `ToolRegistry` 的端到端验证）：参数校验、cwd 越界/不存在、env 白名单在工具层同样成立、内部超时远早于 registry 安全网触发、取消同时让外层调用落空和真正杀掉进程（marker 文件验证）。

至此 `pnpm test` 共 329 条测试全绿，`pnpm typecheck` 无错误。

## Day17：PTY、后台任务与资源所有权

不做真正的 PTY（原始大纲标注"选做"，`node-pty` 这类原生依赖跟项目零原生依赖的定位不符）。核心是引入一种跟"工具调用"完全不同形状的生命周期——后台任务。

新增：
- `src/tools/process-runner.ts` —— 重构出 `spawnManaged(spec, signal): ManagedProcess`：立刻返回一个句柄（`stdoutSnapshot()`/`stderrSnapshot()` 可以在跑完之前随时读取当前输出、`done` 跟旧版一样是最终结果、`cancel()` 复用同一套杀进程树逻辑），`runProcess()`（Day16 原有的唯一入口）退化成 `return spawnManaged(spec, signal).done` 这一行。Day16 写的 18 条测试全部只认 `runProcess()` 这一个签名,一行没改、全部保持通过——验证了"深模块加新能力不改窄接口"这条原则。
- `src/core/job-runtime.ts`（新文件）—— `JobRuntime`：`start(spec)` 立刻返回 jobId 不等待完成；`poll(jobId)` 返回有界快照（复用 `spawnManaged` 的实时读取能力）；`cancel()` 对不存在的 id 抛 `JobNotFoundError`（调用方记错 id 是 bug，值得暴露），`dispose()` 对不存在的 id 是安静的 no-op（幂等释放，跟 Day6 `Agent.dispose()` 同一套心智模型），对还在跑的 Job `dispose()` 会先杀掉再清理记录（"创建者拥有清理责任"）。
- `src/tools/job-tools.ts`（新文件）—— `start_job`/`job_status`/`cancel_job` 三个工具，不接入 `cli.ts`。
- **诚实的设计边界**：`JobRuntime` 状态只在内存里，不持久化进 Session 日志——进程重启后没有"可恢复的 Job"，只有"已失联的 Job"。study.md 第4节给出了如果要做真正可恢复 Job 需要往哪个方向设计（持久化 `SpawnSpec`+pid、重启时探活），但明确没有实现，属于当前范围内的 YAGNI。
- `tests/job-runtime.test.ts`（8条）、`tests/job-tools.test.ts`（6条）：`start()` 不阻塞、终态只出现一次、`cancel()`/`dispose()` 真正杀掉进程树（marker 文件验证，不是猜的）、幂等语义、经过 `ToolRegistry` 的端到端验证。

至此 `pnpm test` 共 343 条测试全绿，`pnpm typecheck` 无错误。

## Day18：沙箱与最小权限

不做真正的 OS 级沙箱（容器/网络 namespace 超出项目零外部运行时依赖的定位，原始大纲自己也承认 DSH 的 sandbox seam 不覆盖网络/进程可见性）。真做的是策略/执行分离、fail-closed、书面威胁模型、跨天红队回归。

新增：
- `src/tools/command-policy.ts`（新文件）—— `CommandPolicy` 接口（纯判断，不碰 I/O）、`AllowlistCommandPolicy`、`FailClosedCommandPolicy`（策略求值本身抛异常时拒绝而不是默认放行）。
- `bash-tool.ts`/`job-tools.ts` 的 `createRunCommandTool`/`createStartJobTool`/`createJobTools` 新增可选的 `policy` 参数,在真正 resolve 路径/spawn 之前先过一遍策略。没传策略时行为不变（今天默认关闭，接进去才生效）。
- `modules/day18-sandbox-and-least-privilege/threat-model.md`（新文档）—— 资产/信任边界/攻击者/入口点/影响/缓解措施六段式威胁模型，覆盖 Day15-17 的执行类能力。明确把"网络外传"标为**接受的缺口**（`CommandPolicy` 挡得住"不许跑 curl"，挡不住"被允许的 node 脚本自己发网络请求"），不假装解决。
- `tests/command-policy.test.ts`（3条）、`tests/command-policy-integration.test.ts`（5条）：策略类本身的单元测试 + 真正接进 `ToolRegistry.execute()` 全流程的集成测试（两者验证的层次不同,见 exercise 任务1的对比）。
- `tests/red-team-regression.test.ts`（7条）—— 把原始大纲点名的5种红队场景（prompt injection 读密钥、shell 特性绕过、symlink 逃逸、网络外传、fork bomb）逐条重新验证一遍,大部分复用 Day15-17 已经验证过的机制,不是重复造轮子；网络外传那条测试故意写成"一条证明缺口真实存在 + 一条证明部分缓解确实生效"，对应威胁模型里"诚实记录缺口"的写法。

至此 `pnpm test` 共 358 条测试全绿，`pnpm typecheck` 无错误。

## Day19：审批、权限预设与用户问答

只交付 `ApprovalStore`/`UserInteractionRequest`/三个权限预设这几个独立机制，不改动 Day5 `runTurn`——真正接进循环留到 Day21 milestone。

新增：
- `src/core/approval.ts`（新文件）—— `UserInteractionRequest`：`question`/`choice`/`approval` 三种交互类型的封闭联合类型，不共用含糊的 yes/no（`assertNever` 兜底，跟 `StreamChunk`/`SessionEvent` 同一套手法）。`ApprovalStore`：`create()` 记录一次审批请求（`argsHash` 复用 Day15 `contentHash` 的乐观并发控制思路，绑定具体参数而不是泛泛的"继续"）；`consume()` 四个校验（nonce 存在/未消费/未过期/参数哈希匹配）分别对应原始大纲点名的重放、双击批准、过期回复、批准后换参数四种故障场景；只有全部校验通过才真正标记消费——参数不匹配这类失败不会顺带烧掉 nonce，留一次用正确参数重试的机会。
- `src/core/permission-presets.ts`（新文件）—— `readonly`/`balanced`/`autonomous` 三个 preset，都吃一份显式的"哪些工具是只读的"集合（不靠猜工具命名规律），分别把非只读工具映射成 `deny`/`require-approval`/`auto-approve`。
- `tests/approval.test.ts`（6条）、`tests/permission-presets.test.ts`（3条）：四种故障场景各一条回归测试，外加"参数不匹配不会连累后续正确重试"这条设计决定的专门验证。

至此 `pnpm test` 共 367 条测试全绿，`pnpm typecheck` 无错误。

## Day20：凭据、设置、存储与工作区

只做一个概念性的核心决定——凭据在系统里只以不透明引用流动、真实值只在使用点解析；不对已有 `createXTool(root: string)` 做全面的 Workspace 签名重构（机械改动、概念价值有限），只在 `run_command` 上做一次示范。

新增：
- `src/core/credentials.ts`（新文件）—— `CredentialRef`（`{id}`，不含真实值）、`CredentialStore` 接口、`InMemoryCredentialStore`。`resolve()` 查不到显式抛 `CredentialNotFoundError`，不返回 `undefined`/空字符串静默放过。
- `src/core/settings.ts`（新文件）—— `mergeSettings(layers)`：后面的层覆盖前面的层，每个 key 的结果带 `source`（哪一层给的）。"某层没设置某 key"和"某层把这个 key 设成 falsy 值"天然靠 `Object.entries()` 只遍历真正存在的 key 区分开，没有额外写判断逻辑。
- `src/core/workspace-context.ts`（新文件）—— `WorkspaceContext`：`{root, credentials, envCredentials?}`，把"工作区"从单纯的 cwd 字符串扩成身份/能力边界。
- `bash-tool.ts` 的 `createRunCommandTool(root, policy?, workspace?)` 新增可选的 `workspace` 参数——`workspace.envCredentials` 在真正 spawn 前解析成真实值注入子进程环境，合并顺序故意放在 `args.env` 之后，让 workspace 配置的凭据能覆盖模型自己传的同名变量（模型不能靠传同名 env 顶替掉工作区凭据）。没传 `workspace` 时行为与之前完全一致。
- `tests/credentials.test.ts`（3条）、`tests/settings.test.ts`（4条，含"falsy 值是真覆盖不是没设置"回归）、`tests/workspace-context-integration.test.ts`（3条，含"模型无法用同名变量顶替 workspace 凭据"的跨模块集成测试）。

至此 `pnpm test` 共 377 条测试全绿，`pnpm typecheck` 无错误。

## Day21：里程碑三——安全执行型 Agent

阶段三收尾。不引入新概念，把 Day15-20 各自独立验证过的机制第一次真正串成一条能从 CLI 跑起来的链路。

新增：
- `src/propose-edit.ts`（新文件）—— `generateEditProposal()`：确定性查找替换生成新内容（Day7 `HeuristicInvestigationAdapter` 同款"用写死规则代替真实模型"思路）。`proposeEdit()`：读文件 → 生成提案 → `ApprovalStore.create()`（Day19）→ 按 `PermissionPreset`（Day19）决定是否需要人工确认 → 批准则 `consume()` 烧掉 nonce → 用 `ToolRegistry` 真正执行 `edit_file`（Day15）→ 有 `--verify-command` 就再执行一次 `run_command`（Day16，可选接 Day18 `CommandPolicy`）。文档注释里明确记录一个诚实缺口：`consume()` 发生在 `edit_file` 之前，两者之间的竞态会导致"批准已消费但写入失败、且不能重试同一个 nonce"，权衡取舍见 `modules/day21-milestone-secure-agent/README.md`。
- `cli.ts` 新增 `propose-edit` 子命令，默认审批实现是真的读 stdin 问一句（`readline/promises`），`--preset readonly|balanced|autonomous` 接入 Day19 权限预设。手动跑过 `pnpm cli -- propose-edit`（批准/拒绝/两种 preset）确认命令行参数解析和交互流程真的可用，不是只有单元测试覆盖。
- `tests/propose-edit.test.ts`（11条）—— 覆盖批准写入、拒绝不写入、无变更不生成审批请求、`autonomous`/`readonly` 两种 preset 各自的行为、验证命令成功/失败两种结果、以及"审批消费和落盘之间的竞态"这个诚实缺口的专门回归测试。
- `modules/day21-milestone-secure-agent/security-test-index.md`（新文档）—— 25 条安全回归测试的跨天索引，逐条标注真实存在且已跑通的 file:line，覆盖路径逃逸/symlink/TOCTOU/子进程环境隔离/shell 注入/网络外传缺口/资源耗尽/fail-closed/取消杀进程/审批一次性/权限预设/凭据不泄漏/里程碑三集成 13 个分组，不是凭空新写的 25 条。
- `modules/day21-milestone-secure-agent/incident-drill.md`（新文档）—— 一次假设的"自动化脚本被投毒、试图往 CI 配置里加数据外传命令"事件演练，走一遍发现/止血/复盘，用表格说明这次事件里权限预设、审批摘要展示、`expectedHash`、`CommandPolicy` 各自起到（或没起到）什么作用。

至此 `pnpm test` 共 388 条测试全绿，`pnpm typecheck` 无错误。阶段三（Day15-21）全部完成。

## 增量补充：Day16 任务2 落地

- **Day16 任务2**：`stdout`+`stderr` 合计输出上限。`SpawnSpec` 新增可选的 `maxTotalOutputBytes`；把原来 `BoundedCollector` 内部自己算余量的逻辑拆成一个独立的 `OutputBudget` 类（`spend(byteLength)` 返回实际允许写入的字节数），`BoundedCollector` 改成向外面传进来的 `OutputBudget` 要额度，不再自己持有 `maxBytes`——默认（没给 `maxTotalOutputBytes`）时 stdout/stderr 各自拿一个独立的 `OutputBudget` 实例（跟原来行为完全一致，Day16 原有 18 条测试不改一行、全部保持通过）；给了 `maxTotalOutputBytes` 之后，两者改成共享**同一个** `OutputBudget` 实例，谁先写谁先占额度，加起来封顶在合计上限（`process-runner.ts`、`process-runner.test.ts` +3 条：只有 stdout 写多、只有 stderr 写多、两边交替写）。

至此 `pnpm test` 共 391 条测试全绿。

## 增量补充：Day17/19/20 任务2 落地

- **Day17 任务2**：`job_status` 的 `elapsedMs` 冻结语义。`JobRuntime` 在 `start()` 记录 `startedAt`，一旦任务到达终态（`completed`/`cancelled`/`error`）立刻冻结 `endedAt`；`poll()` 报告的 `elapsedMs` 在运行期间持续增长，终态之后固定不动，不会在任务早就结束之后还在"继续计时"（`job-runtime.ts`、`job-runtime.test.ts` +2 条）。`answer.md` 任务3补了"并发上限该抛什么"的返回值设计半边：跟已有的 `JobNotFoundError` 对称,新增 `JobCapacityExceededError`。
- **Day19 任务2**：`ApprovalStore.revoke()`。新增 `ApprovalRevokedError`，跟 `ApprovalExpiredError` 的"没在有效期内被消费"区分开——"故意撤销"和"自然过期"是审计场景下两件不同的事实,不该合并成一种错误。`revoke()` 对 nonce 当前四种状态分别反应：不存在抛错（跟 `consume()` 对未知 id 的态度一致，是调用方 bug 信号）；已消费抛 `ApprovalAlreadyConsumedError`（悄悄放过会让调用方误以为一次危险操作被拦下了，但它其实已经真正执行过）；已过期/已撤销都是 no-op（`consume()` 反正会因为这两种状态自己失败，撤销一个已经废了的请求不需要额外报错，重复撤销本身是幂等操作，跟 `Agent.dispose()`/`JobRuntime.dispose()` 是同一个心智模型）（`approval.ts`、`approval.test.ts` +5 条）。
- **Day20 任务2**：`EnvCredentialStore`。`resolve(ref)` 直接用 `ref.id` 原样去读 `process.env`，不做任何前缀/大小写改写——环境变量名本身不敏感，隐式命名规则只会多一条要记的约定。跟 `InMemoryCredentialStore` 保持同一份 `CredentialStore` 接口行为：查不到照样抛 `CredentialNotFoundError`，不返回 `undefined`/空字符串（`credentials.ts`、`credentials.test.ts` +2 条）。同时修正了 `answer.md` 任务3 的哨兵设计结论：一个 `Symbol` 哨兵乍看合理，但扛不住 `JSON.stringify()`（会静默丢弃这个 key），而"显式恢复成上一层默认值"这种标记迟早要写进一份会被序列化的用户配置文件——带命名空间前缀的字符串常量才能扛住这趟往返。

至此 `pnpm test` 共 400 条测试全绿。

## Day22：HTTP Server、API Gateway 与流式协议

阶段四第一天，第一次让 `Agent` 能被网络访问，不再局限于同一个 Node 进程内直接持有。手写路由（不用框架），`Transfer-Encoding: chunked` + 换行分隔 JSON 做流式协议，不做真 WebSocket（握手/帧解析跟本课程主线无关）。

新增：
- `src/server/wire-protocol.ts`（新文件）—— `StreamEnvelope` 判别联合（`baseline`/`increment`/`terminal`/`transport-error`），跟 `SessionEvent`/`UserInteractionRequest` 同一套 `assertNever` 纪律。`increment` 直接复用 `SessionEvent.seq`（Day8）做游标，没有重新发明一套编号。
- `src/server/idempotency-store.ts`（新文件）—— `IdempotencyStore.claim(key)`：第一次见到某个 key 才返回 `true`，调用方必须先拿到 `true` 才能真的触发副作用（`Agent.send()`），不是执行完之后才检查有没有重复。
- `src/server/backlog-writer.ts`（新文件）—— `createBacklogWriter()`：把"这条连接还欠着多少字节没真正 flush"从真实 `node:http` socket 上剥离成一个纯逻辑单元，测试可以用一个永远不调用 `onFlushed` 的假 `write` 确定性地验证超限逻辑，不依赖操作系统 socket 缓冲区大小。超限时用 `res.end()` 而不是 `res.destroy()`——把最后一条 `transport-error` 消息讲完再挂断，不是直接砸断连接让这条诊断信息自己都发不完整。
- `src/server/session-registry.ts`（新文件）—— `SessionRegistry`：`Map<sessionId, Agent>` 的生命周期所有者，`create()` 给每个 `Agent` 接一个自定义 `SessionSink`（复用 Day9 就有的接口，这次不是写盘，是广播给正在监听 `GET /events` 的连接）。
- `src/server/http-server.ts`（新文件）—— `createHttpServer()`：`POST /sessions`（建session）、`POST /sessions/:id/messages`（幂等）、`POST /sessions/:id/cancel`（复用 `Agent.cancel()`，已有信号传播机制自动生效）、`GET /sessions/:id`（复用 Day10 `projectSummary()`）、`GET /sessions/:id/events`（流式，先发 baseline、再持续发 increment，`turn/end` 到达时发 terminal 并正常关闭这次响应）。Bearer token 只做"有没有钥匙"的准入检查，明确不是真授权模型（诚实记录的缺口）。
- `tests/wire-protocol` 相关：`tests/backlog-writer.test.ts`（4条）、`tests/idempotency-store.test.ts`（5条）、`tests/http-server.test.ts`（10条，真实临时端口 + 真实 socket，覆盖端到端流程/幂等去重/取消传播到真实 Agent/鉴权/backlog 超限/correlation id）。手动跑过一遍真实服务器（`curl` 起服务、发消息、看流式响应），不是只有单测覆盖。

至此 `pnpm test` 共 419 条测试全绿，`pnpm typecheck` 无错误。

## Day23：Client model、Conversation 与重连语义

站到 Day22 的客户端一侧：网络连接会断、会乱序、会重复投递——今天写"断了之后怎么正确接回去"。不写浏览器页面（没有浏览器测试基础设施），写一个终端 client（复用 `cli.ts` 已经在用的 `readline/promises` 模式）。

新增：
- `src/client/conversation.ts`（新文件）—— `Conversation`：用一个按 `SessionEvent.seq` 索引的 `Map` 天然去重/无视到达顺序，另加一个 `highestContiguousSeq` 指针专门挡"缺口"——`deriveMessages()`（Day8）要求连续完整的输入,提前到达但中间有洞的事件不会被错误地并入派生结果。`cursor` getter 返回的是"确认连续"的游标,不是"见过的最大 seq"。
- `src/client/reconnecting-stream.ts`（新文件）—— `StreamConnector` 接口 + `runReconnectingStream()`：连接、把 envelope 喂给 `Conversation`、断线自动重连,直到真的收到 `terminal` 且游标追上 `lastSeq`。**真实踩到的坑**：第一版判断"能不能停"只看有没有收到 `terminal`,没检查游标是否真的追上——如果一次连接中途丢了一条不是最后一条的事件,`terminal` 依然会正常发出,但缺口永远补不上,导致 4/8 个故障注入种子测试失败。修复需要两处都改（`reconnecting-stream.ts` 校验 `cursor >= lastSeq`；`fault-injecting-transport.ts` 补上"客户端本来就已经追上、这次没有新内容要发"这种情况该不该发 `terminal` 的判断),改一处不够,详见 `modules/day23-client-and-reconnection/study.md` §4。
- `src/client/fault-injecting-transport.ts`（新文件，仅测试用）—— 复用 Day2/3 `mulberry32` 种子 PRNG,对一份真实 `Agent` 跑出来的事件日志重放时故意制造缺口/重复/乱序/断线。
- `src/client/http-stream-connector.ts`（新文件）—— `StreamConnector` 的真实实现,打 Day22 `GET /sessions/:id/events`,按行切分换行分隔 JSON。
- `src/client/terminal-client.ts`（新文件）—— 终端客户端：`connectTerminalClient()`（核心逻辑,`onEnvelope` 钩子驱动 UI 更新,不用轮询）+ `runTerminalClientCli()`（真正给人手动跑的交互式入口）。跟 Day17/19 同一个纪律：不接进 `cli.ts` 子命令分发,新能力先独立验证完,见 Day27 里程碑。手动跑过一遍真实客户端连真实 Day22 服务器,确认端到端可用。
- `tests/conversation.test.ts`（6条）、`tests/client-reconnection.test.ts`（10条，8个不同种子的故障注入收敛测试 + 2条边界测试：连续失败放弃、abort 立刻停止）。

至此 `pnpm test` 共 435 条测试全绿，`pnpm typecheck` 无错误。

## Day24：技能、命令、计划、目标与提醒

五个概念权重完全不一样，不平均分配代码量——Reminder 刻意只写了20行，Skill/Goal 各接了一整条链路。

新增：
- `src/core/skill-registry.ts`（新文件）—— `SkillRegistry.match()` 按触发关键词做纯字符串匹配（不做语义匹配,诚实的缺口）；`selectSkillsWithinBudget()` 贪心按字符数（不是伪造的 token 数——这个项目至今没有真实的 token 估算函数）选出装得下的 skill。`src/core/system-prompt.ts` 新增可选的 `skills` 字段并接入 `buildSystemPrompt()`（Day11），只在非空时渲染"# Loaded skills"分段。今天没有把 `SkillRegistry.match()` 自动接进 `Agent` 每个 turn 的开头——机制独立交付,接不接进真正调用方是另一个决定。
- `src/core/command-registry.ts`（新文件）—— `Command`/`CommandRegistry`：给"人直接触发,不经过模型工具调用管线"这个从 Day21 `propose-edit` 子命令起就隐含存在的区分起名字。`createProposeEditCommand()` 把已有的 `proposeEdit()`（Day21）包成一个 `Command`,测试证明包装前后行为完全一致,不是发明新逻辑。
- `src/core/plan-mode.ts`（新文件）—— `PlanModeController`：不是真的能切断 `Agent` 工具访问的包装层（`AgentDeps.tools` 构造时就固定,没法动态换）,是一个决策器,`decide()` 委托给当前模式对应的 Day19 `PermissionPreset`,`switchTo()` 记录完整的模式切换审计历史。
- `src/core/goal.ts`（新文件）—— `GoalStore`：状态机 `open → pending-verification → closed`，模型的工具调用只能把状态推到 `pending-verification`,真正的 `close()` 必须调用一个跟模型输出完全独立的 `verify()` 函数,返回 `false` 就拒绝关闭、状态保持不变、允许之后重试。
- `src/core/reminder.ts`（新文件）—— `scheduleReminder()`：Day6 `Agent.steer()` 套一层 `setTimeout`,~20行,刻意不做成新的子系统。
- `tests/skill-registry.test.ts`（7条，含跟 `system-prompt.ts` 接线的集成测试）、`tests/command-registry.test.ts`（5条）、`tests/plan-mode.test.ts`（4条）、`tests/goal.test.ts`（9条）、`tests/reminder.test.ts`（3条，`vi.useFakeTimers()` 精确控制定时器）。

至此 `pnpm test` 共 463 条测试全绿，`pnpm typecheck` 无错误。

## Day25：Web、LSP 与代码运行时能力

LSP 部分走真协议路线（已跟用户确认）：不用进程内 TS Compiler API 抄近道，真的 spawn `tsserver`（`typescript` 自带，零新依赖）、走它实测确认的协议。

新增：
- `src/tools/process-runner.ts` 新导出 `killProcessTree()`（从 `spawnManaged()` 内部拆出来的可复用能力）——`tsserver-client.ts` 需要同样的杀法,但那是长期存活、走交互式协议的进程,不是"喂 stdin、等退出"这种批处理形状,`spawnManaged()` 整体抽象对它不适用,只复用真正通用的这一小块。Day16 原有测试一行没改、全部保持通过。
- `src/core/tsserver-client.ts`（新文件）—— `TsserverClient`：真实 spawn `tsserver`，协议是实测确认的（先用脚本手动发过请求、打印过原始 stdout 才动手写）——请求是一行 JSON + 换行符；响应/事件是 `Content-Length: N\r\n\r\n` + 精确 N 字节 JSON（LSP 同款 header framing，两者互不抄袭）。
- `src/core/semantic-query.ts`（新文件）—— `SemanticQueryProvider`/`TsserverProvider`/`TextSearchFallbackProvider`（包一层 Day15 `search_text`）/`withFallback()`。**真实踩到的坑**：`locateIdentifier()` 第一版没跳过注释行，查 `session.ts` 的"Session"类名会先定位到 JSDoc 注释里提到这个词的地方,`tsserver` 诚实报告查无此符号——修复：跳过明显的整行注释再定位。`withFallback()` 是这门课第一次明确写出来的合法 fail-open,跟 Day18/20 的 fail-closed 纪律刻意唱反调,study.md 讲清楚了判断标准（这一步失败的代价是不可逆副作用,还是"结果不够精确"）。
- `src/tools/web-search-tool.ts`（新文件）—— `FixtureSearchIndex`/`createWebSearchTool()`：不接真实网络，跟 Day7 `HeuristicInvestigationAdapter` 同一个理由。
- `src/tools/web-fetch-tool.ts`（新文件）—— `createWebFetchTool()`：真实打 `fetch()`，测试指向本地 fixture `node:http` 服务器（真实 socket,不 mock）。`policy?` 直接复用 Day18 `CommandPolicy`（主机名当"command"检查）。两个工具的结果都标 `provenance: 'untrusted-external'`。
- `src/core/code-runtime.ts`（新文件）—— `CodeRuntime`：`node:vm` + 显式冻结绑定白名单。**真实验证过沙箱逃逸**：任何传进去的宿主函数,靠 `.constructor.constructor(...)` 都能造一个运行在宿主 realm 的新函数,真的拿到了宿主进程的真实 pid——测试里专门验证"只传纯数据不传函数"时这条逃逸会失败。**另一个真实踩到的坑**：超时判断第一版用 `error instanceof Error` 做前置检查,实测发现 `vm` 跨 realm 抛出的错误 `instanceof`（宿主 `Error`）是 `false`,改成检查 `error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'`（不受跨 realm 身份问题影响）。
- `tests/tsserver-client.test.ts`（5条）、`tests/semantic-query.test.ts`（8条）、`tests/web-search-tool.test.ts`（5条）、`tests/web-fetch-tool.test.ts`（9条）、`tests/code-runtime.test.ts`（7条，含沙箱逃逸的正反两条验证）。

至此 `pnpm test` 共 497 条测试全绿，`pnpm typecheck` 无错误。

## Day26：Subagent——隔离、委派与预算

不需要 Day22 的 HTTP 层——委派是纯进程内的问题，父 `Agent` 直接 `new Agent(...)` 构造子 `Agent`，两者之间不隔着任何网络连接。

新增：
- `src/core/structured-result.ts`（新文件）—— `createStructuredResult()`：跨越父子边界的唯一合法通道，复用 Day8 `isJsonValue()` 强制校验,不是新发明一套校验逻辑。
- `src/core/delegation-budget.ts`（新文件）—— `DelegationBudget`：`maxConcurrent`/`maxTotalChildren`/`maxDepth` 真正强制执行（`canStart()` fail-closed）；`maxTimeMs` 真的会取消超时的子 Agent（复用 Day6 `agent.cancel()`）；`maxTokens` 诚实记录为"追溯性"——只影响下一个子 Agent 能不能启动，拦不住一个已经在跑的子 Agent 自己超支（那是 Day12 `TokenMeter` 单 Agent 内部预算管的事）。
- `src/core/subagent.ts`（新文件）—— `SubagentManager.startChild()`：独立 `Session`（不共享父的可变 `Message[]`）、只有 `StructuredResult` 能跨边界、`presetRank()` 显式偏序防权限升级（`readonly < balanced < autonomous`，不认识的 preset 名字 fail-closed）、`disposeAll()` 级联清理不留孤儿子 Agent。**真实验证过一个记账时机的坑**：`DelegationBudget.recordStart()` 如果推迟到子 Agent 跑完才调用（而不是启动前），两次背靠背的同步 `startChild()` 调用会让 `maxConcurrent` 限制完全失效——两次调用的 `canStart()` 检查都发生在任何一次 `recordStart()` 真正执行之前。
- `tests/structured-result.test.ts`（5条）、`tests/delegation-budget.test.ts`（7条）、`tests/subagent.test.ts`（9条，真实构造多个 `Agent` 实例的端到端验证）。

至此 `pnpm test` 共 518 条测试全绿，`pnpm typecheck` 无错误。

## Day27：Workflow——可审计编排（阶段四里程碑）

把 Day22-26 各自独立建好的每一块第一次串成一条真正能跑的命令——不引入新的隔离/预算机制，`agent` 叶子直接复用 Day26 `SubagentManager`，`CodeRuntime`（Day25）拿到第一个真正的调用方。

新增：
- `src/core/workflow-types.ts`（新文件）—— `WorkflowNode` 判别联合（`agent | parallel | pipeline | phase`）+ `assertNeverWorkflowNode`/`countAgentLeaves`/`collectAgentIds`/`isWorkflowNode`。`agent` 叶子只带一个字符串 `agentId` + `task` 文本，刻意不嵌入真实的 `AgentDeps`——这样这棵树才能安全地从 `node:vm` 沙箱里的脚本构建出来，不用把宿主对象当绑定传进去（真要传宿主函数，Day25 `code-runtime.test.ts` 已经验证过那是沙箱逃逸的必要条件）。
- `src/core/workflow-dsl.ts`（新文件）—— `agent()`/`parallel()`/`pipeline()`/`phase()` 四个纯构建函数，调用即返回描述符、不执行任何东西，跟 `React.createElement()`/JSX 是同一个形状。
- `src/core/workflow-runner.ts`（新文件）—— `WorkflowRunner`：`run()` 最早一步 `countAgentLeaves()` 对比 `maxAgents`，fail-closed 拒绝超限的树（不启动任何子 Agent）；`interpret()` 递归解释四种节点，`agent` 叶子调 `SubagentManager.startChild()`，`parallel` 用 `Promise.all`，`pipeline` 依次执行（不做"上一步结果喂给下一步"，诚实记录的范围收缩），`phase` 是带名字的审计检查点。终态 `completed | cancelled | error` 三选一，`settle()` 内部一个 `settled` 标志位保证只会真正落定一次。**设计上刻意选择的边界**：`cancel()`/`forceCancelAfterMs` 触发的 `forceCancel()` 不等子 Agent 的 `dispose()` 真正完成——`Agent.dispose()`（Day6）内部是 `await this.runLoopPromise`，如果子 Agent 的 adapter 完全不理会 `AbortSignal`（真的卡死），这个 `await` 永远不会 resolve；`forceCancel()` 选择让 `dispose()` 在后台跑、不等它，`WorkflowRunner` 自己的终态立刻落定成 `cancelled`。亲手验证过：把 `forceCancel()` 改成等 `Promise.all(dispose...)` 完成再 `settle()`，`tests/workflow.test.ts` 里"卡死子任务"那条测试就从 79ms 内通过变成 5 秒超时。另有 `buildWorkflowFromScript()`：把四个 DSL 函数当唯一绑定喂给 `CodeRuntime` 跑一段脚本，脚本最后一句的完成值就是计划树，先过 `isWorkflowNode()` 校验再返回，脚本写错在这里就被拒绝。
- `src/cli.ts` 新增 `run-workflow` 子命令——`pnpm cli -- run-workflow --workspace <dir> --script <path> --query <text> [--max-agents <n>] [--force-cancel-after-ms <n>]`：读脚本文件、`buildWorkflowFromScript()` 建树、给树里每个 `agentId` 建一份指向同一 `--workspace`/`--query` 的 `HeuristicInvestigationAdapter` worker（诚实的简化：这条命令里不同 `agentId` 不切换模型/工具集，只是同一种 worker 的多份独立实例）、`WorkflowRunner.run()` 真正执行，打印最终 `WorkflowTerminalState` 的 JSON。手动跑过一遍真实的 `pipeline(agent, parallel(agent, agent))` 脚本，确认输出的结果树跟树的结构完全对应；另外验证过一段返回值不是合法 `WorkflowNode` 的脚本会被 `WorkflowScriptError` 清晰拒绝，进程以非零退出码收尾。
- `tests/workflow.test.ts`（12条）：DSL 本身（2条）、`buildWorkflowFromScript()`（3条，含"够不着 `require`"这条跟 Day25 白名单纪律的集成验证）、`WorkflowRunner` 解释四种节点组合出的真实 `Agent` 端到端结果（3条）、`maxAgents` fail-closed（1条）、卡死子任务下的有界取消 + `forceCancelAfterMs` 自动触发（2条）、终态竞态唯一性（1条）。
- `modules/day27-milestone-workflow-orchestration/phase-iv-test-index.md`——汇总 Day22-27 共 30 条已验证的边界/故障注入测试索引，仿照 `day21-milestone-secure-agent/security-test-index.md` 的做法，不是重新写一遍。

至此 `pnpm test` 共 530 条测试全绿，`pnpm typecheck` 无错误。阶段四（Day22-27，平台化与编排）全部完成。
