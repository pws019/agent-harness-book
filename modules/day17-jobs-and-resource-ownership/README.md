# Day 17・PTY、后台任务与资源所有权

> 阶段：III. 受控执行与人机协作　|　产出：新增 `src/core/job-runtime.ts`（`JobRuntime`）、`src/tools/job-tools.ts`（`start_job`/`job_status`/`cancel_job`），`src/tools/process-runner.ts` 重构出 `spawnManaged()`

## 今天要学会什么

1. 理解为什么"一个工具调用"和"一个后台任务"是两种不同的生命周期——前者跟一次 `execute()` 调用绑定，后者要跨越多次 `poll()`，甚至跨越好几个 turn。
2. 理解 `spawnManaged()` 这次重构：给一个已经稳定跑了一整天（Day16）、只有一个函数签名 `runProcess()` 的深模块加新能力，为什么可以做到"旧调用方一行不改、旧测试全部还是绿的"。
3. 理解 `JobRuntime.cancel()`/`dispose()` 的幂等语义,和 Day6 `Agent.dispose()` 是同一套心智模型的复用，不是巧合。
4. 能说清楚"进程重启后 Job 处于什么状态"这个问题的诚实答案——以及如果真要做"可恢复 Job"需要往哪个方向设计（不要求今天做出来）。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码，顺序建议：`src/tools/process-runner.ts`（先看 `spawnManaged()` 跟 Day16 版本的 `runProcess()` 内部实现比对着看）→ `src/core/job-runtime.ts` → `src/tools/job-tools.ts`。
3. 跑 `tests/process-runner.test.ts`（确认 Day16 的 9 条测试原封不动全绿，验证重构没有破坏行为）、`tests/job-runtime.test.ts`、`tests/job-tools.test.ts`。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：`spawnManaged()` 和 `runProcess()` 是什么关系,为什么这次重构不需要改 Day16 写的任何一条测试。
- 你能解释：`JobRuntime.cancel()` 对一个不存在的 id 抛错、`dispose()` 对一个不存在的 id 却是安静的 no-op——这两个不同的选择分别为什么合理。
- 你能解释：为什么"进程重启后没有真正可恢复的 Job，只有已失联的 Job"，以及如果真要支持"重启后重新接上一个还活着的进程"需要额外解决什么问题。
- `pnpm test` 全绿。
