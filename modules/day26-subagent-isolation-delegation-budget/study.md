# 白话讲解：Subagent——隔离、委派与预算

> 素材来源：DSH `docs/subsystems/subagent.zh.md`。今天要给 `Agent` 添一个新能力：自己动态创建、管理另一个 `Agent`——但"允许一个 Agent 造另一个 Agent"这句话本身藏着好几个陷阱（历史会不会串、父子谁的权限说了算、要不要设个上限防止无限递归造下去），今天的代码就是在挡这几个陷阱。

## 0. 这天为什么不需要 Day22 的 HTTP 层

先破除一个容易顺着课程顺序产生的误解：Day22-25 一路都在给 `Agent` 接"外部世界"的能力（网络、断线重连、语言服务进程、代码沙箱），容易让人以为 Day26 的"子 Agent"也需要走网络。**不需要**——`Agent`（`agent-handle.ts`，Day6）本身就是一个纯粹的、进程内的 TypeScript 对象，父 `Agent` 可以在同一个 Node 进程里直接 `new Agent(...)` 构造出子 `Agent`，两者之间不隔着任何网络连接，也不需要 Day22 的 `SessionRegistry`/HTTP 服务器。今天要处理的问题——历史会不会串、权限会不会升级、预算要不要控制——在"两个对象活在同一个进程里"这个最简单的场景下就已经真实存在，先把这些问题在进程内解决清楚，比一上来就绑定"必须走网络"这个假设更接近问题的本质。

## 1. 一次委派要经过哪些代码

```
父 Agent 的调用方（比如一次工具调用的 execute()）
      │
      ▼
SubagentManager.startChild(spec)          ← subagent.ts，立即返回，不等子 Agent 跑完
      │
      ├─ budget.canStart(depth)？          ← DelegationBudget，fail-closed
      │     └─ 不行 → 抛 SubagentBudgetExceededError，一个 Agent 都不会被创建
      │
      ├─ 子 preset 权限 > 父 preset？       ← presetRank()，显式偏序
      │     └─ 是 → 抛 SubagentPermissionEscalationError
      │
      ├─ budget.recordStart()
      ├─ new Agent(spec.deps)              ← 全新、独立的 Session，不共享父的历史
      ├─ （配了 maxTimeMs 就）挂一个定时器，到点调用 agent.cancel()
      └─ agent.send(spec.task)
      │
      ▼
返回 SubagentHandle { id, result(), dispose() }   ← 调用方现在可以去做别的事
      │
      ▼（某个时候）
handle.result() 被 await
      │
      ▼
await agent.whenIdle()
      │
      ├─ budget.recordEnd(汇总的 token 用量)
      └─ extractStructuredResult(record)    ← 只有这一份东西能跨越父子边界
      │
      ▼
StructuredResult { ok, data }               ← createStructuredResult() 强制过 isJsonValue() 校验
```

## 2. 独立的 Session：为什么子 Agent 不能共享父的历史

`SubagentManager.startChild()` 里，子 Agent 是这样创建的：

```ts
const agent = new Agent(spec.deps)
```

`spec.deps` 是一份全新的 `AgentDeps`（不含 `sink`），`new Agent(...)` 构造出来的是一个**全新、独立**的 `Session`（Day8）——子 Agent 从零开始积累自己的事件日志，看不到父 Agent 已经有过的任何 `turn/step`。这不是"偷懒没接上"，是刻意的边界：Day8 事件溯源要消除的正是"历史被跨 turn 污染"这类问题（一次调用的副作用意外影响到另一次调用），如果子 Agent 直接复用父 Agent 的 `Message[]`/`Session` 实例,子 Agent 产生的 `turn/step` 事件会跟父 Agent 自己的搅在一起，父 Agent 后续调用 `deriveMessages()` 得到的历史会包含"父 Agent 从来没有真正说过"的内容——`Session` 的开闭配对不变式（Day8）也会被并发写坏（子 Agent 在跑的时候父 Agent 可能也在同时处理自己的下一条消息）。独立 `Session` 从根源上让这类交叉污染不可能发生，不需要靠"记得不要这样用"这种约定来维持。

## 3. 只有 `StructuredResult` 能跨边界，不是完整的事件日志

```ts
export interface StructuredResult {
  readonly ok: boolean
  readonly data: unknown
}
```

