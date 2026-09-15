# Day 24 答案

> 对照 [README.md](./README.md)「今天要学会什么」、[exercise.md](./exercise.md)「验收自查」和其中的思考题逐条作答。

## 今天要学会什么

**1. 为什么 Skill 按需加载，不是全部塞进提示词**

Day11 的工具列表全部塞进提示词，是因为模型需要知道全部它能调用的动作，少一个都不行,而且工具数量今天还不多。Skill 是"教模型怎么做某件具体事情"的文字,可能跟当前对话完全无关,如果数量涨到几十上百个,全部塞进去会让系统提示词体积跟着线性增长。`SkillRegistry.match()` 靠触发关键词做纯字符串匹配,只加载真的相关的那一部分。

**2. `Command` 和 `ToolDefinition` 的核心区别**

不是"能做什么",是"谁触发它"——`ToolDefinition` 经过 `ToolRegistry.execute()`,是模型在一次工具调用里选中并传参调用的；`Command` 从来不出现在模型能看到的工具 schema 列表里,是人（或人写的脚本）直接调用的。`cli.ts` 的 `propose-edit` 子命令从 Day21 起就已经是这种性质,`createProposeEditCommand()` 只是把这个早就存在的事实用类型显式表达出来——`tests/command-registry.test.ts` 里的测试直接证明了包装前后行为完全一致。

**3. 为什么 `PlanModeController` 不是真的能切断工具访问的包装层**

`Agent` 的 `ToolRegistry` 在构造时通过 `AgentDeps.tools` 固定，没有办法在一个 `Agent` 实例活着的时候动态换掉。`PlanModeController` 因此是一个决策器（`decide(toolName)`），不是一个真的拦截层——委托给当前模式对应的 Day19 `PermissionPreset` 做判断，今天也没有真正的调用方在执行工具调用之前去问它，延续 Day19 已经定下的"机制先独立交付,接不接进 `runTurn` 留到以后"的纪律。

**4. `Goal.close()` 的四种状态组合**

见 study.md 第5节的真值表：`open` 直接调用 `close()` 会被拒绝（必须先 `markPendingVerification()`）；`pending-verification` 且 `verify()` 为 `true` 会真正关闭；`pending-verification` 且 `verify()` 为 `false` 会抛错、状态不变，允许之后重试；`closed` 再调用是幂等 no-op。

**5. 为什么 `Reminder` 只值 20 行**

大纲原话"只负责重新送达事件"就是全部设计——`Agent.steer()`（Day6）已经处理了"这条消息什么时候真正生效"的全部语义,`Reminder` 唯一新增的行为是"定时",`setTimeout`/`clearTimeout` 已经完整覆盖这个需求,没有必要为了凑"五个概念都要有子系统"而人为堆砌代码。

**6. 判断表**：见 study.md 第7节。

## 验收自查

**为什么用字符数不用 token 数**：这个项目从 Day2 到今天都没有实现过真实的 token 估算函数——`TokenMeter`（Day12）记录的是 provider **事后**报告的真实用量（`assistant/message.usage`），不是请求前对一段文本的预估。伪造一个"看起来像 token 数"的估算函数会制造虚假的精确感,字符数虽然跟真实 token 数不是线性对应关系（不同语言、不同 tokenizer 差异很大），但至少诚实地承认自己只是一个粗略的容量代理指标。

**`close()` 四种状态组合**：见上面第4条和 study.md 第5节的真值表。

**去掉 `markPendingVerification()` 检查的真实后果**：亲手验证过（exercise.md 任务1）——去掉检查之后,一个已经 `closed` 的 goal 可以被重新标记成 `pending-verification`,`tests/goal.test.ts` 里"on an already-closed goal throws"那条测试从"抛 `GoalNotPendingError`"变成"不抛错、静默成功"。光是这一步改动本身不会立刻产生数据错误——`close()` 依然要求状态是 `pending-verification` 且 `verify()` 返回 `true` 才会真正关闭,所以理论上"重新标记"之后还需要 `verify()` 再通过一次。真正有害的场景是任务1第二问点出的那种：如果 `verify()` 检查的外部条件本身有缺陷（比如检查的是一个从未被正确清理的缓存标记、或者一个宽松到总是返回 `true` 的桩实现），"允许重新标记一个已关闭的 goal"就打开了一条"反复关闭同一个 goal、每次都触发一遍下游逻辑（比如一次关闭会触发一次通知/一次审计记录）"的路径——`Goal` 的设计初衷是"一件事只有一次真正的、被验证过的完成时刻"，允许重新标记已关闭的 goal 就破坏了"关闭"这个状态该有的终态语义,哪怕当下没有立刻炸,也在悄悄放宽一条本该锁死的边界。
