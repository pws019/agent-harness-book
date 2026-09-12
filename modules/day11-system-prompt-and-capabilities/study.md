# 白话讲解：系统提示词与能力组装

> 素材来源：DSH `docs/subsystems/system-prompt.zh.md`、`docs/capability-services.zh.md`。今天的核心不是"怎么写好一段 prompt"（那是提示词工程的话题），是"prompt 该怎么被组装、什么时候必须重新组装"这个架构问题。

## 0. 前置知识：什么是"系统提示词"，以及为什么"缓存"在这里是个陷阱

**先补上一个从 Day3 就一直没解释过的概念**。回忆 `GenerateOptions` 那个类型（[day03 study.md §1](../day03-adapter-boundary/study.md)）：

```ts
interface GenerateOptions {
  readonly provider: string
  readonly model: string
  readonly messages: readonly Message[]
  readonly system?: string   // 这个字段从 Day3 就在了，但 Day3 从没解释过它，我们也一直没真正填过它
  // ...
}
```

`system` 这个字段从 Day3 写下 `GenerateOptions` 那一刻起就存在，但一直是 `undefined`——**今天 Day11 要做的事，就是第一次真正产出该塞进这个字段的内容**。

**"系统提示词"（system prompt）到底是什么**：一次对话里，`messages` 数组装的是用户和模型互相能看见的"台词"——你问一句、它答一句，这些都会展示在聊天界面上。`system` 是一段**独立于这个对话之外的指令**，跟着每次请求一起发给模型，但**不会出现在聊天界面里，用户看不到**——内容通常是"你是什么角色""有哪些工具能用""要遵守什么规则"这类背景设定。类比一下：如果 `messages` 是"客服和顾客的对话记录"，`system` 就是"客服上岗前拿到的那本培训手册"——手册不会读给顾客听，但客服说的每一句话都受手册约束。这也是为什么 Day3 定义 `GenerateOptions` 的时候，`system` 要单独作为一个字段，而不是塞进 `messages` 数组里假装是一条消息——两者的可见性和语义完全不同。

**为什么"缓存"在这里是个陷阱**：前端你大概率因为性能原因缓存过计算结果——"这个列表没变就别重新算了"。今天要打破一个直觉：**系统提示词看起来是"配置"，很容易被当成"算一次、存起来、以后都用这份"的东西，但这恰恰是这个模块最容易踩的坑**。原因很简单：prompt 里有一段要如实反映"模型现在还能用哪些工具"，如果这份信息被缓存了，工具被移除之后 prompt 却还在说"你可以用 XX 工具"，模型会尝试调用一个已经不存在的能力——这不是"性能优化的副作用"，是一个真实的正确性 bug。

## 1. `buildSystemPrompt`：一个刻意不持有状态的纯函数

```ts
export interface SystemPromptSections {
  readonly identity: string
  readonly workspaceRoot: string
  readonly tools: readonly ToolSchema[]
  readonly taskContext?: string
}

export function buildSystemPrompt(sections: SystemPromptSections): string
```

四个固定分段：身份、工作区、可用工具列表、任务上下文（可选）。**它不是 `Agent` 的方法，也不是某个类的实例状态**——就是一个"给什么就拼什么"的纯函数。这个设计决定直接对应上面那条前置知识：**没有状态可缓存，就没有"忘记让缓存失效"这类 bug 的容身之处**。

## 2. `tools` 从哪来：每次都要现取

`Agent` 用它的地方：

```ts
if (this.deps.systemPrompt) {
  const prompt = buildSystemPrompt({ ...this.deps.systemPrompt, tools: this.deps.tools.schemas() })
  this.appendEvent('system/message', { turn, message: prompt })
}
```

`this.deps.tools.schemas()` 每次都是**现查**（回忆 Day4：`ToolRegistry.schemas()` 直接从内部 `Map` 现取，不缓存），不是 `AgentDeps.systemPrompt` 配置里预先塞好的一份工具列表——这也是为什么 `AgentDeps.systemPrompt` 的类型是 `Omit<SystemPromptSections, 'tools'>`：**从类型层面直接排除"调用方自己传一份工具列表"这个可能性**，`tools` 永远只能来自 `deps.tools.schemas()` 这一个源头。这是"用设计定义掉特殊情况"的又一次应用——不是靠"记得每次都重新取"这种自觉,是从类型上让"传一份过期的工具列表"这件事根本写不出来。

