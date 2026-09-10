# 阶段二全貌地图（Day8-14，仿照 Day00 的写法）

> 跟 [Day00](../day00-phase1-overview/) 一样：不含新概念、不用做练习，是学完 Day8-14 之后回来对照用的地图。Day00 讲的是"循环怎么跑"，这份讲的是"状态怎么存、怎么保证能重建"。

## 读法

跟 Day00 一样：从 Day8 学到 Day14，每学完一天回来对一遍这份文档，看着地图上多亮起来一块。

## 一张图：一次持久化调查，从命令行到磁盘再读回来

```
用户敲下 pnpm cli -- --workspace <dir> --query <q> --session-file <path>
  │
  ▼
cli.ts: runInvestigation(args)                    ← Day14
  │
  ├─ FileRawStore.exists(path)?
  │    │
  │    ├─ 否 → JsonlSessionStore.create(raw)       ← Day9：写 header，返回全新 store
  │    │
  │    └─ 是 → JsonlSessionStore.open(raw).load()  ← Day9：崩溃恢复语义
  │              │
  │              ├─ 中间行损坏 → 抛 SessionLoadError，直接失败
  │              ├─ 最后一行损坏 → truncated:true，raw.truncateTo() 物理修复  ← Day14 真实踩到的坑
  │              └─ 干净 → truncated:false
  │              │
  │              ▼
  │            Agent.restore(deps, events)         ← Day9：Session.restoreFrom() + closeDanglingActivity()
  │
  ▼
new Agent(deps) 或 Agent.restore(...) 都得到一个 Agent 实例，deps.sink 指向同一个 store
  │
  ▼
agent.send(userMessage)
  │
  ▼
drain()：跟 Day00 图一样的 turn/step 循环，只是现在每个 AgentLoopEvent 都会被翻译：
  │
  ├─ turn/start + user/message              ← Day8
  ├─ (deps.systemPrompt 配置了才有) system/message   ← Day11：现取 tools.schemas()，不缓存
  ├─ step/start
  ├─ assistant/message（带 usage? 字段）      ← Day12
  ├─ tool/call → tool/result（可能挂起，异常终止时被 closeDanglingActivity 补写）  ← Day8, Day9
  ├─ step/end
  └─ turn/end
  │
  ▼
每条事件 = appendEvent() = session.append() + sink?.append()  ← Day9 的翻译层
  │                                                              （sink 就是 JsonlSessionStore）
  ▼
JsonlSessionStore.append() → FileRawStore.appendLine()  ← Day14：真的写到磁盘上
  │
  ▼
（下次启动，同一个 --session-file）
  │
  ▼
inspect-session <path> → load() → projectSummary()/deriveTitle()   ← Day10
replay-session <path>  → load() → deriveMessages()                 ← Day8（Day13 起支持压缩替换）
```

## 每天在这张图里加了什么、为什么

| 天 | 主题 | 在图里对应哪一环 | 解决的核心问题 |
|---|---|---|---|
| [Day8](../day08-session-event-log/) | 仅追加事件日志与真源 | `Session`/`deriveMessages()`（独立模块，图里还没接线） | 历史从"手动维护的数组"变成"日志派生的视图" |
| [Day9](../day09-persistence-and-crash-recovery/) | 持久化、flush 与崩溃恢复 | `drain()` 翻译层、`JsonlSessionStore`、`Agent.restore()` | 真正把 Session 接进 Agent；日志能扛住进程被杀 |
| [Day10](../day10-projection-query-spill/) | 投影、查询、标题与 Spill | `projectSummary()`/`queryEvents()`/`deriveTitle()`/`spillLargeToolResults()` | 同一份日志派生出多种互不干扰的视图 |
| [Day11](../day11-system-prompt-and-capabilities/) | 系统提示词与能力组装 | `system/message` 事件、`buildSystemPrompt()` | prompt 里的能力清单必须实时反映当前状态，不能缓存 |
| [Day12](../day12-token-metering-and-budget/) | Token 计量、预算与成本控制 | `TokenMeter`、`assistant/message.usage`、`maxTokens` | "不知道花了多少"和"花了0"必须严格区分 |
| [Day13](../day13-context-compaction/) | 上下文窗口与压缩 | `compaction/*` 三事件、`deriveMessages()` 两趟扫描 | 历史变短，但原始日志一条都不能删 |
| [Day14](../day14-milestone-two/) | 里程碑二 | `cli.ts` 的 `--session-file`/`inspect-session`/`replay-session` | 验证整条链路真的能在真实文件系统上收敛 |

## 类型怎么一层层复合起来

**主线：跨越阶段一/阶段二边界的类型复用**——阶段二新增的所有事件 payload，几乎都直接复用了阶段一已经定义好的类型，没有重新发明：

```
Message（Day2 定义）
  └─ SessionEventPayloadMap['user/message'].message      （Day8）
  └─ SessionEventPayloadMap['assistant/message'].message （Day8）
  └─ SessionEventPayloadMap['compaction/summary'].message （Day13：摘要本身就是一条 assistant 消息）

TokenUsage（Day3 定义，GenerateResult.usage 字段）
  └─ SessionEventPayloadMap['assistant/message'].usage?   （Day12）
  └─ TokenMeter.record() 的参数类型                        （Day12）

StopReason（Day5 定义）→ toTurnEndReason() 映射 →  TurnEndReason（Day8 定义，独立类型）
  └─ SessionEventPayloadMap['turn/end'].reason
```

