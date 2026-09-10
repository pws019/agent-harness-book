# 白话讲解：生命周期、取消与并发

> 素材来源：DSH `docs/subsystems/core.zh.md`（AgentHandle/Agent/Scope 部分）、`docs/subsystems/invariants.zh.md`、`docs/subsystems/scope.zh.md`。

## 0. 前置知识：`AbortController`/`AbortSignal` 和"单 writer 队列"

**`AbortController`**：你在前端可能已经用 `fetch(url, { signal })` 取消过请求，今天要用同一套浏览器/Node 标准 API，只是用途从"取消一次 HTTP 请求"扩展成"取消一整个 Agent turn"。用法就三步：

```ts
const controller = new AbortController()   // 1. 创建一个控制器
doSomething({ signal: controller.signal }) // 2. 把它的 signal 传给会跑很久的操作，操作内部随时检查 signal.aborted
controller.abort(reason)                   // 3. 想取消时调用 abort()，signal.aborted 变 true，reason 会存进 signal.reason
```

`controller` 和 `signal` 是一对：`controller` 是"遥控器"，只有拿到它的人能按下"取消"；`signal` 是"信号灯"，传给任何需要响应取消的代码，那部分代码只能**读**（`signal.aborted`/`signal.reason`），不能自己触发取消。这也是为什么 Day3 的深冻结把 `signal` 也递归冻死了会直接炸——`controller.abort()` 需要在底层**修改** `signal` 的内部状态，一个被冻住的对象没法被修改。

**单 writer 队列**：如果你写过前端状态管理（Redux/Vuex 这类），可以类比成"所有 action 必须经过唯一的 dispatch 入口，排队依次处理，不会有两个 reducer 同时改同一份 state"。这里的 `Agent.send()` 把新消息塞进 `inbox` 数组排队，真正处理消息的 `drain()` 循环一次只从队列头部取一条处理，处理完才取下一条——保证任何时刻只有"一个 turn 在跑"，不会有两次 `runTurn()` 并发修改同一份 `history`。这是解决"并发写同一份共享状态"这个经典问题最简单的手段：不并发，排队。

## 1. 为什么这些概念必须显式建模，不能靠"程序员自己小心"

这是 README「今天要学会什么」第1条,先在这里正面回答,后面 2-6 节的每一个具体机制,都是这条原则的一个实例——读的时候不需要现在就懂每个机制的细节,先建立"为什么要这样设计"这个大方向即可。

**一个具体场景，说明"程序员自己小心"为什么靠不住**：假设一个 `Agent` 实例可能被"释放"（清理资源、停止处理）的地方不止一处——比如：任务正常跑完后,业务代码主动释放它；外层包了一层 `try { ... } finally { 释放 }`,不管中间是正常结束还是出错都想确保释放一次；如果这是个长期运行的程序,进程收到退出信号时,清理钩子可能会把所有还活着的 `Agent` 统一释放一遍。这三条路径互相不知道对方的存在,也没法互相协调"这次到底该谁负责释放"——如果"重复释放会不会出问题"这件事完全靠"写代码的人自己注意、别调用两次",这条规则没有任何地方是可以被检查、被验证的,只存在于某个人的记忆或者一句注释里。系统里能触发"释放"的路径越多,这类协调失败的概率就越高,而且往往只在特定的时序下才会暴露——是最难复现、最难排查的一类 bug。

"程序员自己小心"作为一种保证机制,天然有两个问题：

- **没法验证**：没有任何编译器或测试能替你确认"所有调用方都遵守了这条规则"，它只存在于文档、注释、或者某个人的记忆里，新来的人看不到它。
- **不会随代码库增长而自动扩展**：调用方越多，"每个调用方都记得互相协调"这件事的失败概率就越高。

"显式建模"的做法是：把这条原来只存在于人脑子里的规则,变成一段**代码本身会强制执行**的逻辑——不管调用方知不知道、小不小心,规则都成立。比如上面这个场景，本节的解法就是让"释放"这个动作自己变成可以被反复调用、结果都一样的操作（这就是"幂等"，第6节会展开讲具体怎么做到）——这样三条路径不管谁先谁后、调了几次，都不需要互相协调。今天要学的几个概念，都是同一个手法在不同地方的应用，后面几节分别展开：

