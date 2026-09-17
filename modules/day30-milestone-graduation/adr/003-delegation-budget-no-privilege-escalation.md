# ADR-003：委派预算与"子不能超过父"的权限偏序

**状态**：已采纳（Day26，Day27/Day29 延续）

## 背景

一旦一个 Agent 能创建子 Agent（Day26），两个新问题立刻出现：子 Agent 会不会无限制地继续创建更多子 Agent（资源耗尽）？子 Agent 会不会拿到比父 Agent 更高的权限（权限升级）？两者都不能靠"相信调用方会小心处理"来解决。

## 决定

`DelegationBudget`（Day26）用五个显式维度（并发/总数/深度/Token/时间）约束委派树的规模，`canStart()` fail-closed。`presetRank()`（Day26）建立一个显式偏序（`readonly < balanced < autonomous`），子 Agent 声明的 preset 排名不能高于父 Agent，不认识的 preset 名字也 fail-closed 拒绝，不是默认放行。

## 后果

**好处**：这条纪律不是靠"检查每个具体调用点"来维持的，是靠"根本没有代码路径能绕过它"——`red-team-regression.test.ts` 场景7（Day29）验证的正是这一点：Workflow 脚本连"声明一个 preset"这件事本身都做不到，因为 `WorkflowNode.agent` 这个类型压根没有 `preset` 字段，`WorkflowRunner.interpret()` 也从来没有读过这个字段。真正做权限判断的 `presetRank()` 从未在这条路径上被调用——这是"结构上传不出去"，比"运行时检查挡住了"更强。

**代价**：`DelegationBudget.maxTokens` 是追溯性的（`release-checklist.md` 第13条）——只能挡住"下一个子 Agent 要不要被允许启动"，拦不住一个已经在跑的子 Agent 自己超支,因为委派树这一层拿不到"某次工具调用/模型请求刚返回"这个时机点，那是 Day12 `TokenMeter` 单 Agent 内部预算才能做到的粒度——两层预算各管各自能力范围内最擅长的事，不是互相取代。
