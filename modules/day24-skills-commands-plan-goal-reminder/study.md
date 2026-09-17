# 白话讲解：Skill、Command、Plan mode、Goal、Reminder

> 素材来源：DSH `docs/subsystems/skills.zh.md`、`docs/subsystems/commands.zh.md`、`docs/subsystems/plan.zh.md`、`docs/subsystems/goal.zh.md`、`docs/subsystems/schedule.zh.md`。今天是五个概念放在一天里讲，但权重完全不一样——这份文档会在讲每一个概念之前先说清楚"这个东西值多少代码量、为什么"，不假装它们同等重要。

## 0. 前置知识：这五个词到底是不是同一类东西

前四天已经建过不少"能力"：工具（Day4 `ToolDefinition`）、命令行子命令（`cli.ts` 的 `propose-edit`）、审批（Day19 `ApprovalStore`）。今天这五个概念很容易被误以为是"又发明了五种新的能力类型"——实际上它们分成两组：**真正需要新代码的**（Skill 教模型怎么做、Plan mode 控制能不能做、Goal 管什么时候算做完）和**给已经存在的东西起一个名字**（Command 只是把"人触发 vs 模型触发"这个早就隐含的区分显式化；Reminder 就是 Day6 `Agent.steer()` 套一层定时器）。分清楚这两组，比记住五个名字更重要。

## 1. 权重速览：今天的代码量为什么不平均分配

| 概念 | 值不值得真代码 | 今天写了多少 |
|---|---|---|
| Skill | 值得——"全部塞进提示词"vs"按需加载"是一个真实、可测试的设计决策 | `SkillRegistry`/`selectSkillsWithinBudget`，接入 `buildSystemPrompt`（Day11） |
| Command | 值得，但成本低——主要是命名一个早就存在的区分 | `Command`/`CommandRegistry`，包一层 Day21 `proposeEdit()` 做真实示范 |
| Plan mode | 值得，直接复用——探索期/执行期切换本质就是换挡 Day19 的 preset | `PlanModeController` |
| Goal | 值得——验收标准本身就是一类真实的 bug（"模型自称完成就当真"） | `GoalStore`，`close()` 必须过 `verify()` |
| Reminder | **刻意做薄**——大纲原话"只负责重新送达事件"就是全部设计 | `scheduleReminder()`，~20 行,不是新架构层 |

## 2. Skill：为什么"全部塞进提示词"和"按需加载"是一个真实的权衡

Day11 `buildSystemPrompt()` 组装系统提示词时，工具列表（`sections.tools`）是"全部塞进去"的——因为工具数量今天还不多，而且模型需要知道**所有**它能调用的动作，少一个都不行。Skill 不一样：一份 skill 是"教模型怎么做某件具体事情的一段文字"（比如"写 git commit message 的规范"），跟当前这一轮对话可能完全无关——如果 skill 数量将来涨到几十上百个，"全部塞进提示词"会让系统提示词的体积跟着线性增长，哪怕这一轮压根用不上大多数 skill。

```ts
interface SkillDefinition {
  readonly name: string
  readonly description: string
  readonly triggerKeywords: readonly string[]
  readonly body: string
}
```

