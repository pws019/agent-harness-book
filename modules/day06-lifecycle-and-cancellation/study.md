# 白话讲解：生命周期、取消与并发

> 素材来源：DSH `docs/subsystems/core.zh.md`（AgentHandle/Agent/Scope 部分）、`docs/subsystems/invariants.zh.md`、`docs/subsystems/scope.zh.md`。

## 1. Agent 句柄与所有权：类比"借书证"

```ts
interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}
```

原文强调："The disposer is a CAPABILITY: among consumers, only the holder can tear this agent down."（`core.zh.md`）——`dispose()` 不是任何代码都能随便调用的方法，它是一份"能力凭证"，只有创建时拿到这个句柄的那个所有者才能销毁这个 agent。

**类比**：图书馆（registry）里所有书都能查到（对应 `ctx.agents.get(id)` 返回裸的 `Agent`），但只有借书证持有人（handle 持有者）能"还书"（dispose）。

**我们 MiniHarness 的简化**：DSH 有"运行时所有权"（谁的 scope 创建了它）和"结构性所有权"（注册它的 factory provider）两层所有权模型，我们today只做一层——`Agent` 类本身直接暴露 `dispose()`，谁拿到这个实例谁负责释放。这是刻意的简化，不是偷懒：我们的 MiniHarness 目前只有一个主 Agent，没有 DSH 那种"父 agent 创建子 agent、工厂 provider 可以被卸载"的场景（那是 Day26 Subagent 才会引入的复杂度），提前做两层所有权只会增加不必要的认知负担。

## 2. inbox：类比"收件篮"，不是"打断你正在做的事"

`Agent.send()` 的语义是"排队一个新 turn"——新消息进的是 inbox，不是直接改写正在进行的模型请求。原文的表述是：

> "Route identified input to an inbox boundary and optionally wake the driver."

**类比**：`send()` 像"把新任务塞进收件篮排队"，而不是"追上正在做事的人，抢过他手上的东西"。这样"当前请求"永远只有一个 writer 在跑（"每个会话单 writer"），不会出现两个并发调用同时改写同一个正在流式传输的请求这种竞态。

我们 `Agent.drain()` 的实现完全体现了这一点：`nextTurnQueue` 是一个数组，`send()` 只是 `push` 进去然后尝试唤醒 driver；真正处理消息的 `drain()` 循环是**顺序**从队列里 `shift()` 的，永远不会有两个 turn 同时在跑。

DSH 原文里还有 `steer`（追上正在跑的活动，插一句话，但要等到下一个 step 边界才生效）和 `inject`（不唤醒 driver，纯粹等下一个 step 边界被采纳的上下文）——我们 MiniHarness 今天**没有实现**这两个，只实现了 `send()`（对应 DSH 的 `followup`）。原因很直接：`steer`/`inject` 需要在 `runTurn` 内部的 step 边界暴露一个"检查有没有新插入内容"的钩子，这会让 Day5 写好的 loop 骨架变复杂，而我们还没有真正需要 steer 的场景（那通常是给"用户在 Agent 思考过程中插一句补充说明"这种交互式场景用的）。这是 YAGNI 原则的实践：**没有真实调用方需要它之前，不提前搭这个抽象**。exercise.md 里留了这个作为进阶练习。

## 3. 取消不是布尔值

```ts
type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }
```

原文强调"第一个 cause 获胜"（"The first cause wins for that activity"），并且这个 cause 会"复制到仅运行时的 `AbortSignal.reason`"，沿着各个阶段的事件一路传下去。

**白话理解**：如果取消只是一个 `boolean`，你没法回答"这次取消到底是谁发起的、为什么"——是用户主动点了停止按钮？还是父 Agent 把整个任务链路取消了？还是某个安全策略钩子发现了风险主动叫停？还是这个 Agent 本身被释放了？这些原因需要被**记录**（我们的 `TurnRecord.cancelCause` 字段），而不只是"哦，反正是被取消了"。

## 4. 我们在实现时真实踩到的两个坑

### 坑一：`cancel()` 触发的 `abort()` 把 `AbortSignal` 自己冻住了

这是 Day3 埋下、Day6 才暴露的一个雷。第一版测试跑起来报错：

```
TypeError: Cannot assign to read only property 'Symbol(kAborted)' of object '#<AbortSignal>'
```

