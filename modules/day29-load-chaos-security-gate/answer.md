# Day 29 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md) 里的思考题逐条作答。

## 今天要学会什么

**1. `http-server.ts` 那个 bug**：`handleEventsStream()` 原来只有一条"正常收尾"路径——订阅新事件的 `listener` 收到一条 `turn/end` 才发 `terminal`、才 `res.end()`。如果客户端先 `await` 完 `POST /messages`（turn 已经彻底跑完）再打开 `GET /events`，这条连接订阅的时候，这个 turn 早就结束了——不会再有任何新事件发生，`listener` 永远不会被再次触发，`terminal` 永远发不出去。

**2. 跟 Day23 那个坑的关系**：两次都是同一个根因——"未来会发生新事件"这个假设，在"我已经追上了"这种情况下不成立。Day23 `fault-injecting-transport.ts`（测试专用的故障注入器）第一次踩过；这次是 `http-server.ts` 本身（真实服务端代码）第一次踩到，因为之前从来没有一条测试用"先等完成、再开流"这个顺序连接过。

**3. `AuditSink` vs `SessionSink`**：亲手跑一遍就知道——`SessionSink` 目前完全没有保护时，`send()`/`whenIdle()` 都正常返回，`agent.records` 里这个 turn 完全没被记录，错误变成一次没人认领的 unhandled promise rejection（真实进程可能因此崩溃）。这比 `AuditSink` 那种"吞掉、丢一条审计记录"更糟，也比"干净地把错误抛给调用方"更糟——两种都不占，是"从来没设计过这条路径"的自然产物。`AuditSink` 该简单地吞掉，是因为它背后没有任何数据一致性风险；`SessionSink` 不该简单套用同一个方案，是因为它可能兼职持久化通道，需要一个专门设计过的降级策略（比如标记失败状态），不是随手包一层 `try/catch` 就够。

**4. SSRF**：`web_fetch` 不给 `policy` 时不限制任何目标，这是 Day18 `run_command` 就定下的"policy 默认关闭"姿态的延续，不是今天新引入或新发现的问题——今天只是第一次专门用一个真实的 loopback 目标场景，把这条已有的设计姿态用"SSRF"这个业内通用名字点名，并验证了"给白名单就能挡住"这条唯一真正生效的缓解措施确实生效。

**5. Workflow 脚本够不着权限提升**：`isWorkflowNode()` 只检查必需字段（`agentId`/`task` 是不是字符串），不会因为对象上多出一个 `preset` 字段就拒绝它——脚本确实可以绕开 `agent()` 这个 DSL 函数，自己手写一个带 `preset` 的对象字面量混进去。但 `WorkflowRunner.interpret()` 的 `'agent'` 分支代码里，从来没有一行读取过 `node.preset`——传给 `SubagentManager.startChild()` 的 `spec` 里根本不包含这一项，真正做权限判断的 `presetRank()`（Day26）从未被调用。这是"结构上传不出去"，比"运行时会被检查挡住"更强的保证——没有任何一处判断逻辑可能被绕过，因为压根不存在需要绕过的判断。

**6. `release-checklist.md` 的7条"部分通过"**：见该文档本身的表格，每条都写了具体边界（比如第9/12条是"policy层是真的，sandbox强制执行这层没有真OS隔离"；第11条是"结构化字段安全，但`tool/result.content`这条路径仍可能带出明文"；第13条是"预算机制齐全，但Workflow的`maxAgents`是静态检查不是运行时滚动预算"）。

## 任务 1：为什么两条压测反应不一样

"30个并发session"那条测试是先 `await` 发消息拿到响应、再 `await` 打开 `GET /events`——完全符合触发这个 bug 的条件（订阅时 turn 已经结束）。"200次工具调用的长stream"那条测试是先 `await` 打开 `GET /events`（拿到响应头，确认服务端已经 `subscribe()` 完毕）、再发消息——这是 Day22 study.md §2.0 推荐的顺序，订阅发生在 turn 真正开始之前，所有事件（包括最后的 `turn/end`）都会通过正常的 `listener` 路径推送过来，根本不会触发"已经追上却收不到 terminal"这个条件，所以就算删掉那段修复代码，这条测试依然会通过——这正说明了那个 bug 是"操作顺序特定"的，不是随时都会发生。

## 任务 2：`SessionSink` 抛错的真实现象

亲手构造一个 `append()` 永远抛错的 `sink` 传给 `Agent`，`send()` 一条消息再 `await whenIdle()`：两者都正常返回，`agent.records` 是空数组——这个 turn 完全没有留下任何记录，好像什么都没发生过一样。但错误本身没有真的消失——`Agent.drain()`（`agent-handle.ts:207`）是一个 async 函数，`this.runLoopPromise = this.drain().finally(...)`（`agent-handle.ts:201`）里 `drain()` 抛出的错误穿过了 `.finally()`（`finally` 不吞错误，只是在 resolve/reject 前插一段清理逻辑），变成 `runLoopPromise` 的一个 rejection——但没有任何代码在这次调用链里 `await`/`.catch()` 这个 promise（`whenIdle()` 靠独立的 `idleWaiters` 回调机制解出来，不依赖 `runLoopPromise` 本身），于是它变成一个 unhandled rejection。

这比"数据没有真的持久化，但调用方毫不知情"更糟——那种情况下至少调用方后续操作还能正常继续，只是数据层面有隐患；这里是调用方**也**毫不知情（`whenIdle()` 干净地 resolve），**而且**进程本身可能因为这个没人认领的 rejection 在随后的某个 tick 崩溃退出——是"数据丢失且不知情"和"进程随时可能崩溃"两个问题叠加在一起，比任何一个单独发生都更难排查：崩溃发生的时间点跟真正出问题的时间点是错开的，排查的人很可能根本想不到要去查"某次 `send()` 静默吞掉的那次持久化失败"。

## 任务 3：值不值得把"部分通过"推到"完全通过"

以第13条（预算约束）为例——`WorkflowRunner.maxAgents` 是执行前对树的静态叶子数检查，不是运行时滚动预算。要推到"完全通过"，需要在 `interpret()` 递归执行的过程中持续追踪"目前已经启动了多少个子 Agent"，跟 `maxAgents` 比较，超了就中途拒绝后续节点——这在 `pipeline`/`parallel` 组合出的树里并不难加（`WorkflowRunner` 内部已经有 `startedChildren` 这个数组，长度就是"目前已经启动了多少个"）。

值不值得：静态检查已经能挡住"整棵树写死就是超限"这种最常见的错误（脚本作者手滑写了一个循环、生成了超大的树），运行时滚动检查要防的是一种更边缘的场景——`agentId` 对应的委派任务，在真正跑起来之前没人能预知它会不会引发比预想更多的调用（但今天的 `WorkflowNode.agent` 都是提前静态声明好的叶子，不会在执行过程中"凭空冒出新节点"，所以这个额外场景在今天的设计下其实并不成立）。结论：今天这个"部分通过"是一个合理的止损点——运行时滚动检查要解决的问题,在"树是静态、执行前已知全貌"这个前提下并不真实存在，只有当 Workflow 未来真的支持"执行中途动态生成新节点"（`answer.md` Day27 明确说过今天没做这件事）时，这条差距才会变成一个真问题，值得等那天真的做了再补。