`SkillRegistry.match(userMessageText)`（[skill-registry.ts:30-49](../../mini-harness/src/core/skill-registry.ts#L30-L49)）用 `triggerKeywords` 是否出现在用户消息里做**纯字符串包含判断**,不做语义/模糊匹配——诚实的缺口：这个项目里没有向量库,也不打算为了"更聪明地判断哪个 skill 相关"专门引入一个新依赖。`selectSkillsWithinBudget()`（[skill-registry.ts:57-66](../../mini-harness/src/core/skill-registry.ts#L57-L66)）在命中的候选里贪心挑选,直到累计字符数超过预算——这里用**字符数**而不是"token 数"当预算单位是刻意的：这个项目从 Day2 到今天都没有实现过真实的 token 估算（`TokenMeter`,Day12,记录的是 provider **事后**报告的真实用量,不是请求前的预估），伪造一个"看起来像 token 数"的函数只会制造一种虚假的精确感,字符数虽然不精确,但至少诚实。

匹配出来的 skill 怎么进到系统提示词：`SystemPromptSections` 新增了一个可选的 `skills` 字段（[system-prompt.ts:8-19](../../mini-harness/src/core/system-prompt.ts#L8-L19)），`buildSystemPrompt()` 只在这个字段非空时才渲染"# Loaded skills"这一段（[system-prompt.ts:27-43](../../mini-harness/src/core/system-prompt.ts#L27-L43)）——跟 `policies` 字段（Day11 就有）同一个"省略就不出现,不是出现了但是空的"的规则。今天**没有**把 `SkillRegistry.match()` 接进 `Agent`/`agent-loop.ts`——每天开一次 turn 时自动跑一遍匹配、自动往 `deps.systemPrompt` 里塞 `skills`,是一个真实的架构改动,跟 Day19 `PermissionPreset` 当时的决定一样:今天只交付机制本身、独立测试完,接不接进真正的调用方是另一个决定。

## 3. Command：给一个早就存在的区分起名字

`cli.ts` 的 `propose-edit` 子命令，从 Day21 写出来那天起就已经是"人在终端里敲命令直接触发,不经过模型的工具调用管线"——这跟 `ToolDefinition`（Day4，模型在一次工具调用里选中、传参、由 `ToolRegistry.execute()` 执行）是两种完全不同的触发方式,只是之前没有一个专门的类型把这个区分显式地命名出来。

```ts
interface Command<Args, Result> {
  readonly name: string
  readonly description: string
  execute(args: Args): Promise<Result>
}
```

`createProposeEditCommand()`（[command-registry.ts:37-43](../../mini-harness/src/core/command-registry.ts#L37-L43)）把已经存在的 `proposeEdit()`（Day21）包成一个 `Command<ProposeEditOptions, ProposeEditOutcome>`——`tests/command-registry.test.ts` 里"formalizing 不改变行为"那条测试直接调用包装之后的版本，断言结果跟直接调用 `proposeEdit()` 时一样,证明这次改动真的只是"起名字",不是"发明新逻辑"。

`Command` 和 `ToolDefinition` 唯一的公共祖先概念是"一个有名字、有描述、能执行的动作"——但这个共同点不足以让它们共用同一个类型：`ToolDefinition` 必须出现在 `parameters`（JSON Schema，模型要读懂）和 `ToolRegistry.execute()`（Day4 那套参数校验/超时/取消管线）里；`Command` 从来不会出现在模型能看到的任何 schema 列表里,`execute()` 的参数类型可以是任意 TypeScript 类型，不需要能被序列化成 JSON Schema。

## 4. Plan mode：换挡 Day19 的 preset，不是包一层能真的切断工具访问的 Agent

大纲说"Plan mode 把探索/设计与执行分开"。第一反应可能是"给 `Agent` 包一层,探索期真的不让它调用写工具"——但 `Agent` 的 `ToolRegistry` 在构造时就通过 `AgentDeps.tools` 固定了（`agent-handle.ts`），没有办法在一个 `Agent` 实例活着的时候动态换掉它的工具集。`PlanModeController`（[plan-mode.ts:24-52](../../mini-harness/src/core/plan-mode.ts#L24-L52)）因此不是一个真的能拦截工具调用的包装层，是一个**决策器**：

```ts
class PlanModeController {
  switchTo(mode: 'planning' | 'executing'): void
  decide(toolName: string): PermissionDecision  // 委托给当前模式对应的 Day19 PermissionPreset
  get history(): readonly ModeTransition[]       // 完整的模式切换审计记录
}
```

`decide()` 直接委托给当前模式对应的 `PermissionPreset`（Day19），不重新发明判断规则——探索期配一个 `readonly` preset（只读工具自动放行,其它一律拒绝），执行期配一个更宽松的 preset，`switchTo()` 换挡时把转换记录进 `history`（用于事后审计"这次危险操作发生时,是不是刚从 planning 切到 executing 没多久"）。跟 `PermissionPreset` 本身一样,`PlanModeController` 今天没有真正的调用方去消费它的判断结果——没有任何代码在真正执行工具调用之前去问 `decide()`。这不是遗漏,是延续 Day19 已经定下的纪律：机制先独立交付、独立测试,接不接进 `runTurn` 留到以后（比如 Day27 milestone,如果那时候用得上）。

## 5. Goal：验收标准本身就是一类真实的 bug

朴素的 agent 设计里，"任务完成了没有"经常直接信任模型自己的判断——模型说"我做完了"，系统就认为做完了。这类设计的真实故障模式是：模型说完成了，但实际上没有（幻觉、偷懒、误判）,而系统没有任何机制能拦住这种情况。

```ts
type GoalStatus = 'open' | 'pending-verification' | 'closed'
```

`GoalStore`（[goal.ts:44](../../mini-harness/src/core/goal.ts#L44)）故意把"模型能触达的状态"和"真正关闭"分开：`markPendingVerification()` 是模型的工具调用唯一能碰到的方法，它只能把状态从 `open` 推到 `pending-verification`——不能更进一步。真正的 `close()`（[goal.ts:76-83](../../mini-harness/src/core/goal.ts#L76-L83)）内部会调用创建这个 goal 时注册的、跟模型输出完全独立的 `verify()` 函数（可以是"跑一遍测试""检查某个文件是否存在"），`verify()` 返回 `false` 直接抛 `GoalVerificationFailedError`，状态停在 `pending-verification`，不会被静默关闭。

真值表说清楚 `close()` 在各种状态组合下的反应：

| 当前状态 | `verify()` 结果 | `close()` 的反应 |
|---|---|---|
| `open` | （不会走到这一步） | 抛 `GoalNotPendingError`——必须先 `markPendingVerification()` |
| `pending-verification` | `true` | 状态变成 `closed` |
| `pending-verification` | `false` | 抛 `GoalVerificationFailedError`，状态保持 `pending-verification`，可以再次尝试 |
| `closed` | （不会再调用 `verify()`） | no-op，幂等返回 |

这是"信任但要验证"这条贯穿课程的主线（Day15 `expectedHash`、Day19 `ApprovalStore`、Day21 `propose-edit` 的验证命令）在"目标管理"这个新场景下的又一次具体落地：模型的输出永远只是一个**提议**，不是一个**事实**。

## 6. Reminder：~20 行,不是新架构层

大纲原话"Reminder 只负责重新送达事件"——这句话字面意思就是全部设计。`scheduleReminder()`（[reminder.ts:17-22](../../mini-harness/src/core/reminder.ts#L17-L22)）就是 Day6 `Agent.steer()` 套一层 `setTimeout`：

```ts
function scheduleReminder(agent: Agent, message: Message, delayMs: number): Reminder {
  const timer = setTimeout(() => agent.steer(message), delayMs)
  return { dispose: () => clearTimeout(timer) }
}
```

`steer()` 已经处理了"这条消息什么时候真正生效"的全部语义（Day6：追上正在跑的活动，在下一个 step 边界被采纳；如果当前没有 turn 在跑，留到下一次 `send()` 的第一个 step）——`Reminder` 不需要、也不应该重新实现这套逻辑，它唯一新增的行为是"定时"。刻意不把它做成一个有自己状态机、自己生命周期概念的子系统——那会是过度设计，`setTimeout`/`clearTimeout` 已经完整覆盖了"定时提醒"需要的全部能力。

## 7. 一张判断表：某能力该是 prompt/skill/tool/command/workflow 还是普通代码

这是 README 验收标准点名要能回答的问题，用今天和之前实际建出来的真类型作答（`workflow` 到 Day27 才会有真代码，这里先占个位——回头 Day27 写完之后应该回来补一条真实的例子）：

| 问自己 | 是 → | 举例（本项目里真实存在的类型/代码） |
|---|---|---|
| 这段内容每一轮都必须让模型看到、不受篇幅预算限制、不需要判断"这轮用不用得上"？ | 直接写进 Prompt（不经过匹配/预算这道门） | `SystemPromptSections.tools`（Day11，工具列表必须全量展示，少一个都不行，见第2节） |
| 这段内容只是"告诉模型怎么做某件事"，模型自己决定要不要用？ | Skill | `SkillDefinition.body`（第2节） |
| 这个动作必须经过参数校验、超时、取消这套统一管线，模型要能在一次工具调用里选中它？ | Tool | `ToolDefinition`（Day4 `ToolRegistry`） |
| 这个动作只由人（或人写的脚本）直接触发，模型永远看不到它？ | Command | `Command`（第3节，`createProposeEditCommand()`） |
| 这件事的"对不对"必须由一个跟模型输出无关的外部检查决定，不能信任模型自己的宣称？ | 给它接一个 `Goal` | `GoalStore.close()` 的 `verify()`（第5节） |
| 这是一段确定性的、不需要模型参与决策的胶水逻辑（比如"发一个 HTTP 请求、解析响应"）？ | 普通代码 | `src/client/http-stream-connector.ts`（Day23）——没有任何一步需要模型决策 |
| 需要好几个步骤按固定的编排方式组合（比如"并行跑几个子任务、再汇总"），但每个步骤本身可能还是要模型决策？ | Workflow（Day27 才有真代码） | （占位，回头补） |

## 一句话总结

今天真正共享的一条主线不是这五个概念本身,是"给已经建立的能力找准确的边界"——Skill 和 Tool 的边界是"模型要不要能调用它"；Command 和 Tool 的边界是"谁触发它"；Plan mode 复用而不是重新发明 Day19 的判断逻辑；Goal 的边界是"谁有权关闭它"；Reminder 的边界是"它到底有没有资格算一个新架构层"（答案是没有）。分清楚边界，比给每个概念都堆代码更重要——这也是为什么 Reminder 只有 20 行，Skill 却接了一整条从匹配到预算到系统提示词渲染的链路。