## 3. 验证这条不变式：真值表 + 两轮对比

新增了 `ToolRegistry.undefine(name)`（Day4 的 `ToolRegistry` 一直只能加、不能撤销）,让"工具被移除"这件事第一次能被真实测试出来,而不是靠想象：

```ts
const before = buildSystemPrompt({ ...sections, tools: registry.schemas() })  // 含 list_files
registry.undefine('list_files')
const after = buildSystemPrompt({ ...sections, tools: registry.schemas() })   // 不含 list_files
```

| 场景 | `registry.schemas()` 有没有 `list_files` | `buildSystemPrompt` 的结果 |
|---|---|---|
| 移除之前 | 有 | 提示词包含 `list_files` |
| 移除之后 | 没有 | 提示词不包含 `list_files`，其余工具原样保留 |

集成测试（`session-integration.test.ts`）把这条规律搬到真实的两轮对话上：第一轮 `send()` 时工具还在，`system/message` 事件里能看到 `list_files`；`undefine()` 之后第二轮 `send()`，新的 `system/message` 事件里就没有了——**两条事件都是同一个 `Agent` 实例产出的，同一个 `Session`，唯一变量是中间调用了一次 `undefine()`**，这是证明"确实是现取，不是缓存"最直接的方式。

## 4. `system/message`：只留痕，不进历史

```ts
'system/message': { readonly turn: number; readonly message: string }
```

这条新事件类型加进了 `SessionEventPayloadMap`（Day8 的"声明合并扩展"第一次真正用上），但 `deriveMessages()` 里对它的处理是 `case 'system/message': break`——**跳过，不产出任何 `Message`**。为什么？因为我们的 `GenerateOptions` 本来就把 `system` 当一个独立字段传给 provider（不是 `messages` 数组里的一条），`Message.role` 的类型定义里压根没有 `'system'` 这个值（`Role = 'user' | 'assistant' | 'tool'`）。所以 `system/message` 事件的定位跟 `tool/call` 一样：**纯粹的审计记录**——"这次 turn 用的是哪一版 prompt"，不是历史消息本身的一部分。

**这还没回答另一个问题：为什么留痕的是 `message: string`（渲染后的字符串），而不是 `SystemPromptSections`（原始分段：`identity`/`workspaceRoot`/`tools`/`taskContext`）？** 直觉上存原始分段信息量更大，还能拿去跟下一次的分段做 diff。但审计记录的职责是"如实记下**已经发生的事实**"——`buildSystemPrompt()` 今天是纯函数、同样的分段今天调用结果固定，但**这不保证以后也一样**：如果哪天这个函数的实现改了（调整了某个分段的格式、加了新分段），拿旧的原始分段去跑**新版**的 `buildSystemPrompt()`，会算出一个**当初根本没有真正发给过模型**的字符串。如果审计记录存的是原始分段，"重放历史"这个操作的结果会随代码演进而漂移，审计记录也就不再可信。存渲染后的字符串,是把"模型这一步实际看到的文本"这个既成事实原样冻结下来——事实不会因为以后改代码而改变，"如何重建这份事实的配方"会。这跟 Day1/Day2 反复出现的"会话日志是唯一真源，模型可见即已记录"是同一条原则：日志要记的是发生过的事实，不是可以重新计算、因而可能跟历史事实脱钩的中间数据。

## 一句话总结

今天没有引入新的循环机制或者取消语义,是一个更朴素但同样重要的教训：**"配置"和"缓存"看起来很像,但只要这份配置里包含了任何会随时间变化的东西（这里是"当前还有哪些工具"）,就绝不能被缓存,只能每次现取**。`buildSystemPrompt` 保持无状态、`tools` 字段被类型系统禁止外部传入,两个设计决定加在一起,让"prompt 说了模型做不到的事"这种 bug 从设计上就不可能发生。
