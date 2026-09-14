# Day 17 答案

> 对照 [README.md](./README.md)「今天要学会什么」、[exercise.md](./exercise.md)「验收自查」和其中的思考题逐条作答。

## 今天要学会什么

**1. 工具调用 vs 后台任务，两种生命周期**

一次普通工具调用（Day4-16）从 `execute()` 被调用到 resolve 是同一个、有始有终的时间窗口，Agent loop 等它跑完才能继续。后台任务反过来：`start_job` 立刻返回一个 `jobId`,真正的子进程独立于这次工具调用继续跑，`job_status` 可以在任意之后的时间点（甚至下一个 turn）被调用来问"现在怎么样了"。见 study.md §1 的对比图。

**2. `spawnManaged()` 重构为什么不破坏 Day16**

Day16 的 18 条测试全部只依赖 `runProcess(spec, signal): Promise<ProcessRunResult>` 这一个函数签名和它最终 resolve/reject 的内容。`spawnManaged()` 把原来 `runProcess()` 内部"spawn+监听+杀进程树"的全部逻辑原样保留，只是多暴露了两个新方法（`stdoutSnapshot()`/`stderrSnapshot()`）让外部能在跑完之前看到中间状态；`runProcess()` 退化成 `return spawnManaged(spec, signal).done`,`done` 的内容和旧版一模一样。窄接口没变，测试自然不用跟着改——`pnpm test` 就是这个论断的验证。

**3. `JobRuntime.cancel()`/`dispose()` 和 Day6 `Agent.dispose()` 是同一套心智模型**

两者都是"收尾动作对重复调用/意外调用要安全"——`Agent.dispose()` 第二次调用是 no-op；`JobRuntime.dispose()` 对不存在的 id 也是 no-op（同样的"释放这件事本身允许被多次尝试"）。区别只在于 `cancel()`：它假设调用方手里的 `jobId` 应该是真实的，对不存在的 id 选择抛错而不是 no-op——因为"取消一个从来没开始过的东西"往往意味着调用方自己记错了 id,是一个值得暴露的 bug 信号，跟"我不再需要管它了"（`dispose` 的语义）不是一回事。

**4. 进程重启后 Job 的状态**

`JobRuntime` 只在内存里维护状态,不持久化进 Session 日志——进程重启后，旧的 `JobRuntime` 实例连同它管理的所有句柄一起消失，不存在"重启后还能找回一个正在跑的 Job 的完整状态"这种"可恢复"。真实的操作系统子进程可能还活着（如果是 `detached: true` 启动的），但我们已经没有任何句柄能联系到它、读它的输出——只能说"已失联"，不能说"已恢复"。如果真要支持恢复，需要持久化 `SpawnSpec`+`pid`，重启时用 `process.kill(pid, 0)` 探活，但即使活着也因为原来的 pipe 已经失效而无法继续读输出，现实的处理是发现它还活着就直接杀掉清理，而不是假装接上了——今天没有做,因为单工作区教学 Agent 目前没有真实场景需要这个能力。

## 验收自查

**为什么 `elapsedMs` 不能在 Job 结束后被 `poll()` 时继续增长**：如果 `elapsedMs` 是"现在时间 - 开始时间"这种每次 `poll()` 都重新计算的实时值，一个已经完成/取消/出错的 Job（`status.kind !== 'running'`）会随着你在它结束之后多久去 `poll()` 它，得到一个越来越大的 `elapsedMs`——但这个 Job **实际运行的时长早就是一个固定的历史事实**（它在某个确切的时刻停止了），不应该因为"你多久之后才想起来问它"而改变。正确做法是 Job 一旦进入终态,立刻把"结束时刻 - 开始时刻"这个差值算出来并冻结,后续所有 `poll()` 都返回这个冻结值,而不是继续拿"现在"去算。这跟 Day13"日志是唯一真源，压缩视图不应该在你读的时候还在变"是同一条原则的又一次应用——只是这里"已经发生、不该再变"的事实换成了"一个 Job 的总耗时"，不是一段历史消息。

**任务3：Job 数量上限该放在哪一层**：应该放在 `JobRuntime.start()` 内部，不该放在 `start_job` 工具的 `execute()` 里，更不该完全交给调用方自己数。理由对照 Day4"深模块，复杂度不转嫁给调用方"：`JobRuntime` 是所有 Job 状态唯一的、权威的记账者——它是唯一真正知道"现在有几个 Job 处于 `running` 状态"的地方（`this.jobs` 这个 Map 本身），如果把上限检查放在工具层，工具层还要重新去问一遍 `JobRuntime` 才能知道当前数量,等于把 `JobRuntime` 已经掌握的信息在外面又反查一遍,一旦以后 `JobRuntime` 被除 `start_job` 之外的第二个调用方使用（比如以后真的有 Day21 milestone 之外的别的入口），这层检查很容易被绕过，因为它没有跟真正的状态放在一起。放进 `JobRuntime.start()` 内部，是让"决不允许超过 N 个并发 Job"这条规则变成一条**任何调用方都躲不掉**的不变式，跟 `Session.append()` 把开闭校验放在写入时（Day8）、而不是留给 `deriveMessages()` 事后检查是同一个思路：规则守在离权威状态最近的那一层，才能保证没有第二条路能绕过去。

放对了层之后还剩半个问题没解决：`start(spec: SpawnSpec): string` 现在只有一条"成功"的路径，超限时怎么把"拒绝"这件事传出去？答案是跟现有的 `getOrThrow()` 对称——`poll()`/`cancel()` 遇到"调用方给的前提不成立"（id 不存在）时选的是抛 `JobNotFoundError`，而不是返回一个 `JobSnapshot | null` 逼每个调用方都要判空；"并发数超限"是同一类前提违反（这次 `start()` 调用从一开始就不该发生，不是"Job 正常结束但状态是 rejected"），所以应该新增一个对称的 `JobCapacityExceededError`，在 `start()` 内部真正创建 `AbortController`/调用 `spawnManaged()` **之前**先检查数量、超了就直接 `throw`——检查完全走在副作用之前，不消耗 `nextId`、不留下半成品记录，就不需要"创建了又要回滚"这层额外的清理逻辑。再往上，`start_job` 工具的 `execute()` 要接住这个新错误类型，跟它已经在 `job_status`/`cancel_job` 里对 `JobNotFoundError` 做的转换（`toToolError`）用同一个模式转成 `ToolExecutionError`——`start()` 唯一的"正常返回值"类型 `string`（jobId）完全不用变，只是新增一条跟 `JobNotFoundError` 形状一致、调用方已经知道怎么接的抛错路径。
