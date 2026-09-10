# 白话讲解：仅追加事件日志与真源

> 素材来源：DSH `docs/subsystems/session.zh.md`。今天开始进入阶段二"可回放的状态与上下文"——Day1-7 搭的是"循环怎么跑"，今天开始搭"状态怎么存、怎么保证能重建"。

## 0. 前置知识：事件溯源（Event Sourcing），你可能已经用过它的近亲

如果你写过 Redux/Vuex，你已经见过这个模式的一个变体，只是没往这个方向想过：

- Redux 的 `state` 不是一份你随手改的数据，它是 `actions` 数组**reduce 出来的派生结果**——`store.getState()` 背后其实是 `actions.reduce(reducer, initialState)`。
- Redux DevTools 的"时间旅行调试"（time-travel debugging）能做到"回到第 17 步的状态"，靠的正是**把 action 序列重新 reduce 到那个位置**，不是真的存了 100 份历史快照。

**事件溯源就是这个模式的正式名字，用在"整个系统的状态"这个更大的范围上**：不直接存"当前状态"，而是存一份**只能追加、不能修改**的事件日志，当前状态永远是**从这份日志重新计算出来的**。今天要做的 `Session`（事件日志）和 `deriveMessages()`（派生函数），分别对应 Redux 的 `actions` 数组和 `reducer`——`deriveMessages(events)` 就是我们的 `reducer`，只是它一次性把所有事件"reduce"成最终的消息列表，而不是逐个 action 折叠出一个新 state。

## 1. 为什么不能继续让 `Agent.history` 就是一个手动维护的数组

**先讲问题**：Day1-7 里，`Agent.history: Message[]` 是一个被到处 `.push()` 的可变数组——`drain()` 里 push 用户消息，`runTurn()` 里 push 助手消息、push 工具结果消息。这在只考虑"内存里跑一次"的场景下没问题，但一旦你想做下面这些事，裸数组就不够用了：

- **崩溃恢复（Day9 的话题）**：进程重启后，怎么知道 `history` 应该长什么样？裸数组一旦进程退出就没了，没有任何"这个数组是怎么一步步变成现在这样的"的记录。
- **审计/回放**：出了问题想知道"第17步到底发生了什么"，一个只有最终状态的数组答不出这个问题——它早就被后面的 push 覆盖式地改变了外观（虽然是追加，但你没法轻易倒回去看某个中间时刻的快照）。
- **多个视图共享同一份真相**：以后如果要同时支持"给模型看的消息历史"和"给 UI 看的时间线"（Day10 的 projection），两份视图如果分别手动维护，很容易出现"UI 说完成了，但发给模型的历史其实还差一条"这种漂移。

**改法**（对比着看）：

```
之前：Agent.history: Message[]（手动维护，直接改）
  drain()  ──push(userMsg)──▶  history
  runTurn() ──push(assistantMsg)──▶  history
  runTurn() ──push(toolMsg)──▶  history
  用的时候直接读 history

之后：Session（仅追加事件日志） + deriveMessages()（派生函数）
  drain()  ──append('user/message', ...)──▶  Session.events
  runTurn() ──append('assistant/message', ...)──▶  Session.events
  runTurn() ──append('tool/call'/'tool/result', ...)──▶  Session.events
  用的时候：deriveMessages(session.events) 现算一份 Message[]
```

**这一天先做前半部分**：`Session` 类和 `deriveMessages()`，作为独立、有完整测试覆盖的模块先跑通。**`Agent`/`runTurn` 还没有真的改成往 `Session` 里 `append`**——那是 Day9 引入持久化时才做的集成（先把"日志该长什么样、派生规则对不对"钉死，再谈"怎么把现有六天的代码接上去"，这是"设计两次"的又一次实践：先独立验证一个新抽象，再考虑怎么嵌入旧系统，比两件事一起做出错的概率低）。

## 2. 事件词汇：`SessionEventPayloadMap`

```ts
export interface SessionEventPayloadMap {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: TurnEndReason }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'user/message': { turn: number; message: Message }        // message.role === 'user'
  'assistant/message': { turn: number; step: number; message: Message }  // role === 'assistant'
  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string }
  'tool/result': { turn: number; step: number; callId: string; content: string; isError: boolean }
}
```

八种事件，分两类：

- **边界标记**（`turn/start`/`turn/end`/`step/start`/`step/end`）——不会变成任何消息，纯粹记录"这里开始/结束了一轮/一步"。
- **surface 事件**（`user/message`/`assistant/message`/`tool/result`）——`deriveMessages()` 只认这三种，把它们按顺序拼成 `Message[]`；`tool/call` 单独存在，只是"这次调用请求了什么"的审计记录，它的内容其实已经包含在 `assistant/message` 携带的 `Message.blocks` 里了（回忆 Day00 类型复合图的主线二：`ToolCallBlock` 就在 `assistant/message` 的 `message.blocks` 里）。

每条事件除了自己的 payload，还统一带两个字段：

```ts
{ type: K; seq: number; time: number } & SessionEventPayloadMap[K]
```