| 概念 | "程序员自己小心"的做法 | 显式建模之后 | 对应哪节 |
|---|---|---|---|
| 释放（dispose）可以被反复调用 | 靠调用方记得"只调一次" | 释放动作本身设计成不管调几次结果都一样 | 第6节 |
| 取消原因 | 靠注释"记得这次是用户取消的" | 取消原因作为结构化数据，跟着记录一起存下来，不是脑子里的记忆 | 第4节 |
| 新消息不打断正在处理的任务 | 靠约定"不要同时对同一个 agent 发两次消息" | 新消息进队列排队，一次只处理一条，数据结构本身让"同时处理两条消息"变得不可能发生 | 第3节 |
| 所有权（谁创建、谁负责释放） | 靠文档写"这个对象你用完记得释放" | 只有拿到"创建时给你的那个凭证"的代码，才能调用释放 | 第2节 |

**一句话**：显式建模的本质,是把一条规则从"靠人记住、靠人遵守"搬到"靠代码本身强制成立"——这正是 CLAUDE.md 里"用设计定义掉特殊情况和错误"这条准则在生命周期管理场景下的具体落地。

## 2. Agent 句柄与所有权：类比"借书证"

```ts
interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}
```

原文强调："The disposer is a CAPABILITY: among consumers, only the holder can tear this agent down."（`core.zh.md`）——`dispose()` 不是任何代码都能随便调用的方法，它是一份"能力凭证"，只有创建时拿到这个句柄的那个所有者才能销毁这个 agent。

**类比**：图书馆（registry）里所有书都能查到（对应 `ctx.agents.get(id)` 返回裸的 `Agent`），但只有借书证持有人（handle 持有者）能"还书"（dispose）。

**我们 MiniHarness 的简化**：DSH 有"运行时所有权"（谁的 scope 创建了它）和"结构性所有权"（注册它的 factory provider）两层所有权模型，我们today只做一层——`Agent` 类本身直接暴露 `dispose()`，谁拿到这个实例谁负责释放。这是刻意的简化，不是偷懒：我们的 MiniHarness 目前只有一个主 Agent，没有 DSH 那种"父 agent 创建子 agent、工厂 provider 可以被卸载"的场景（那是 Day26 Subagent 才会引入的复杂度），提前做两层所有权只会增加不必要的认知负担。

在往下讲之前，先看一眼今天的主角 `Agent` 类长什么样（对照 `mini-harness/src/core/agent-handle.ts`，下面是裁剪过的版本，只留下这篇文档会提到的成员）：

```ts
export type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

export interface TurnRecord {
  readonly userMessage: Message
  readonly stopReason: StopReason
  readonly cancelCause?: AgentCancelCause   // 这次 turn 是不是因为取消而结束、原因是什么
}

export class Agent {
  readonly history: Message[] = []          // 完整对话历史
  readonly records: TurnRecord[] = []       // 每条 turn 处理完，追加一条记录

  send(message: Message): void              // 排队一条新消息（inbox），不打断正在跑的 turn
  cancel(cause: AgentCancelCause): void      // 取消当前正在跑的 turn
  async whenIdle(): Promise<void>            // 等到 inbox 清空、没有活在跑
  async dispose(): Promise<void>             // 释放这个 Agent，幂等
  private async drain(): Promise<void>       // 内部循环：顺序处理 inbox 里排队的每条消息
}
```

## 3. inbox：类比"收件篮"，不是"打断你正在做的事"

`Agent.send()` 的语义是"排队一个新 turn"——新消息进的是 inbox，不是直接改写正在进行的模型请求。原文的表述是：

> "Route identified input to an inbox boundary and optionally wake the driver."

**类比**：`send()` 像"把新任务塞进收件篮排队"，而不是"追上正在做事的人，抢过他手上的东西"。这样"当前请求"永远只有一个 writer 在跑（"每个会话单 writer"），不会出现两个并发调用同时改写同一个正在流式传输的请求这种竞态。

**"driver" 是什么**：这是 DSH 原文的说法，不是某个具体命名的类——在我们 MiniHarness 里，driver 就是 `private async drain()` 这个循环本身。`Agent` 内部有个字段 `runLoopPromise`：它是 `undefined` 就代表"driver 现在空闲、没有循环在跑"，持有一个 `Promise` 就代表"driver 正在跑"。

我们 `Agent.drain()` 的实现完全体现了这一点：`nextTurnQueue` 是一个数组，`send()` 只是 `push` 进去，再调用内部的 `wake()`——`wake()` 检查 `runLoopPromise`：如果 driver 已经在跑（有值），什么都不做，`drain()` 内部的 `while` 循环下一轮自然会捡到新塞进去的消息；如果 driver 是空闲的（`undefined`，说明上一次 `drain()` 已经跑完退出了），才需要真正"唤醒"——重新调用 `this.drain()` 把循环跑起来，并把返回的 `Promise` 存回 `runLoopPromise`。真正处理消息的 `drain()` 循环是**顺序**从队列里 `shift()` 的，永远不会有两个 turn 同时在跑。

