# Day 24・技能、命令、计划、目标与提醒

> 阶段：IV. 平台化与编排　|　产出：`src/core/skill-registry.ts`（接入 Day11 `buildSystemPrompt`）、`src/core/command-registry.ts`（示范包装 Day21 `proposeEdit`）、`src/core/plan-mode.ts`（复用 Day19 `PermissionPreset`）、`src/core/goal.ts`、`src/core/reminder.ts`

## 今天要学会什么

1. 理解为什么 Skill 要按需匹配加载，不是像 Day11 工具列表那样全部塞进系统提示词——具体是哪个真实的权衡驱动了这个决定。
2. 理解 `Command` 和 `ToolDefinition`（Day4）最核心的区别是什么（提示：不是"能做什么"，是另一件事），以及为什么今天包装 `proposeEdit()` 这件事本身证明了这个区分早就存在，不是凭空发明的。
3. 理解 `PlanModeController` 为什么不是"真的能切断 `Agent` 工具访问的包装层"，而是一个决策器——具体是什么限制导致了这个设计。
4. 理解 `Goal` 为什么要把"模型能触达的状态"和"真正关闭"分开，`close()` 在四种状态组合下分别怎么反应。
5. 理解为什么 `Reminder` 只值 20 行代码，不是这五个概念里权重最低就该敷衍——而是"这就是它该有的完整形态"。
6. 能回答：某个具体能力应该是 prompt/skill/tool/command/workflow 还是普通代码。

## 怎么学

1. 读 [study.md](./study.md)——§1 先看权重速览，再决定每个概念花多少时间读。
2. 读代码，建议顺序：`src/core/skill-registry.ts` → `src/core/system-prompt.ts`（看 `skills` 字段怎么接进去）→ `src/core/command-registry.ts` → `src/core/plan-mode.ts` → `src/core/goal.ts` → `src/core/reminder.ts`。
3. 跑 `tests/skill-registry.test.ts`、`tests/command-registry.test.ts`、`tests/plan-mode.test.ts`、`tests/goal.test.ts`、`tests/reminder.test.ts`。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：`selectSkillsWithinBudget()` 为什么用字符数而不是"token 数"当预算单位——这个项目里有没有真实的 token 估算函数可以复用？
- 你能解释：`GoalStore.close()` 面对"open"、"pending-verification 且 verify() 为 true"、"pending-verification 且 verify() 为 false"、"closed"这四种状态组合，分别做什么，为什么。
- 你能解释：如果把 `markPendingVerification()` 对"已经 closed"这个状态的检查去掉，会造成什么真实后果——不是"会出错"这么笼统，要说清楚具体会发生什么。
- `pnpm test` 全绿。
