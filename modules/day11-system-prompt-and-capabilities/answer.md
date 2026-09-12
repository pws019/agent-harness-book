# Day 11 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. 为什么系统提示词（尤其是"当前可用工具"这段）绝对不能被缓存**

系统提示词看起来是"配置"，容易被当成"算一次、存起来、以后都用这份"的东西——但 prompt 里"模型现在还能用哪些工具"这段必须如实反映当下，如果被缓存了，工具被移除之后 prompt 却还说"你可以用 XX 工具"，模型会尝试调用一个已经不存在的能力——这是真实的正确性 bug，不是性能优化的副作用。`buildSystemPrompt` 是个刻意不持有状态的纯函数，`tools` 每次都从 `this.deps.tools.schemas()` 现取，测试用 `registry.undefine()`/`registry.define()` 真实验证过"移除后不再包含、重新注册后重新包含"。

**2. `system/message` 为什么是纯审计记录，不参与 `deriveMessages()`**

`GenerateOptions` 本来就把 `system` 当独立字段传给 provider（不是 `messages` 数组里的一条），`Message.role` 的类型定义里压根没有 `'system'` 这个值（`Role = 'user' | 'assistant' | 'tool'`）。所以 `deriveMessages()` 对它的处理是 `case 'system/message': break`——跳过，不产出任何 `Message`。它的定位跟 `tool/call` 一样：纯粹的审计记录（"这次 turn 用的是哪一版 prompt"），不是历史消息本身的一部分。

**3. 用类型系统直接排除一种错误用法**

`AgentDeps.systemPrompt: Omit<SystemPromptSections, 'tools'>`——这个类型里根本没有 `tools` 这个 key，调用方想在创建 `Agent` 时自己传一份工具列表，代码写出来就编译不过（"Object literal may only specify known properties"）。如果没有这个 `Omit`，调用方理论上可以传一份工具快照，之后工具被移除/新增，这份快照不会跟着变——这条规则从"请不要这样传"的社会约定，变成编译器强制执行、连写都写不出来的保证,是 Day6"显式建模"原则用 TypeScript 类型系统而不是运行时判断实现的又一个例子。

## 验收自查

**为什么 `system/message` 存的是渲染后的字符串，而不是原始分段对象**：不是"反正只是审计用的所以无所谓"——恰恰相反，正因为它要审计的是历史事实，才必须存这份事实本身。`buildSystemPrompt()` 今天是纯函数，同样的分段今天调用结果固定，但这不保证以后也一样——如果哪天这个函数的实现改了（调整了某个分段的格式、加了新分段），拿旧的原始分段去跑新版的 `buildSystemPrompt()`，会算出一个当初根本没有真正发给过模型的字符串。存渲染后的字符串，是把"模型这一步实际看到的文本"这个既成事实原样冻结下来——事实不会因为以后改代码而改变，"如何重建这份事实的配方"会。这是 Day1/Day2"会话日志是唯一真源，模型可见即已记录"这条原则的又一次应用：日志要记发生过的事实，不是可以重新计算、因而可能跟历史事实脱钩的中间数据。
