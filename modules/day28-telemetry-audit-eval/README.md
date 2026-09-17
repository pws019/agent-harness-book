# Day 28・遥测、审计与评测体系

> 阶段：V. 生产验证与毕业设计　|　产出：`src/core/redact.ts`（`createRedactor()`）、`src/core/telemetry.ts`（`deriveTelemetry()`）、`src/core/audit-log.ts`（`AuditingApprovalStore`）、`src/core/eval-harness.ts`（`EvalHarness`）

## 今天要学会什么

1. 理解 `deriveTelemetry()` 为什么是一个纯投影函数，不往 `ToolRegistry`/`LlmAdapter` 里加任何钩子——具体是哪个更早的设计决定（Day8 事件日志）让这件事变得可能。
2. 理解延迟是怎么"算"出来的，不是"测"出来的——`step/start`↔`assistant/message`、`tool/call`↔`tool/result` 这两对配对分别靠什么字段对齐。
3. 理解 `estimatedCostUsd` 为什么必须能是 `'unknown'`，不能默认当 0——具体复用了 Day12 哪个类型的哪条纪律。
4. 理解 `AuditingApprovalStore` 为什么选择"包一层"而不是"直接改 `approval.ts`"——这个决定背后"设计两次"比较的是什么。
5. 理解 `principal` 字段为什么是"调用方自称的身份"而不是"经过验证的用户身份"——这跟 Day22 bearer token 的哪个诚实缺口是同一类问题。
6. 理解 `redact.ts` 为什么只需要处理 `tool/result.content`，不需要处理整个 `SessionEvent` 日志——Day20 `CredentialRef` 的设计怎么让这件事天然成立。
7. 能解释"离线场景集"（`Scenario`/`ScenarioAssertion`）跟"模型抽样评测"（`sampleScenario()`）分别在回答什么问题，为什么后者今天只能用一个专门造的合成 adapter 来演示。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码，建议顺序：`src/core/redact.ts` → `src/core/telemetry.ts` → `src/core/audit-log.ts` → `src/core/eval-harness.ts`。
3. 跑 `tests/telemetry.test.ts`、`tests/audit-log.test.ts`、`tests/eval-harness.test.ts`（19 条，均为跨接缝的真实集成测试——真实 `Agent`、真实 `run_command`、真实 `ApprovalStore`，不是纯粹的 mock）。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：一次真实跑完的 `Agent` turn，`deriveTelemetry()` 是怎么从它的 `sessionEvents` 里算出每个工具调用/模型调用各花了多久的——具体是哪两个字段相减。
- 你能解释：为什么一个从没上报过 usage 的模型调用，会让整份遥测报告的 token 总数和成本估算都变成 `'unknown'`，而不是被悄悄当成 0 累加。
- 你能解释：`AuditingApprovalStore` 包一层 `ApprovalStore`之后，`consume()` 一次因为参数不对而失败的尝试，为什么不会产生一条"consumed"审计记录。
- 你能解释：一个被诱导执行了"把凭据打印到 stdout"的 `run_command` 调用，凭据明文会不会出现在原始的 `SessionEvent` 日志里（会）、会不会出现在经过 `redactor` 处理的遥测报告里（不会）——这两个不一样的答案分别是哪个设计决定造成的。
- `pnpm test` 全绿。
