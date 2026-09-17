# 白话讲解：压力、混沌、安全与上线门禁

> 素材来源：DSH `docs/subsystems/invariants.md`。今天跟前 28 天不太一样——**不建新子系统**，是拿已经建好的整套系统（HTTP server、client 重连、委派、workflow、遥测/审计）往狠里测，看它们在真实规模、真实故障、真实攻击场景下还站不站得住。过程中真实找到并修复了一个此前 28 天都没被测出来的 bug——这正是"压力/混沌测试"这件事本身存在的意义：不是走个过场,是真的能揪出东西。

## 0. 一个真实找到的 bug：客户端先等消息发完、再开事件流,会永远收不到 terminal

### 0.1 先讲人话：这个 bug 是怎么暴露出来的

Day22 `study.md` §2.0 讲过推荐的客户端使用顺序：**先打开 `GET /events`，再发 `POST /messages`**——这样能实时看到 Agent 一步步在做什么。但如果一个客户端图省事,先 `await` 发消息、等它整个 turn 彻底跑完,再打开事件流去"看一眼刚才发生了什么"——这在直觉上应该完全没问题：这条连接建立的时候,虽然 turn 已经结束了,但所有事件应该都在 `baseline` 里一次性发过来才对。

`load-and-chaos.test.ts` 写第一版"200 次工具调用的长 stream"测试时，就是按"先发消息、等它跑完，再开流"这个顺序写的——测试跑起来直接超时。

### 0.2 根因：`handleEventsStream()` 的"正常收尾"只认一条路

```
handleEventsStream() 原来的逻辑：
  1. 写响应头
  2. registry.subscribe(sessionId, listener)   ← 订阅"以后发生的新事件"
  3. write({kind:'baseline', snapshot: 已经发生过的事件})
  4. （等待……）只有 listener 收到一条新的 turn/end 事件，才会：
       - write({kind:'terminal', ...})
       - res.end()
```

问题就出在第 4 步的"只有"——如果这次连接建立的时候,turn 早就已经结束了（因为客户端先 `await` 完了 `POST /messages`），那么从第 2 步订阅开始，**再也不会有任何新事件**触发 `listener`——`turn/end` 那条事件已经在第 3 步的 `baseline` 里发过去了,不会再发生第二次。第 4 步永远等不到它要等的那个信号,`res.end()` 永远不会被调用,这条 HTTP 响应会一直挂着,直到客户端自己超时放弃。

**这是不是很眼熟？**——Day23 `study.md` §4 讲过一个几乎一模一样的坑：客户端重连时,如果 `since` 已经追上了最新进度（这次重连的"补洞"队列是空的），第一版的故障注入模拟器也不会发 `terminal`,导致重连死循环。这两个 bug 本质上是同一类：**"我是不是已经追上了"这件事,不能只靠"未来会不会有新东西"来判断,还要主动检查"到目前为止的这份快照本身是不是已经收尾了"**。Day23 那次是在测试专用的故障注入器里发现的；这次是在真服务端——`http-server.ts` 本身——第一次真的被暴露出来,因为在这之前从来没有一条测试用"先等完成、再开流"这个顺序连过。

### 0.3 修复：多做一次"我是不是已经追上了"的检查

```ts
const snapshot = agent.sessionEvents.filter((event) => event.seq > since)
write({ kind: 'baseline', snapshot })

const lastEvent = agent.sessionEvents.at(-1)
if (!closed && lastEvent?.type === 'turn/end' && lastEvent.seq > since) {
  closed = true
  unsubscribe()
  write(terminalEnvelope(lastEvent.reason, lastEvent.seq))
  res.end()
}
```

