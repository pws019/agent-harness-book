# 白话讲解：持久化、flush 与崩溃恢复

> 素材来源：DSH `docs/subsystems/session.zh.md`、`docs/subsystems/persistence.zh.md`（篇幅所限，本篇更多是把 Day8 的事件日志真正落地，原文引用比前几天少）。今天做两件事：把 Day8 的 `Session` 真正接进 `Agent`；给它加上持久化和崩溃恢复。

## 0. 前置知识：你大概率已经写过"崩溃恢复"的简化版

如果你做过前端表单，大概率写过这种代码：用户填了一半表单，你 `localStorage.setItem('draft', JSON.stringify(formState))`，页面刷新/浏览器崩了之后，重新打开时 `localStorage.getItem('draft')` 读回来，表单自动填上刚才的内容。**这就是"持久化 + 崩溃恢复"的最简形态**——你已经解决过这个问题的一个简化版本。

今天的问题比这稍微复杂一点，两个地方：

1. **不是存一份"当前状态"的快照，是存一份"怎么一步步变成这样"的日志**（Day8 已经做了这件事——`Session` 事件日志）。今天要做的是把这份日志**真的写到磁盘上**，而不是只在内存里。
2. **"写到一半"的情况更棘手**：`localStorage.setItem` 要么整个成功要么整个失败（一次 `JSON.stringify` 完再写），但一份不断追加的日志文件，完全可能在写第 500 行的时候进程被杀掉，磁盘上留下一行只写了一半的 JSON——你的表单草稿例子不会遇到这个问题，但我们会。

## 1. 先把 `Session` 真正接进 `Agent`（Day8 留的作业）

**问题回顾**：Day8 的 `Session`/`deriveMessages()` 是一个独立、没被任何人用的模块。`Agent.history` 还是 Day1-7 那种手动 `.push()` 的数组。

**关键设计决定，先讲人话**：`runTurn()`（Day5）完全不需要知道 `Session` 的存在——它继续像过去四天一样，操作一个每次调用都新建的 `Message[]` 草稿数组。真正的翻译工作在 `Agent.drain()` 里：它本来就在用 `for await` 消费 `runTurn()` 吐出的每一个 `AgentLoopEvent`，现在只是**额外**把每个事件同步翻译成一条 `Session.append(...)`。

```
之前（Day5-8）：
  runTurn() ──yield AgentLoopEvent──▶ drain() ──收集进 events[] 数组──▶ TurnRecord

之后（Day9）：
  runTurn() ──yield AgentLoopEvent──▶ drain() ──┬─收集进 events[] 数组──▶ TurnRecord（不变）
                                                  └─翻译成 SessionEvent──▶ Session.append()
                                                                            │
                                                              Agent.history = deriveMessages(session.events)
```

`runTurn()` 的签名、`agent-loop.ts` 的代码、`agent-loop.test.ts` 的 10 条测试——**一行都没有改**。这不是运气，是设计上刻意换来的：把"要不要接 Session"这个决定，放在离 `Session` 最近的翻译层（`drain()`），而不是放进循环骨架本身，`runTurn()` 才能继续对"历史怎么持久化"这件事一无所知，专心做它自己的事。

## 2. 翻译表：`AgentLoopEvent` → `SessionEvent`

| `AgentLoopEvent` | 翻译成 | 备注 |
|---|---|---|
| （drain 自己出队一条消息时） | `turn/start` + `user/message` | `turn` 编号是 `drain()` 自己累加的（`nextTurnNumber++`），不是从 runTurn 拿到的 |
| `step-start{step}` | `step/start{turn,step}` | `step` 直接透传 |
| `model-response{message}`，且 `message.blocks.length>0` | `assistant/message{turn,step,message}` | 空消息（比如取消发生在请求发出之前，`message.blocks`是空数组）不记，不污染派生历史 |
| `tool-call{toolCall}` | `tool/call{turn,step,callId:toolCall.id,name,arguments}` | |
| `tool-result{toolCallId,content,isError}` | `tool/result{turn,step,callId:toolCallId,content,isError}` | |
| `step-end{step}` | `step/end{turn,step}` | |
| `turn-end{stopReason}` | 不在这里处理 | 见下一节——收尾要先处理"异常终止" |