**带例子走一遍**（一次带 token 用量的工具调用 turn，最后触发了一次压缩）：

```jsonc
// 1. Day3 的 TokenUsage，原样出现在 assistant/message 里（Day12）
{ "type": "assistant/message", "seq": 8, "turn": 0, "step": 2,
  "message": { "role": "assistant", "blocks": [...] },
  "usage": { "inputTokens": 120, "outputTokens": 30 } }

// 2. Day5 的 StopReason 经过 toTurnEndReason() 映射成 Day8 的 TurnEndReason
// StopReason:  { kind: 'budget_exhausted', reason: 'max_tokens' }
// TurnEndReason（结构一样，但是独立类型，不是同一个）：
{ "type": "turn/end", "seq": 15, "turn": 0, "reason": { "kind": "budget_exhausted", "reason": "max_tokens" } }

// 3. Day13 的压缩摘要，本质就是一条 Day2 的 Message
{ "type": "compaction/summary", "seq": 40,
  "message": { "role": "assistant", "blocks": [{ "type": "text", "text": "[compacted 12 earlier events] ..." }] } }
```

**为什么值得注意这条主线**：阶段二整整7天、新增了11种事件类型，但**没有发明任何一种新的"消息内容"表示方式**——`ContentBlock`/`Message`（Day2）、`TokenUsage`（Day3）从头到尾都够用。这不是巧合，是"深模块"哲学的自然结果：Day2/3 把这两个类型设计得足够通用（不依赖任何具体业务场景），后面7天不管加多少新概念，都只是"用这两个类型的新组合方式"，不需要推倒重来。

## 类图：阶段二新增的"真正的类"只有两个

对照 [Day00 的类图](../day00-phase1-overview/README.md#类图这几天定义的类各自负责什么)——阶段一四个类（`BlockAssembler`/`LlmAdapter`+`AdapterRegistry`/`ToolRegistry`/`Agent`）之外，阶段二只真正新增了两个有状态的类：

```mermaid
classDiagram
  class Session {
    <<Day8, 有状态>>
    -SessionEvent[] log
    -number/undefined openTurn
    -OpenStep/undefined openStep
    -openCompaction
    +append(type, data) SessionEvent
    +danglingActivity() DanglingActivity
    +events: SessionEvent[]
    +static restoreFrom(events) Session
  }
  note for Session "唯一真源。Agent 不再自己维护 history，\n只维护一个 Session 实例，history 是它的派生视图。"

  class TokenMeter {
    <<Day12, 有状态>>
    -inputTokens: number|'unknown'
    -outputTokens: number|'unknown'
    +record(usage) void
    +totals() TokenUsageTotals
  }
  note for TokenMeter "跟 BlockAssembler 一样是个\"一次性用品\"——\nrunTurn() 每次调用 new 一个新的。"

  class JsonlSessionStore {
    <<Day9/14, 有状态但只是薄薄一层>>
    -RawStore raw
    +append(event) void
    +load() LoadResult
    +static create(raw) JsonlSessionStore
    +static open(raw) JsonlSessionStore
  }
  note for JsonlSessionStore "自己不存状态，状态全在 RawStore\n（InMemoryRawStore 或 FileRawStore）里。"

  Session ..> JsonlSessionStore : Agent 把两者用 appendEvent() 粘在一起，\n彼此互不知道对方存在
```

**`session-projection.ts`/`compaction.ts`/`system-prompt.ts`/`spill.ts`——一个类都没有**，全是纯函数。这不是随意的风格选择：这几个模块做的事（"给一份不可变的 events 数组，算出点什么"）天然不需要跨调用保留状态，纯函数比类更简单、更容易独立测试、也不需要考虑"什么时候该 new 一个新实例"这种问题——回忆 Day00 类图那条总结："状态越多的类，需要操心的并发/生命周期问题就越多"，阶段二绝大多数新增代码有意识地避开了引入新状态，只有 `Session`（唯一真源，必须有状态）和 `TokenMeter`（一次性累加器，跟 `BlockAssembler` 同款）是例外。

## 贯穿阶段二的一条主线：三个"组合起来才暴露"的坑

阶段一（Day1-7）已经反复印证过"两个各自正确的设计拼在一起才会暴露问题"这条教训，阶段二三天里又各中招一次，模式一模一样：

| 天 | 坑 | 独立测试为什么测不出来 |
|---|---|---|
| Day9 | `closeDanglingActivity` 直接调 `session.append()`，绕开了 `Agent.appendEvent()` 的 sink 转发 | 单独测 `closeDanglingActivity`（不接 sink）没问题；单独测 `appendEvent()` 的正常转发路径也没问题 |
| Day13 | `planCompaction` 重复压缩时算出重叠区间，被 `deriveMessages` 按 `fromSeq` 去重的逻辑吞掉 | 单独测"压缩一次"没问题；单独测"派生一个区间"也没问题 |
| Day14 | 恢复时不物理修复损坏的尾巴，导致续写把新事件粘在垃圾后面 | 单独测"检测到 truncated"没问题；单独测"正常 append"也没问题 |

**这不是巧合，是集成测试和单元测试的本质分工**：单元测试证明"这一个函数在假设的输入下行为正确"，但"上一个函数的输出恰好是下一个函数没预料到的输入"这种问题，只有真的把两者串起来跑一遍才会现形。三次坑，三次都是被一条专门"把两件事串起来"的测试抓到的——这也是为什么本课程从 Day5 开始就反复强调"实现纵切"和"故障注入"，而不是只追求单元测试覆盖率数字。
