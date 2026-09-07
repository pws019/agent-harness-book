# Day 3・Adapter 边界与请求信封

> 阶段：I. 最小但正确的内核　|　产出：`src/llm/adapter.ts`（`LlmAdapter`、`AdapterRegistry`、错误分类、重试）

## 今天要学会什么

1. 用一层 Adapter 把 provider、model、采样参数、用量差异都隔离开，Agent loop 永远不认识任何具体供应商的 SDK 类型。
2. 理解"一次模型请求必须可重建"：请求一旦要发出去就应该被冻结，谁都不能中途偷偷改一个字段。
3. 掌握统一的错误分类（`LlmFailureCode`），以及"重试策略只重试可恢复错误"这条铁律。
4. 理解"一次适配器调用 = 一次 provider attempt"：适配器内部绝不允许自己悄悄重试。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读 `mini-harness/src/llm/adapter.ts`——`LlmAdapter` 抽象类、`AdapterRegistry`、`classifyFinish`、`generateWithRetry`。
3. 做 [exercise.md](./exercise.md)：写一个"前两次失败、第三次成功"的假 adapter，验证重试次数、退避策略和取消语义。

## 验收标准

- 上层代码（Agent loop）不 import 任何具体 provider SDK 的类型，只认 `LlmAdapter`/`GenerateOptions`/`StreamChunk`。
- 空 completion 会被正确分类为可重试错误，而不是静默当作成功。
- 重试策略只重试白名单里的错误码；用户主动取消（`ABORTED`）永远不会被重试。
- 请求对象一旦传入 `generateWithRetry`，任何尝试修改它的代码都会抛异常（冻结生效）。