`StopReason`（Day5 定义，`agent-loop.ts`）和 `TurnEndReason`（Day8 定义，`session.ts`）是**两个独立的类型**，故意不共用——`session.ts` 不应该反向依赖 `agent-loop.ts`（保持 Session 是比 Agent/runTurn 更底层的模块）。跨这条边界要手写一次映射：

```ts
function toTurnEndReason(stopReason: StopReason): TurnEndReason {
  switch (stopReason.kind) {
    case 'completed': return { kind: 'completed' }
    case 'cancelled': return { kind: 'cancelled' }
    case 'budget_exhausted': return { kind: 'budget_exhausted', reason: stopReason.reason }
    case 'error': return { kind: 'error', message: stopReason.failure.message } // LlmFailure 对象 → 一句话
  }
}
```

## 3. 一个真实的设计难题：turn 异常终止时，Session 的开闭配对怎么办

回忆 Day5 exercise 任务3：工具超时/取消不会产生 `tool-result`，`runTurn()` 直接 `yield turn-end` 提前收场,**根本不会走到自己的 `step-end`**。这意味着翻译层收到事件流时，`step/start` 已经写了、`tool/call` 已经写了，但永远等不到 `step-end` 事件——如果这时候直接写 `turn/end`,会撞上 Day8 定的不变式（"`turn/end` 不允许在还有开着的 step 时调用"）。

**解法**：`Session` 新增一个只读方法 `danglingActivity()`,返回"当前还挂起着什么"（哪个 turn、哪个 step（如果有）、这个 step 里还没等到结果的 callId 有哪些）。`closeDanglingActivity(session, reason)` 拿到这份信息后：

1. 如果有挂起的 `tool/call`：给每一个补写一条 `tool/result{isError:true, content:'turn ended before this call produced a result'}`——**诚实记录"这次调用没跑完"，不是伪造一个假装成功的结果**。这跟你在 Day4 `search_text` 那次发现的"静默丢弃"缺口是同一类问题,这次是从一开始就设计成不会发生。
2. 如果有开着的 step：补一条 `step/end`。
3. 最后写 `turn/end`。

这个函数会在**每一次** `drain()` 处理完一个 turn 后被调用（不只是异常路径）——正常完成时,`danglingActivity()` 只会告诉你"这个 turn 还没关"（因为 `turn/end` 本来就还没写），`step` 已经是 `undefined`（已经被正常的 `step-end` 关过了），所以第1、2步会被跳过，只补一条 `turn/end`。**一个函数，覆盖了"正常收尾"和"异常收尾"两种情况**，不需要在 `drain()` 里写两套逻辑分别处理。

## 4. 一个真实踩到的坑：收尾事件漏写进了持久化 store

`closeDanglingActivity` 第一版长这样：

```ts
export function closeDanglingActivity(session: Session, reason: TurnEndReason): void {
  const dangling = session.danglingActivity()
  if (!dangling) return
  // ...
  session.append('turn/end', { turn, reason }) // 直接调 session.append()
}
```

`Agent` 内部真正落盘的路径是 `appendEvent()`——它调 `session.append()` 之后**顺手把返回的事件转发给 `deps.sink`**（比如接了一个 `JsonlSessionStore`）。集成测试写出来一跑：`agent.sessionEvents`（内存里的）跟 `store.load().events`（磁盘上的）对不上——磁盘上永远少最后一条 `turn/end`。

**原因**：`closeDanglingActivity` 是一个独立的函数，不是 `Agent` 的方法，它直接调 `session.append()`,完全绕开了 `Agent.appendEvent()` 那层"顺手转发给 sink"的包装。内存里的 `Session` 是对的（`session.append()` 确实执行了），但持久化那份从这一条事件开始就悄悄漏了。

**修复**：给 `closeDanglingActivity` 加一个可选的第三个参数 `sink?: SessionSink`，内部自己包一层转发：

```ts
export function closeDanglingActivity(session: Session, reason: TurnEndReason, sink?: SessionSink): void {
  const dangling = session.danglingActivity()
  if (!dangling) return
  const append = <K extends SessionEventType>(type: K, data: SessionEventPayloadMap[K]): void => {
    const event = session.append(type, data)
    sink?.append(event)
  }
  // ... 后面全部改用 append(...) 而不是 session.append(...)
}
```

