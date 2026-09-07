# Day 6 实践任务

## 任务 1：读代码

读 `agent-handle.ts` 全文，重点看：

- `wake()`/`drain()`/`notifyIdle()` 三者怎么配合，保证"单 writer"和"排空过程中来了新消息不会被当成空闲"。
- `cancel()` 和 `dispose()` 的实现——`dispose()` 复用了 `cancel()`，想一想为什么这样设计是合理的。
- `tests/agent-handle.test.ts` 里的 `GatedAdapter`——为什么它要暴露一个 `started` promise，而不是让测试用 `await Promise.resolve()` 猜测需要等几个 microtask？

## 任务 2：实现 `steer()`（进阶）

study.md 第2节提到我们没有实现 DSH 的 `steer`/`inject`。选一个来做：

1. 在 `Agent` 上加一个 `steer(message: Message): void` 方法，把消息放进一个新的 `nextStepQueue`。
2. 修改 `agent-loop.ts` 的 `runTurn()`，让它在每个 step 的开头检查有没有"外部注入"的新消息——你需要给 `runTurn` 增加一种方式接收这个队列（比如通过 `AgentLoopOptions` 传一个回调 `pollSteering?: () => Message[]`，每个 step 开始前调用一次，取出待处理的引导消息并追加进历史）。
3. 写一个测试：在 `GatedAdapter` 卡住第一个 step 的时候调用 `steer()`，验证下一个 step 开始前，这条引导消息确实出现在了发给模型的历史里。

想一想：`steer()` 插入的消息，应该在**当前** step 生效，还是**下一个** step 生效？为什么 DSH 选择后者？

## 任务 3：竞态测试增强

现有的 100 次竞态测试只测了"send 后立刻 cancel"这一种时序。请扩展成至少 3 种交错模式，各跑 100 次：

1. `send()` 后立刻 `cancel()`（已有）。
2. 等 `adapter.started` 之后再 `cancel()`（保证一定命中"真正在跑的活动"）。
3. `cancel()` 后立刻 `send()`（验证取消不会误伤紧接着来的新消息）。

## 任务 4：验证释放顺序不会让外部过早看到"已释放"

写一个测试：在一个 turn 还在跑的时候调用 `dispose()`，在 `dispose()` 的 promise resolve **之前**，检查 `agent.status` 应该是什么？resolve **之后**又应该是什么？把这两个时间点的状态断言都写进测试里，不要只测最终状态。

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的竞态测试变体。
- [ ] 我能解释：为什么 `AbortSignal` 不能被深冻结？如果 Day3 当时就把这个坑修了，Day6 会不会更快写完？（这个问题没有标准答案，是想让你体会"提前发现 vs 事后发现"同一个 bug 的成本差异）
- [ ] 我能解释：`whenIdle()` resolve 的时候，到底能确定什么、不能确定什么？
