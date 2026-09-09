# Day 0・阶段一全貌地图（Day1-7 一张图看完）

> 这不是新的一天，不含新概念、不用做练习。它的作用是"地图"：每天读代码读到细节里出不来的时候，回来看一眼这份文档，找到自己现在钻的这行代码属于哪一环、这一环是哪天引入的、为什么需要它。

## 读法

不需要现在就看懂下面每一个词——这份文档故意放在 Day1 之前，你现在看不懂大部分术语是正常的。真正的用法是：**从 Day1 开始学，每学完一天回来这里对一遍**，看着地图上多亮起来一块。等 Day7 做完再完整看一遍，应该能不看代码，口头把这张图从头讲到尾。

## 一张图：一次用户请求，完整走一遍会经过哪些环节

```
用户在 CLI 敲下一个问题
  │
  ▼
Agent.send(message)                         ← Day6：排队进 inbox，不打断正在跑的 turn
  │
  ▼
Agent.drain() 内部循环，顺序处理队列          ← Day6：单 writer，任何时刻只有一个 turn 在跑
  │
  ▼
runTurn(history, deps, options)             ← Day5：turn/step 骨架，一个 async generator
  │
  ├─ yield 'turn-start'
  │
  ├─┬─ step 1 开始
  │ │
  │ │  generateWithRetry(adapter, options)   ← Day3：重试循环、退避策略、请求深冻结
  │ │    │
  │ │    │  adapter.stream(frozen)           ← Day3：LlmAdapter 抽象接口，屏蔽具体 provider SDK
  │ │    │    │
  │ │    │    ▼
  │ │    │  StreamChunk 逐个吐出              ← Day2：block-start/text-delta/tool-call-delta/block-end/usage/finish
  │ │    │    │
  │ │    │    ▼
  │ │    │  new BlockAssembler().push(chunk) ← Day2：把散乱分片折叠成完整 ContentBlock[]
  │ │    │    │
  │ │    ▼    ▼
  │ │  assembler.result() → { blocks, finish } → classifyFinish() 纠正畸形 finish
  │ │
  │ │  yield 'model-response'
  │ │
  │ │  ┌─ finish.kind === 'error'/'aborted' → turn-end，结束
  │ │  │
  │ │  └─ 有 tool-call 块？
  │ │        │
  │ │        ▼
  │ │      executeToolCall() → ToolRegistry.execute()   ← Day4：参数校验→取消检查→超时/取消赛跑→execute→render
  │ │        │                    │
  │ │        │                    ▼
  │ │        │                  read_file / list_files / search_text   ← Day4：三个只读深工具
  │ │        │
  │ │        ▼
  │ │      工具结果打包成 tool 消息，history.push()
  │ │
  │ │  yield 'step-end'
  │ └─ 没有欠工作了？→ 回到 step 开始，继续下一 step；欠工作清零 → 完成
  │
  ▼
return StopReason（completed / cancelled / budget_exhausted / error）  ← Day5：generator 的 return 值，不是 yield
  │
  ▼
Agent.records.push(TurnRecord)              ← Day6：这一条 turn 的最终记录
  │
  ▼
CLI 把结果打印出来                            ← Day7：把以上全部拼成一个能跑的命令行程序
```

## 每天在这张图里加了什么、为什么

| 天 | 主题 | 在图里对应哪一环 | 解决的核心问题 |
|---|---|---|---|
| [Day1](../day01-agent-vs-workflow/) | Agent / Workflow / Harness 边界 | 图外——决定"这件事到底该不该用这整套东西" | 先证明"这个任务真的需要 Agent loop"，不是默认所有任务都要上 |
| [Day2](../day02-llm-message-and-streaming/) | 消息模型与流式协议 | `StreamChunk` → `BlockAssembler` | provider 返回的是网络分片，怎么折叠回一条完整消息、怎么防畸形流 |
| [Day3](../day03-adapter-boundary/) | Adapter 边界与请求信封 | `LlmAdapter` → `generateWithRetry` | Agent loop 不认识任何具体 provider SDK；失败怎么分类、怎么重试 |
| [Day4](../day04-tool-design/) | 工具设计 | `ToolRegistry.execute()` → 三个只读工具 | 模型要的是"意图层面"的简单接口，复杂度（校验/超时/取消）下沉到管线里 |
| [Day5](../day05-agent-loop/) | Agent Loop | `runTurn()` 整个骨架 | turn/step 什么时候该继续、什么时候该停，"数据说了算"不是"模型嘴上说了算" |
| [Day6](../day06-lifecycle-and-cancellation/) | 生命周期、取消与并发 | `Agent.send/cancel/dispose/whenIdle` | 外部怎么安全地控制这个循环——排队、取消、释放,不产生竞态 |
| [Day7](../day07-milestone-cli/) | 里程碑一：CLI | 把以上全部拼装起来 | 验证六天搭的骨架能不能撑起一个真实可跑的东西，在各种坏路径下行为可预期 |

## 贯穿全程的几条设计主线（不属于任何单独一天，是反复出现的思想）

这几条不是某一天的知识点，是从 Day2 到 Day6 反复出现、每次以不同形式印证的同一批原则——读代码时如果感觉"这个设计怎么又出现了"，大概率就是撞上了下面某一条：

- **深模块，浅接口**：模型/调用方看到的接口越来越简单（工具只传 `file_path`/`offset`/`limit`），复杂度（校验、超时、重试、取消）全部被吸进对应模块内部，不转嫁给调用方。Day4 讲得最集中，但 Day3 的 `generateWithRetry`、Day6 的 `Agent` 类都是同一条原则的不同落地。
- **数据说了算，不是模型嘴上说了算**：Day5 的"只信 blocks 数据不信 finish.kind 自报"、Day2 的"组装器只认已封箱的块"，本质是同一条：系统的终态判断必须建立在可观察的状态上，不能建立在一个不可靠信号（模型的自我报告）上。
- **用设计定义掉特殊情况**：Day4 的 `additionalProperties` 必须在定义期显式声明、Day2 的畸形流直接被组装器拒绝——遇到"这种情况按理说不该发生"的场景，优先考虑能不能让接口设计本身就不允许它发生，而不是到处写 if 兜底。
- **取消不是布尔值**：Day6 专门讲，但 Day4 的 `ToolAbortedError`、Day3 的 `ABORTED` 永不重试都是这条原则更早的伏笔——"取消了没有"不够，"谁取消的、为什么"同样要被记录。
- **异常冒泡到"知道该怎么处理"的那一层，不是抛出的那一层自己兜底**：Day4 的 `ToolRegistry.execute()` 故意不 catch 自己抛出的错误，交给 Day5 的 `executeToolCall()` 决定转成 `isError` 结果——这是职责分层，不是遗漏。
- **每一层都在真实踩坑中暴露、而不是设计时凭空想到**：`freezeRequest` 冻死可变历史数组（Day3+Day5 组合出的坑）、深冻结连 `AbortSignal` 都冻住了（Day3 埋雷、Day6 暴露）——这些坑都是"两个独立正确的设计拼在一起才炸"，也是为什么"设计两次"和端到端集成测试比孤立的单元覆盖率更重要。

## 一句话记忆法（如果只能记一句）

**"一次用户输入，被 `Agent` 排进队列，`runTurn` 用 turn/step 的节奏反复问模型、执行工具、更新历史，直到数据显示不再欠任何工作；这中间每一层——消息怎么拼、模型怎么调、工具怎么跑、怎么被取消——都遵循同一条原则：接口给外面的越简单，内部主动扛的复杂度就越多。"**
