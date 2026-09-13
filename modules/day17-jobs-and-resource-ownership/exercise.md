# Day 17 实践任务

## 任务 1：亲手验证重构没有破坏 Day16 的行为

在改任何代码之前，先跑一遍 `pnpm vitest run tests/process-runner.test.ts tests/run-command-tool.test.ts`，记下测试数量和结果（应该是 18 条全绿）。然后打开 `src/tools/process-runner.ts`，读一遍 `spawnManaged()` 和 `runProcess()`，确认你能不看答案，口头说出"如果 `spawnManaged()` 在某个地方引入了 bug（比如 `stdoutSnapshot()` 返回的内容和 `done` 里最终 `stdout` 字段对不上），Day16 的哪一条测试会最先暴露这个问题"。

## 任务 2：给 `JobSnapshot` 加一个"运行时长"字段

`job_status` 现在的输出里没有"这个 Job 已经跑了多久"这个信息。给 `JobSnapshot` 加一个 `elapsedMs: number` 字段（从 `start()` 被调用那一刻到现在——或者到它结束那一刻——经过了多少毫秒），`job-tools.ts` 的 `render()` 里加一行展示它。

提示：`JobRuntime` 需要在 `start()` 里记一个开始时间；一个已经结束的 Job，"现在"应该固定成"它结束的那一刻"，不能让 `elapsedMs` 在 Job 已经跑完之后还继续增长（想一想为什么——提示：跟 Day13 讲过的"日志是唯一真源，不应该在读的时候还在变化"是类似的道理，只是这里换成了"一个已经终结的事实不应该在被观察的时候还在变"）。补至少两条测试：Job 还在跑时 `elapsedMs` 会随时间增长、Job 结束后多次 `poll()` 拿到的 `elapsedMs` 完全一样（不会继续涨）。

## 任务 3：一道思考题（不用写代码）

`JobRuntime` 目前是进程内的一个普通对象，没有上限地接受 `start()` 调用——理论上模型可以疯狂调用 `start_job` 开一堆后台任务，直到把机器资源耗尽（这也是 Day18 要讲的"资源耗尽"这类攻击的一种）。想一想：如果要给 `JobRuntime` 加一个"同时最多允许 N 个 Job 在跑"的限制，这个限制应该加在哪一层最合适——`JobRuntime.start()` 内部、还是 `start_job` 这个工具的 `execute()` 里、还是完全交给上层（比如 Agent 或者调用方）去数？说出你的理由，可以参照 Day4 讲过的"深模块，复杂度不转嫁给调用方"这条原则来论证。

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的任务2测试，并且 Day16 原有的 process-runner/run-command 测试一条没改。
- [ ] 我能解释：为什么已经结束的 Job，`elapsedMs` 不能在被 `poll()` 的时候继续增长。
- [ ] 我写完了任务3的思考题，给出了一个具体的分层建议和理由，不是"随便哪层都行"。