父 Agent 拿到的子 Agent 结果，只有这一个形状——不是子 Agent 完整的 `sessionEvents`，不是它调用过哪些工具、中间想了什么。`extractStructuredResult()`（[subagent.ts:58-66](../../mini-harness/src/core/subagent.ts#L58-L66)）只取子 Agent 最后一条 `model-response` 事件里的文本块，跟 `cli.ts` `runInvestigation()` 提取 `finalText` 是同一个模式（Day7 起就是这样：最终结果 = 最后一次模型回复的文本，不是完整过程记录）。

真正强制这个边界的是 `createStructuredResult()`（Day8 `isJsonValue()` 的复用，见 `structured-result.ts`）——它不是一个"建议"，是一道真正的校验：子 Agent 想返回的东西如果混进了函数、`undefined`、循环引用这类没法安全序列化的值，会在这里直接抛 `InvalidStructuredResultError`，不会让一个"看起来像 JSON 但其实不是"的值一路带到父 Agent 手里才出问题。这跟 Day8 `Session.append()` 用同一个函数保证"日志里只能有无损 JSON"是同一条纪律，只是应用场景从"事件能不能安全落盘"换成了"结果能不能安全跨越父子边界"。

## 4. 权限不能升级：一张真值表

`PermissionPreset`（Day19）目前只有三种：`readonly`/`balanced`/`autonomous`。`presetRank()`（[subagent.ts:21-30](../../mini-harness/src/core/subagent.ts#L21-L30)）给它们一个显式的偏序——不是靠猜哪个名字"听起来更严格"：

```ts
const PRESET_RANK = { readonly: 0, balanced: 1, autonomous: 2 }
```

| 父 preset | 子 preset | `startChild()` 的反应 |
|---|---|---|
| `readonly`（0） | `readonly`（0） | 允许（相等） |
| `readonly`（0） | `balanced`（1） | 拒绝，抛 `SubagentPermissionEscalationError` |
| `balanced`（1） | `readonly`（0） | 允许（子的权限更小） |
| `balanced`（1） | `autonomous`（2） | 拒绝 |
| `autonomous`（2） | 任何一个 | 允许 |
| 任何一个 | 一个不在 `PRESET_RANK` 里的名字 | 拒绝——`presetRank()` 直接抛错，不是当成"最低权限"悄悄放行 |

最后一行是 fail-closed 的具体体现：跟 Day18 `FailClosedCommandPolicy` 同一个纪律——遇到不认识的东西，明确拒绝，不是找一个"看起来安全"的默认值糊弄过去。

**这张表有一个前提没写出来**：`startChild()`（[subagent.ts:95](../../mini-harness/src/core/subagent.ts#L95)）真正的判断条件是 `spec.preset && this.parentPreset && presetRank(...) > presetRank(...)`——升权检查**只在父子双方都给了 preset 的时候才会执行**。如果 `SubagentManager` 构造时没传 `parentPreset`（`this.parentPreset` 是 `undefined`），哪怕子 Agent 的 `spec.preset` 是 `autonomous`，这个条件会在 `this.parentPreset` 那一步短路成 `false`，升权检查完全不会跑，子 Agent 会被正常允许启动。这不是一个隐藏的漏洞，是"省略 preset 参数"这个调用方式本身的合理后果：`SubagentManager` 没有被告知父 Agent 处于什么权限级别，也就没有基准可以拿来比较——跟 Day19 `PermissionPreset` 今天还没有接进真正的工具执行路径是同一件事的另一个体现：升权检查这道防线,只有调用方主动把父子双方的 preset 都传进来,才会真正生效。

## 5. `DelegationBudget`：跟 `JobRuntime` 是同一类"谁掌握计数、谁负责检查"

```ts
canStart(currentDepth: number): boolean
recordStart(): void
recordEnd(tokensUsedByChild: number): void
```

`DelegationBudget` 是这一整棵委派树预算的唯一权威——`SubagentManager.startChild()` 在真正调用 `new Agent()` 之前先问它"现在能不能开"，`canStart()` 里任何一步计算出错都直接判定为"不能开"（`try/catch` 兜底），fail-closed。`recordStart()` 必须在**确定要真的启动**的那一刻调用（[subagent.ts:99](../../mini-harness/src/core/subagent.ts#L99)，在 `new Agent()` 之前），不能等子 Agent 跑完才补记账——这是 Day17 "唯一知道真实计数的地方才该做检查"那条原则的又一次应用：如果记账推迟到跑完之后，两个几乎同时调用 `startChild()` 的请求会在 `canStart()` 那一刻都看到"还没到上限"，一起被放行，`maxConcurrent` 这道限制就完全失效了。

`maxTokens` 的检查是**追溯性**的：只在"已经跑完的子 Agent 累计花了多少"基础上决定要不要允许下一个启动，拦不住一个**已经在跑**的子 Agent 自己超支（那是 Day12 `TokenMeter`/`maxTokens`——单个 Agent 内部的预算机制管的事,是另一层）——这是一个诚实记录在代码注释里的边界，不是没想到。`maxTimeMs` 不一样，是真的会生效：`startChild()` 挂一个 `setTimeout`，到点调用 `agent.cancel({kind:'parent'})`（[subagent.ts:104-108](../../mini-harness/src/core/subagent.ts#L104-L108)）——这是 Day6 已经建好的取消机制在"父 Agent 不耐烦地掐断子 Agent"这个新场景下的复用，不是重新发明一套超时逻辑。

## 6. 没有孤儿 child：级联 dispose

```ts
async disposeAll(): Promise<void> {
  await Promise.all([...this.children.values()].map((agent) => agent.dispose()))
  this.children.clear()
}
```

父 Agent 结束时调用 `SubagentManager.disposeAll()`，级联 dispose 掉所有还活着的子——不管子 Agent 当时在跑什么，都会被真正取消、真正释放。`Agent.dispose()` 本身幂等（Day6）：对一个已经跑完、或者已经 dispose 过的子 Agent 重复调用是安全的 no-op，`disposeAll()` 不需要先判断"这个子还活着吗"再决定要不要 dispose，直接对全部子实例调用一遍就够了——跟 Day17 `JobRuntime.dispose()` 面对"任务可能已经自然结束"这件事的处理方式是同一个心智模型。

## 一句话总结

今天四条边界——独立 Session、只有结构化结果能跨界、权限不能升级、预算 fail-closed——共享同一条主线：**委派出去的子 Agent，能力和可见性都不能超过父 Agent 主动允许的范围**，而且这条范围不是靠"设计文档里写清楚了"来维持，是靠具体的类型（`StructuredResult`）、具体的校验（`isJsonValue`）、具体的判断函数（`presetRank`/`DelegationBudget.canStart`）从代码层面强制成立。这跟阶段三"信任但要验证"的主线（Day15 `expectedHash`、Day19 `ApprovalStore`、Day21 验证命令）是同一种纪律在"一个 Agent 信任另一个 Agent 的产出"这个新场景下的延伸。
