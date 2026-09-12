# Day 6 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. 为什么必须显式建模，不能靠"程序员自己小心"**

"程序员自己小心"这种保证方式天然有两个问题：没法验证（没有编译器或测试能确认所有调用方都遵守了规则，规则只存在于文档/注释/某人记忆里）、不会随代码库增长而自动扩展（调用方越多，协调失败的概率越高）。显式建模把规则从"靠人记住"搬到"靠代码本身强制成立"——比如 `dispose()` 幂等、`AgentCancelCause` 结构化记录取消原因、inbox 排队让并发写变得不可能、`AgentHandle` 让只有持有句柄的代码才能释放。详见 [study.md §1](./study.md)。

**2. 取消不是布尔值**

```ts
type AgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }
```

如果取消只是一个 `boolean`，没法回答"这次取消到底是谁发起的、为什么"。"第一个 cause 获胜"——同一次活动被取消后，后续的 `cancel()` 调用不改变已经记录下来的原因，这个原因会被记进 `TurnRecord.cancelCause`。

**3. "每个会话单 writer"**

`Agent.send()` 把新消息 push 进 `nextTurnQueue` 排队，`drain()` 循环顺序从队列里 `shift()` 处理，永远不会有两个 turn 同时跑，不会出现两次 `runTurn()` 并发修改同一份 `history`。

**4. dispose 为什么必须幂等**

`if (this.disposed) return`——不是因为不这样写就会立刻崩溃（今天这几个具体操作恰好都是重复执行也无害的），而是因为 `dispose()` 这类清理动作天然会被好几条互不知情的调用路径各自触发（正常完成路径、`try/finally` 异常兜底、进程信号处理器），这几条路径没法互相协调"谁负责调、谁不许调"。幂等性把"重复调用是安全的"从一份依赖当前操作恰好无害的巧合，变成一条显式、可测试、不会因为以后往 `cancel()` 里加副作用代码而悄悄破功的保证。`dispose()` 复用 `cancel()` 而不是自己另写一套停止逻辑，本质也是避免维护第二条容易出错的"取消传播路径"。

## 验收自查

**为什么 `AbortSignal` 不能被深冻结**：`AbortSignal` 不是一份"数据"，是一个"活的"平台对象，`controller.abort()` 需要修改它内部的状态（Node 通过一个 symbol 属性标记"已中止"）。一旦被 `Object.freeze()`，`controller.abort()` 会直接抛异常，取消功能整个失效。修复是让 `deepFreeze` 只递归冻结"纯数据"（普通对象字面量和数组），遇到不是纯数据的对象（`AbortSignal`、任何 class 实例）直接跳过。**如果 Day3 当时就修了这个坑**：会更快写完 Day6，因为 Day6 是在真正把取消跟"已经写好的、深冻结过的请求"接起来时才暴露这个问题——这正是"设计两次"和"实现纵切"比"孤立测每一层"更重要的原因，两个各自独立正确的设计（Day3 的深冻结、Day6 的取消）只有真正拼在一起、跑一个端到端场景时才会暴露问题；提前发现的成本远低于事后发现（Day3 写的时候顺手多想一步"冻结范围里有没有活对象"，比 Day6 才反查回去省事得多）。

**`whenIdle()` resolve 时能确定什么、不能确定什么**：能确定"整个 driver（`drain()` 循环）现在没有活干了"；**不能**确定"我刚才 `send()` 的那条消息处理完了"——如果在你等待期间，别的调用方也 `send()` 了新消息，`whenIdle()` 会等到**两条都处理完**才 resolve，不会漏算新工作，但也没法单独告诉你"哪一条"处理完了。如果需要跟踪某一条具体消息的结果，应该看 `agent.records`（每条 turn 完成后追加一条 `TurnRecord`），不能靠 `whenIdle()` 的 resolve 时机反推。
