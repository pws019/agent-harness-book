# 白话讲解：系统提示词与能力组装

> 素材来源：DSH `docs/subsystems/system-prompt.zh.md`、`docs/capability-services.zh.md`。今天的核心不是"怎么写好一段 prompt"（那是提示词工程的话题），是"prompt 该怎么被组装、什么时候必须重新组装"这个架构问题。

## 0. 前置知识：为什么"缓存"在这里是个陷阱

前端你大概率因为性能原因缓存过计算结果——"这个列表没变就别重新算了"。今天要打破一个直觉：**系统提示词看起来是"配置"，很容易被当成"算一次、存起来、以后都用这份"的东西，但这恰恰是这个模块最容易踩的坑**。原因很简单：prompt 里有一段要如实反映"模型现在还能用哪些工具"，如果这份信息被缓存了，工具被移除之后 prompt 却还在说"你可以用 XX 工具"，模型会尝试调用一个已经不存在的能力——这不是"性能优化的副作用"，是一个真实的正确性 bug。

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

## 一句话总结

今天没有引入新的循环机制或者取消语义,是一个更朴素但同样重要的教训：**"配置"和"缓存"看起来很像,但只要这份配置里包含了任何会随时间变化的东西（这里是"当前还有哪些工具"）,就绝不能被缓存,只能每次现取**。`buildSystemPrompt` 保持无状态、`tools` 字段被类型系统禁止外部传入,两个设计决定加在一起,让"prompt 说了模型做不到的事"这种 bug 从设计上就不可能发生。