DSH 原文里还有 `steer`（追上正在跑的活动，插一句话，但要等到下一个 step 边界才生效）和 `inject`（不唤醒 driver，纯粹等下一个 step 边界被采纳的上下文）。我们 MiniHarness 最初没有实现这两个，只实现了 `send()`（对应 DSH 的 `followup`）——原因是 YAGNI：`steer`/`inject` 需要在 `runTurn` 内部的 step 边界暴露一个"检查有没有新插入内容"的钩子，会让 Day5 写好的 loop 骨架变复杂，而当时还没有真正需要它的场景。exercise.md 任务2 把 `steer()` 补齐了，实现思路：

- `Agent` 新增 `private readonly nextStepQueue: Message[]` 和 `steer(message)`——只是 `push`，**不调用 `wake()`**（这是它跟 `send()` 唯一的结构性区别：`send()` 既排队又负责唤醒空闲的 driver，`steer()` 假定 driver 已经在跑，只负责排队；如果 driver 是空闲的，光靠 `steer()` 不会让它跑起来）。
- `AgentLoopOptions` 新增 `pollSteering?: () => readonly Message[]`，`runTurn()` 在每个 step **刚开始**（`yield step-start` 之后、请求模型之前）调用它一次，取出的消息直接 `history.push()`。
- `drain()` 把 `pollSteering: () => this.nextStepQueue.splice(0, this.nextStepQueue.length)` 传给 `runTurn()`——`splice` 既取出了消息，也顺手清空了队列，不会重复消费。

**为什么插入的消息只能在下一个 step 生效，不能是当前 step**：因为当前 step 的请求这时候可能已经真的发出去了——回忆 Day3："一次模型请求必须可重建"、`generateWithRetry` 会把请求深度冻结再发出，一次 HTTP/流式请求一旦建立连接，你没有办法往里面追加内容（不存在"往一个已经在传输中的请求里插一句话"这种操作）。所以"下一个 step"不是一个随意的设计选择,而是**唯一有意义的注入时机**——它是"确定还没有请求被发出去"的第一个安全点。反过来想,如果允许插入当前 step,你就得回答一个没有好答案的问题："如果请求已经发出去了怎么办？"

## 4. 取消不是布尔值

```ts
type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }
```

原文强调"第一个 cause 获胜"（"The first cause wins for that activity"），并且这个 cause 会"复制到仅运行时的 `AbortSignal.reason`"，沿着各个阶段的事件一路传下去。

**白话理解**：如果取消只是一个 `boolean`，你没法回答"这次取消到底是谁发起的、为什么"——是用户主动点了停止按钮？还是父 Agent 把整个任务链路取消了？还是某个安全策略钩子发现了风险主动叫停？还是这个 Agent 本身被释放了？这些原因需要被**记录**（我们的 `TurnRecord.cancelCause` 字段），而不只是"哦，反正是被取消了"。

## 5. 我们在实现时真实踩到的两个坑

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

## 6. dispose 的幂等性

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

**为什么这条幂等性重要**：不是因为不这样写就会立刻崩溃——`cancel()` 内部调的 `AbortSignal.abort()` 对一个已经中止的信号再调一次本身就是安全的、清空一个已经空的队列也没事,今天这几个具体操作恰好都是"重复执行也无害"的。真正的价值在于第1节讲的那个场景：`dispose()` 天然会被好几条互不知情的调用路径各自触发,`Agent` 类没法阻止这种情况发生。`if (this.disposed) return` 这一行,把"重复调用是安全的"从一份**依赖当前几个操作恰好都无害的巧合**,变成一条**显式、可测试、不会因为以后往 `cancel()` 里加一行有副作用的代码而悄悄破功**的保证——调用方不需要互相协调"谁负责调、谁不许调"。

## 一句话总结

Day5 建立了"循环怎么跑"的骨架，Day6 给这个骨架装上了"怎么被外部安全地控制"的接口——排队、取消、释放。这三个操作看起来简单，但每一个都藏着"如果实现的时间点/检查顺序错了，就会产生竞态或悬挂状态"的陷阱。今天踩到的两个坑（`AbortSignal` 被误冻结、`whenIdle()` 语义误解）都不是"代码写错了一行"这种低级错误，而是"两个独立正确的设计，组合在一起产生了意料之外的交互"——这正是分布式/异步系统复杂性的本质来源，也是为什么"故障注入"和"竞态重复测试"要成为日常习惯，而不是可有可无的锦上添花。
