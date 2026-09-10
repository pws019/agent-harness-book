# Day 11 实践任务

## 任务 1：读代码，亲手验证"现取不缓存"

在 `tests/system-prompt.test.ts` 里那条"移除工具"的测试基础上，反过来写一条：**先移除、再重新注册同一个工具**（`registry.undefine('list_files')` 然后再 `registry.define(...)` 同名工具回去），验证 `buildSystemPrompt` 会重新把它包含进去。想一想：如果 `buildSystemPrompt` 或者哪个中间层曾经缓存过"工具列表"，这条测试会在哪里失败？

## 任务 2：给 `SystemPromptSections` 加一个分段

现在只有身份、工作区、工具、任务上下文四段。加一个可选的 `policies?: readonly string[]` 分段（比如"不要执行写操作""每次调查最多10轮"这类政策提示），渲染成一个新的 `# Policies` 小节，用列表格式。补至少两条测试：有 policies 和没有 policies 两种情况。

## 任务 3：一个思考题（不用写代码）

`system/message` 事件记录的是"渲染后的最终字符串"，不是"组装它用的那些原始分段"（`identity`/`workspaceRoot`/`tools`/`taskContext`）。如果哪天你想做"审计系统提示词具体是因为哪个分段变化才跟着变了"，现在这个设计够不够用？如果不够，你会往 `system/message` 的 payload 里加什么字段？加了之后，`isJsonValue` 那道校验会不会带来新的限制（提示：想一想 `tools: ToolSchema[]` 这种字段本身是不是无损 JSON）？

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的任务1、任务2测试。
- [ ] 我能解释：为什么 `system/message` 存的是渲染后的字符串，而不是原始分段对象？
