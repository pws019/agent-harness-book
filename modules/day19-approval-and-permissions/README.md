# Day 19・审批、权限预设与用户问答

> 阶段：III. 受控执行与人机协作　|　产出：`src/core/approval.ts`（`ApprovalStore`、`UserInteractionRequest`）、`src/core/permission-presets.ts`（`readonly`/`balanced`/`autonomous`）

## 今天要学会什么

1. 理解"信息缺失问题""偏好选择""风险审批"为什么要设计成三种不共用的类型,而不是一个含糊的 yes/no 接口。
2. 理解 `ApprovalRequest.argsHash` 这套"一次性、绑定具体参数"的设计,和 Day15 `edit_file` 的 `expectedHash` 是同一种手法（乐观并发控制）在不同场景下的复用。
3. 能解释 `ApprovalStore.consume()` 四个校验条件（nonce 存在/没消费过/没过期/参数匹配）分别防住哪一种原始大纲点名的故障场景。
4. 理解为什么今天**不**改动 Day5 的 `runTurn`/`agent-loop.ts`——`ApprovalStore`/权限预设先独立交付、独立验证,真正接进循环留到 Day21。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码：`src/core/approval.ts`（先看 `UserInteractionRequest` 这个封闭联合类型，再看 `ApprovalStore`），`src/core/permission-presets.ts`。
3. 跑 `tests/approval.test.ts`、`tests/permission-presets.test.ts`。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：为什么"批准后换参数"这种失败不应该顺带把 nonce 也标记成已消费。
- 你能解释：`readonly`/`balanced`/`autonomous` 三个 preset 为什么都吃同一份"哪些工具是只读的"显式集合,而不是靠猜工具名字的规律。
- 你能解释：今天为什么不去改 `runTurn`,这个决定跟 Day15/16 里"新能力先在工具层独立验证,不急着接入调用方"是不是同一个模式。
- `pnpm test` 全绿。
