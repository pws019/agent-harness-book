# Day 5・实现 Agent Loop

> 阶段：I. 最小但正确的内核　|　产出：`src/core/agent-loop.ts`（`runTurn`）

## 今天要学会什么

1. 掌握 turn、step、模型请求、工具调用、停止原因（stop reason）之间的层级关系。
2. 区分"模型自己说完成了"和"系统确认满足了完成条件"——为什么不能只信模型自报。
3. 理解 Agent loop 的骨架：请求模型 → 执行工具 → 把结果回填进历史 → 继续请求，直到终止。
4. 理解为什么每个 turn 都必须产生**唯一**的终态（`completed`/`cancelled`/`budget_exhausted`/`error`），不允许"悬而未决"。

## 怎么学

1. 读 [study.md](./study.md)——里面记录了两个我们在实现时真实踩到的坑，比文档描述更直观。
2. 读 `mini-harness/src/core/agent-loop.ts`。
3. 做 [exercise.md](./exercise.md)：用假 adapter 跑通"模型重复调用同一工具""调用不存在工具""永不主动结束"这几种故障场景。

## 验收标准

- 你能画出一次 turn 中多个 step 和 tool call 的时序图（练习里要求你手绘或用 mermaid 画一次）。
- 所有路径都产生唯一终态：`completed`、`cancelled`、`budget_exhausted` 或 `error`，绝不允许"吞掉工具错误后伪装成功"。
- 你能解释：为什么"模型这一步没请求工具调用"不能直接等同于"这个 turn 完成了"？
- `pnpm test` 全绿。