**这个坑值得记住的地方**：跟 Day3/Day5/Day6 那几个坑（请求冻结冻死可变数组、`AbortSignal` 被深冻结、取消检查时机）是同一类问题——**两个各自独立正确的设计（"翻译层顺手转发给 sink" 和 "收尾逻辑独立成一个可复用函数"）拼在一起时，产生了一个只有集成测试才能发现的缝隙**。孤立地测 `closeDanglingActivity`（不带 sink）和孤立地测 `Agent.appendEvent()`（正常路径下的转发）都不会暴露这个问题，只有"真的接一个 sink，走一遍完整的 turn"这种集成测试会。

## 5. 持久化：JSONL + 崩溃恢复语义

`JsonlSessionStore` 把 Session 的事件序列化成一行一行的 JSON：第一行是 header（格式版本号 + 创建时间），后面每行一条事件。`load()` 的崩溃恢复规则，用真值表讲清楚"哪种损坏会被怎么处理"：

| 损坏位置 | 处理方式 | 为什么 |
|---|---|---|
| 最后一行解析失败 | 丢弃这一行，保留之前所有完整行，标记 `truncated: true` | 这正是"进程写到一半被杀"的典型模式——前面的行都已经落盘完整，只有最后一行可能没写完 |
| 中间某一行解析失败（不是最后一行） | 整份日志判定为损坏，拒绝加载 | 中间缺一行会让后面的 `seq` 连续性、`tool/call`/`tool/result` 配对全部不可信，没有办法只跳过这一行继续读——"尽量抢救"反而可能读出一份看起来正常、实际上残缺的历史 |
| header 的 `formatVersion` 不匹配 | 拒绝加载 | 不同版本的事件形状可能不兼容，硬解析等于自欺欺人 |
| 完全没有 header（空文件） | 拒绝加载 | 连"这是不是一个 session 文件"都确认不了 |

**为什么"最后一行"和"中间某一行"要区别对待**——这条规则不是拍脑袋定的：日志是**仅追加**的（Day8 的核心约束），意味着"写入顺序"和"文件里的行号顺序"永远一致，唯一可能出现"半行"的位置就是文件末尾（正在写的那一行）。中间出现半行，只可能是文件本身被篡改/损坏，不是正常的追加语义能产生的结果——这时候"抢救"没有意义，因为你已经不知道还能信任哪些行了。

## 6. `Agent.restore()`：从磁盘恢复

```ts
static restore(deps: AgentDeps, events: readonly SessionEvent[]): Agent {
  const agent = new Agent(deps, events)          // Session.restoreFrom(events) 重建内部状态
  closeDanglingActivity(agent.session, { kind: 'cancelled' }, deps.sink)  // 收尾任何挂起的活动
  return agent
}
```

`Session.restoreFrom(events)` 跟 `append()` 走的是**同一套开闭校验逻辑**（`checkInvariant`），区别只是它保留原始 `seq`/`time`（不重新分配）——这保证了"从磁盘读回来的 Session"和"从头 `append()` 出来的 Session"，只要事件序列一样，内部状态（`danglingActivity()` 会返回什么）也完全一样，不需要一套单独的"恢复专用"校验逻辑。

`Agent` 的构造函数也顺手改成会从恢复的事件里算出正确的 `nextTurnNumber`（取所有 `turn/start` 里最大的 `turn` 加一），恢复之后再 `send()` 一条新消息，新 turn 的编号会接着算，不会跟已经关闭的旧 turn 撞车。

## 一句话总结

今天做的两件事，都是"让 Day8 搭好的抽象真正派上用场"：`Session` 从一个孤立模块变成 `Agent` 唯一的历史真源；日志从一份只存在于内存里的东西变成一份能扛住"进程被杀"的持久化记录。中间踩到的那个 sink 转发的坑，再一次印证了这几周反复出现的道理——**"两个各自正确的设计,拼在一起才会暴露的问题",永远值得留一条集成测试去覆盖，孤立的单元测试再多也测不出来。**
