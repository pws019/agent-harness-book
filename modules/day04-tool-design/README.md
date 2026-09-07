# Day 4・工具定义——接口质量决定 Agent 上限

> 阶段：I. 最小但正确的内核　|　产出：`src/tools/{types,schema-validate,registry,workspace,fs-tools}.ts`、三个只读工具

## 今天要学会什么

1. 理解工具名、描述、参数 schema、结果、错误——是模型和确定性代码世界之间的契约。
2. 识别"浅工具"：需要模型连续拼接大量低层调用才能完成一个稳定操作的糟糕设计。
3. 设计"深工具"：接口简单，但内部承担校验、超时、错误分类等复杂度。
4. 理解统一的工具执行管线：参数校验 → 超时/取消控制 → 执行 → 结果渲染，这些复杂性应该在管线里统一处理，不能让每个工具各自为政。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码，顺序建议：`types.ts` → `schema-validate.ts` → `registry.ts` → `workspace.ts` → `fs-tools.ts`。
3. 做 [exercise.md](./exercise.md)：新增一个第四个只读工具，走一遍完整的"深工具设计"流程。

## 验收标准

- 你能解释：为什么 `output.render()` 必须是纯函数，不能有副作用、不能抛异常？
- 你能解释：为什么 `additionalProperties` 要在**定义期**（不是调用期）就强制工具作者显式声明？
- `pnpm test` 全绿，包括路径越界、参数校验、超时、取消这些"坏路径"测试。
- 你写的新工具能通过同一套 `ToolRegistry.execute()` 管线跑通，不需要为它单独写一套校验/超时逻辑。
