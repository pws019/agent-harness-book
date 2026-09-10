# Day 11・系统提示词与能力组装

> 阶段：II. 可回放的状态与上下文　|　产出：`src/core/system-prompt.ts`，`Session` 新增 `system/message`

## 今天要学会什么

1. 理解为什么系统提示词——尤其是里面"当前可用工具"这一段——绝对不能被缓存，只能每次现取。
2. 理解 `system/message` 事件为什么是纯审计记录，不参与 `deriveMessages()` 派生历史。
3. 学会用类型系统（`Omit<SystemPromptSections, 'tools'>`）直接排除一种错误用法，而不是靠"记得这样用"。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码：`src/core/system-prompt.ts`（很短），再看 `agent-handle.ts` 里 `drain()` 新增的那几行，以及 `tools/registry.ts` 新增的 `undefine()`。
3. 跑 `tests/system-prompt.test.ts` 和 `tests/session-integration.test.ts` 里 `systemPrompt` 那个 describe 块。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：为什么 `AgentDeps.systemPrompt` 的类型故意用 `Omit<SystemPromptSections, 'tools'>`，而不是让调用方自己传一份 `tools`？
- 你能解释：`system/message` 事件为什么不参与 `deriveMessages()`？
- `pnpm test` 全绿。