（[http-server.ts:211-230](../../mini-harness/src/server/http-server.ts#L211-L230)）`baseline` 发完之后,主动看一眼"这个 session 目前最新的一条事件是不是 `turn/end`，而且客户端还没见过它（`seq > since`）"——是的话,直接把 `terminal` 发出去、正常收尾,不再指望一个不会再发生的"未来事件"。`lastEvent.seq > since` 这个条件很关键：如果客户端带着 `?since=<比 lastEvent.seq 还大的值>` 重连（说明它其实已经知道这个 turn 结束了），就不会重复发一次 `terminal`。

`terminalEnvelope()`（[http-server.ts](../../mini-harness/src/server/http-server.ts)）是顺手做的一次去重复——原来"把 `TurnEndReason` 翻译成线协议的 `terminal.reason`"这段逻辑在 `subscribe()` 回调和这个新分支里要各写一遍，抽成一个小函数,两处调用同一份翻译逻辑,不是复制粘贴两份。

## 1. 压力测试：不是假装的规模，是真实的规模

`tests/load-and-chaos.test.ts` 的两条压测都是真实 IO,不是伪造并发计数器：

- **30 个真实并发 session**：真的对同一个 `node:http` 服务器发 30 组并发的"建 session → 发消息 → 读事件流"，每个 session 的回复文本里都带一个跟它自己绑定的唯一标记，断言每个 session 看到的事件里**只有**自己那份标记——不是"看起来大概率没串"，是真的逐个断言过没有一个 session 收到过别人的内容。
- **200 次工具调用的长 stream**：真的产生 1000+ 条 `SessionEvent`，通过真实 chunked HTTP 响应传输，用 Day23 `Conversation` 消费,断言 `cursor` 精确追到服务端宣布的 `lastSeq`，一个事件都没漏、没有缺口。这条测试过程中还真实撞上了 Day22 64KB 默认积压上限——1000+ 条事件如果全部堆在一条 `baseline` 里发（客户端先等完成再开流的旧写法）,单这一条 envelope 的编码体积就轻松超过默认上限,会被系统判定成"慢客户端"而强制断开。换成"先开流再发消息"（增量、边产生边发送,每次 `write()` 的体积小得多）之后,真实体量的长 stream 才能顺利收尾，同时给这条测试配了一个更大的 `maxBacklogBytes`——这不是绕过积压保护，是给一个"预期历史量就是很大"的场景一个更贴近生产的上限,积压上限本身该多大用多大,不该拿一个真实会话，硬套一个只为演示而设的默认值。

## 2. 混沌测试：哪种 sink 该"吞掉错误"，哪种不该——真值表

**场景一**：一个多步 turn 中途，模型返回了一个不可重试的错误（`AUTH_ERROR`，401 等价物）。断言 `Agent` 不会挂起、不会吞掉这个错误——`stopReason.kind` 明确是 `'error'`，而且失败之前那一步真实发生过的工具调用,依然完整留在事件日志里（不因为后面失败了就假装整个 turn 什么都没做过）。这条链路本来就该这样工作（Day3 的重试逻辑一直是这么设计的）,今天是第一次专门写一条集成测试，从`Agent` 整体视角断言这件事。

**场景二**：Day28 新建的 `AuditingApprovalStore` 接一个**故意抛错**的 `AuditSink`，断言 `create()`/`consume()` 依然正常返回，不被这个抛错的 sink 拖垮。这条测试第一次跑的时候确实失败了——`AuditingApprovalStore` 第一版直接调用 `this.sink?.record(...)`,没有任何保护,抛错会原样冒泡出去,把整个审批流程打断。修复是给这次调用包一层 `try/catch`（`audit-log.ts` 的私有 `notify()` 方法），故意吞掉 sink 自己的错误。

**但这条"吞掉错误"的修复只加在 `AuditingApprovalStore` 这一个地方，没有推广到 `Agent`/`session.ts` 的 `SessionSink`**（`agent-handle.ts:121`、`session.ts:305` 都还是裸调用 `sink?.append(event)`，完全没有保护）。这不是漏改，是同一种接口形状在两个不同职责下该有不同答案：

| sink 的职责 | 抛错时该怎么办 | 为什么 |
|---|---|---|
| `AuditSink`（Day28，观测/审计旁路通知） | 吞掉错误，主流程继续 | 这条通知"可有可无"——审计系统暂时联系不上，不该阻止一次真实的审批/操作真正发生。丢一条审计记录，比拖垮主任务的代价小得多。 |
| `SessionSink`（Day9，兼职持久化 + Day22 广播） | **不该**照搬同一个 `try/catch` | 详见下面的实测——今天的实际行为既不是"优雅地吞掉",也不是"干净地报错给调用方",是两者都不占的第三种、更糟的结果。 |

**亲手跑一遍就知道"不吞"具体会发生什么，结果比想象中更糟**：构造一个 `Agent`，传一个 `append()` 永远抛错的 `sink`，`send()` 一条消息再 `await agent.whenIdle()`——`send()` 正常返回、`whenIdle()` 也正常 resolve、`agent.records` 是空数组（这个 turn 完全没有被记录下来,`drain()` 内部在真正 push 一条 `TurnRecord` 之前就已经因为 `appendEvent()` 抛错而提前终止了）,错误本身变成一次 **unhandled promise rejection**——`this.runLoopPromise = this.drain().finally(...)`（`agent-handle.ts:201`）,`drain()` 抛出的错误没有被 `.finally()` 吞掉,但也没有任何地方 `await`/`.catch()` 这个 `runLoopPromise`（`whenIdle()` 是靠一套独立的 `idleWaiters` 回调机制解出来的,不依赖 `runLoopPromise` 本身 resolve），这个被拒绝的 promise 就变成了一个没人认领的"孤儿"——真实 Node 进程里,一个 unhandled rejection 默认会让整个进程崩溃退出。也就是说：调用方（`whenIdle()` 的等待者）完全不知道出过问题,`records` 里也查不到任何蛛丝马迹,但进程可能在几个 tick 之后自己崩溃——这比"优雅地吞掉、只是丢一条持久化记录"和"干净地把错误抛给调用方"都要糟糕,是一个**从来没有人设计过**的行为,只是"没加保护"这件事自然产生的副作用。

这次实测修正了一个容易想当然的直觉：`SessionSink` 的正确答案**不是**简单地"不加 `try/catch`"（那只是"没做任何决定"的默认状态，实际后果是上面这种三不沾的糟糕情况），而是需要一个专门设计过的策略——至少应该是"记下这次持久化失败（比如标记 session 进入降级状态），让调用方能查询到、也不会让一个异步错误变成没人认领的孤儿",这比"今天什么都没做"和"简单地包一层 try/catch 全部吞掉"都更对，但今天都没有做,是一条诚实记录的、留给 Day30 `failure-model.md` 展开的缺口。

同一个"要不要在 sink 抛错时吞掉它"的问题，`AuditSink` 那边的正确答案很清楚（吞掉，丢一条审计记录不致命）；`SessionSink` 这边"不该照搬"不代表"什么都不用做"——只是意味着这里需要的是一个专门设计过的降级策略，不是抄一份 `try/catch` 就能对付过去，`release-checklist.md` 第16条不变式把这条区分明确记录了下来。

## 3. 安全：SSRF 框架化，以及 Workflow 脚本"够不着"权限提升

**SSRF**：`web_fetch`（Day25）不给 `policy` 时，能连到任何 host，包括看起来像内网/回环地址的目标——这不是今天新发现的 bug，是延续 Day18 `run_command` 就有的"policy 默认关闭，不给就不限制"那个已经诚实记录过的设计姿态。今天第一次专门用一个真实的 loopback 目标场景，把这件事用"SSRF"这个业内通用名字点名（"红队场景6"），并且验证了"唯一真正生效的缓解"确实生效——给一份不包含这个内网 host 的白名单，请求会在真正发起连接**之前**就被拒绝（`FetchResult.kind === 'denied'`）。

**Workflow 脚本没有办法伪装出更高权限**：`WorkflowNode.agent`（Day27）的类型定义只有 `agentId`/`task` 两个字段——但这只是类型层面的约束,一段跑在 `node:vm` 里的脚本完全可以绕开 `agent()` 这个 DSL 函数,自己手写一个形状差不多、但多塞了一个 `preset` 字段的原始对象字面量,企图"伪装"成一次带更高权限声明的委派。红队场景7 验证的是：即使脚本真的这么干了,`isWorkflowNode()` 校验也不会因为多出来的字段拒绝它（校验只看必需字段），但 `WorkflowRunner.interpret()` 的 `'agent'` 分支从代码上根本没有读过 `node.preset` 这个字段——`SubagentManager.startChild()` 拿到的 `spec` 里压根没有 `preset` 这一项,真正做权限升级检查的 `presetRank()`（Day26）从来没有被触发过,因为触发它的前提条件（`spec.preset` 存在）从一开始就不成立。这比"就算你传了 preset 也会被拒绝"更强——是"这条路径结构上根本传不出 preset"，攻击面从设计上就不存在，不是靠一个运行时判断挡住的。

## 4. `release-checklist.md`：一次诚实的自查，不是形式主义

大纲要求"完成发布检查表"——[release-checklist.md](./release-checklist.md) 把根 `README.md` 的18条核心不变式,逐条对照 `mini-harness/` 当前真实代码打了勾，标出哪些完全落实、哪些是"机制存在但有一个明确记录过的边界"（11条完全通过，7条部分通过，0条完全没做）。**这次检查本身就抓出了两个新问题并且当场修了**：`AuditingApprovalStore` 的 sink 保护（第16条）、`http-server.ts` 的"已经追上却收不到 terminal"（间接影响第6/14条的可靠性）——这正是"上线检查表"该有的样子：不是走个过场勾完就完事，是真的会在填的过程中发现问题。

## 一句话总结

今天没有新概念，只有一件事反复出现：**"未来会发生的事件"不能是唯一的信号来源，任何"等待下一个事件才收尾"的逻辑，都要配一个"如果已经收尾了怎么办"的主动检查**——这既是今天修的 `http-server.ts` 那个 bug 的根因，也是 Day23 `fault-injecting-transport.ts` 那次坑的根因，本质是同一类问题在两个不同层面各自重演了一次。压力/混沌/安全测试的价值不在于"证明系统没问题"，在于像今天这样,真的把一个只在特定顺序/特定规模下才会暴露的问题揪出来。