- **`seq`**：这条事件在日志里的位置，从 0 开始严格递增（`seq = 当前日志长度`）——不是"事件编号"这种业务概念，纯粹是"第几条"。
- **`time`**：写入时的 epoch 毫秒时间戳。

## 3. 今天故意没做的部分（对照 DSH 完整事件表，YAGNI）

DSH 真实的 `SessionEventMap` 比这大得多——`system/message`（系统提示词组装，Day11 的话题）、`assistant/attempt`（一次没有产出任何 surface 消息的模型尝试，比如失败重试）、`request/header`/`request/context`（请求信封快照）、`session/end-seed`（fork/resume 的分界标记）……今天全部先不做。理由跟 Day6 不做 `steer`/`inject` 一样：这些字段服务的是我们还没碰到的场景（系统提示词组装是 Day11、fork/resume 是更后面的话题），提前搭这些字段只会让今天的核心概念（"仅追加 + 派生"）被淹没在一堆用不上的类型里。

## 4. 不变式：`append()` 到底在防什么

`Session.append()` 写入前会做两件事，任何一件不满足就直接抛 `SessionAppendError`，不允许写入一条会让日志变得自相矛盾的记录：

**第一件事——JSON 校验**（`isJsonValue`）：跟 Day3 `deepFreeze`、Day6 讲的"纯数据判断"是同一个思路——只允许 `null`/字符串/布尔/有限数字/纯数组/普通对象字面量的任意嵌套组合，`undefined`、`NaN`、函数、`class` 实例一律拒绝。原因也一样："写不进日志的东西不该被允许存在"，这是"用设计定义掉特殊情况"——而不是靠"写代码的人自己小心不要往事件里塞一个 `Date` 对象"。

**第二件事——开闭配对**，靠 `Session` 内部维护的一小段状态（当前开着的 turn/step、这个 step 里还没等到结果的 `callId` 集合）逐条校验：

| 尝试写入的事件 | 什么情况下被拒绝 |
|---|---|
| `turn/start` | 已经有一个 turn 开着，还没 `turn/end` |
| `turn/end` | 它的 `turn` 跟当前开着的不是同一个；或者当前还有 step 没关 |
| `step/start` | 不在任何开着的 turn 里；或者已经有另一个 step 开着 |
| `step/end` | 它的 `(turn, step)` 跟当前开着的不匹配；或者这个 step 里还有 `tool/call` 没等到 `tool/result` |
| `tool/call` | 不在当前开着的 `(turn, step)` 里；或者这个 `callId` 在本 step 里已经调用过 |
| `tool/result` | 它的 `callId` 不在"当前 step 里等待结果"的集合里（要么压根没调用过，要么已经被结果消费掉了） |

这张表不是凭空列的——每一行对应根大纲里写的其中一条不变式（"同一 turn/step 的开闭必须配对""tool result 必须对应先前 callId"）。**这些校验放在 `append()` 里，而不是留给 `deriveMessages()` 事后检查**，是故意的：`deriveMessages()` 是纯函数，只管"把已经写进日志的东西派生成消息"，它不该、也没有能力去判断"这条日志本身写得对不对"——让 `append()` 在写入的那一刻就拒绝非法序列，`deriveMessages()` 才能放心地假设"日志里的东西都是合法的"，不用重复做一遍防御。

## 5. `deriveMessages()`：唯一允许生成 `Message[]` 的地方

```ts
export function deriveMessages(events: readonly SessionEvent[]): Message[]
```

三条规则，前两条你已经很熟悉：

1. **纯函数**：不读任何外部状态，同样的 `events` 数组，任何时候调用都产出一模一样的 `Message[]`——这正是"replay 两次得到相同派生结果"这条不变式的字面实现,不需要额外写什么特殊逻辑去"保证"它,纯函数这个约束本身就保证了它。
2. **只认 surface 事件**：`turn/*`/`step/*`/`tool/call` 全部跳过，只有 `user/message`/`assistant/message`/`tool/result` 会变成消息，跟 Day2 `BlockAssembler` 那种"switch 每个 case、用 `assertNever` 兜底"的写法一模一样——新增一种事件类型却忘了在这里处理，编译直接报错。
3. **`tool/result` 按 `(turn, step)` 分组合并**：同一个 step 里连续出现的多条 `tool/result`，会被合并成**一条** `{ role: 'tool', blocks: [...] }` 消息，而不是各自变成一条独立消息——这是为了跟 Day5 `runTurn()` 现在的行为对齐（一个 step 的所有工具结果打包成一条 tool 消息），Day9 真正把 `Agent` 接到 `Session` 上时，行为不会变。

## 一句话总结

今天做的事，是把"消息历史"从"一个被随手改写的数组"，改造成"一份只能追加、写入即校验合法性的日志 + 一个把日志变成消息列表的纯函数"。这个改造本身现在看不出直接的好处（内存里跑一次，两种做法效果一样），它的价值要等 Day9 引入持久化之后才会显现——一份"仅追加日志"天然适合往磁盘上增量写（每次只 append 一条，不用整份重写），一个裸数组不行。这是典型的"提前搭好正确的抽象，价值在下一步才兑现"的例子，不是"为了显得高级"而多绕一层。