**原因**：Day3 写的 `freezeRequest()`/`deepFreeze()` 会递归冻结请求对象能触达的**所有**嵌套对象——包括 `GenerateOptions.signal` 指向的那个 `AbortSignal` 实例！`AbortSignal` 不是一份"数据"，它是一个"活的"平台对象，`controller.abort()` 需要修改它内部的状态（Node 的实现是通过一个 symbol 属性标记"已中止"）。一旦这个对象被 `Object.freeze()`，它就再也无法被真正 abort 了——`controller.abort()` 会直接抛异常。

**修复**：`deepFreeze` 只递归冻结"纯数据"（普通对象字面量和数组），遇到不是纯数据的对象（比如 `AbortSignal`、任何 class 实例）直接跳过，既不冻结它，也不递归进它内部：

```ts
const proto = Object.getPrototypeOf(value)
const isPlainData = proto === Object.prototype || proto === null || Array.isArray(value)
if (!isPlainData) return // 跳过 AbortSignal、class 实例等"活的"平台对象
```

**这个坑值得记住的地方**：Day3 写"请求冻结"的时候，我们只想着"防止有人偷偷改 `model` 字段"，完全没想到 `signal` 这个字段本身也会被卷进递归冻结的范围。**"深"冻结这个词本身就是一个危险信号**——任何"递归处理一切能触达的东西"的操作，都要想清楚"一切"里有没有混进不该被一视同仁对待的特殊对象。这类 bug 往往要等到两个模块真正拼在一起、跑一个端到端场景时才会暴露，这也是为什么"设计两次"和"实现纵切"（让能力穿过多层）比"孤立地把每一层都测到 100% 覆盖率"更重要。

### 坑二：`whenIdle()` 的陷阱——空闲不等于"我的消息处理完了"

这个坑不是我们代码里的 bug，而是 DSH 原文明确点出的一个**用法**陷阱，我们在设计 `whenIdle()` 的文档注释时特意还原了它：

> "This follows replacement work started before the observed driver retires, but does not identify the settlement of any particular message."

**具体场景**：你 `send()` 了一条消息，然后 `await agent.whenIdle()`。如果在你等待期间，别的调用方也 `send()` 了一条新消息，`whenIdle()` 会等到**两条**都处理完才 resolve——这是对的行为（不会漏算新工作）。但反过来想：如果你只关心"我这一条消息到底处理完了没有"，`whenIdle()` 给不了你这个答案，因为它只回答"整个 driver 现在有没有活干"。

我们 `agent-handle.test.ts` 里专门写了一条测试验证这个行为（`"whenIdle does not resolve until ALL queued turns...are done"`）。**如果你需要跟踪某一条具体消息的结果，应该去看 `agent.records`**（每条 turn 完成后追加一条记录），而不是依赖 `whenIdle()` 的 resolve 时机去反推"我的消息刚处理完"。

## 5. dispose 的幂等性

```ts
async dispose(): Promise<void> {
  if (this.disposed) return
  this.disposed = true
  this.cancel({ kind: 'disposed' })
  if (this.runLoopPromise) await this.runLoopPromise
  this.notifyIdle()
}
```

`this.disposed` 这个标记保证了：不管 `dispose()` 被调用几次，真正的取消+等待逻辑只会执行一次。第二次调用直接命中第一行 `return`，是纯粹的 no-op，不会重复触发取消、也不会重新等待。DSH 原文对应的是 `Scope.dispose()`："Dispose every scope-owned registration; racing calls await the same completion." 我们的实现比这个更严格一点（第二次调用是 no-op，不会去等同一个 completion），这是刻意的简化，适合我们的单层所有权模型。

## 一句话总结

Day5 建立了"循环怎么跑"的骨架，Day6 给这个骨架装上了"怎么被外部安全地控制"的接口——排队、取消、释放。这三个操作看起来简单，但每一个都藏着"如果实现的时间点/检查顺序错了，就会产生竞态或悬挂状态"的陷阱。今天踩到的两个坑（`AbortSignal` 被误冻结、`whenIdle()` 语义误解）都不是"代码写错了一行"这种低级错误，而是"两个独立正确的设计，组合在一起产生了意料之外的交互"——这正是分布式/异步系统复杂性的本质来源，也是为什么"故障注入"和"竞态重复测试"要成为日常习惯，而不是可有可无的锦上添花。
