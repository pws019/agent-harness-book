# Day 20 答案

> 对照 [README.md](./README.md)「今天要学会什么」、[exercise.md](./exercise.md)「验收自查」和其中的思考题逐条作答。

## 今天要学会什么

**1. `CredentialRef` 为什么只能存不透明引用，什么时候真正解析**

如果参数里直接允许模型传真实密钥字符串，这个字符串会流经好几个不是为了保管密钥而设计的地方：工具调用的 `args`（可能被写进 Session 日志）、`ToolExecutionError` 的 message（失败时可能把参数原样带出来）、如果支持流式回显甚至可能被模型自己在下一轮上下文里看到。`CredentialRef` 把"引用"和"真实值"分开——模型、日志、错误信息里流动的永远只是 `{ id: string }` 这个指针；真实值只在 `CredentialStore.resolve(ref)` 被调用的那一刻才计算出来，而这一刻被放在 `run_command` 真正要 spawn 子进程之前的最后一步（`src/tools/bash-tool.ts:133-137`），如果更早的策略检查/路径校验就 `throw` 了，真实值根本不会被算出来。

**2. `mergeSettings()` 为什么要给每个值保留"来源"**

如果只关心最终值，`Object.assign` 就够了；但配置分层实践中经常需要回答"这个值到底是哪一层给的"（调试、审计、给用户展示"你的哪一层配置在生效"）。纯值合并的结果丢失了这个信息，`mergeSettings` 因此返回 `Record<string, { value, source }>`，每次覆盖同时更新 `source`（`src/core/settings.ts` 的实现）。

**3. Workspace 为什么该是身份边界，今天为什么没有全面重构**

单纯的 `root: string` 只回答"文件系统边界在哪"；一个真实工作区还需要回答"这个工作区能用哪些凭据""它的配置是什么"。`WorkspaceContext` 把 `root` + `credentials` + `envCredentials` 装进一个类型解决了"应该长什么样"这个问题。但把这个类型强行穿进 Day4/15/16 已有的每个 `createXTool(root: string)` 签名，是一次纯机械的重构——每处改动都是"以前用 `root`，现在用 `workspace.root`"，不会教会任何新概念，只是改动面覆盖好几个文件。今天选择只在 `run_command` 上做一次有信息量的示范；其余工具要不要跟进是一个成本明确、留给真正需要时再做的选择，不是漏做。

**4. `run_command` 接入 `envCredentials` 之后模型能做什么、不能做什么**

模型仍然可以在 `args.env` 里传任意变量——但如果 workspace 配置了同名的 `envCredentials`，模型传的值会被覆盖掉（`src/tools/bash-tool.ts:124-137`，`envCredentials` 的注入代码故意写在 `args.env` 展开之后）。这意味着模型**不能**通过传一个同名的 `env` 字段去顶替/覆盖 workspace 预先配置好的凭据；模型也**看不到**真实密钥的值——它只能通过运行命令、让命令自己使用这个环境变量，间接观察到效果（比如命令用这个 key 去调用外部 API 成功了），但密钥字符串本身从来没有出现在模型能看到的任何返回值里，除非命令自己把它打印出来（这是命令本身的责任，不是 `run_command` 的责任）。

## 验收自查

**如果 `run_command` 直接允许传真实密钥值，哪里可能意外泄漏**：工具调用的 `args`（如果被序列化进 Session 事件，见 Day9 `SessionEvent`）；`ToolExecutionError` 的 message（比如策略拒绝、路径校验失败时，如果错误信息里回显了完整参数）；如果这层 Agent 支持流式展示"模型正在调用的工具及参数"给用户看的 UI，也会原样展示出来。`CredentialRef` 把这些地方流动的东西换成一个不含真实值的 `id`，从根本上让这些地方不再是潜在泄漏点，而不是逐个加脱敏逻辑。

**为什么"没设置"和"设置成 falsy 值"必须区分开**：亲手验证过（[study.md](./study.md) 第2节的真值表 + `tests/settings.test.ts:30-39`）——如果错误地把"这层有没有值"简化成"`if (layer.values[key])`"这种真值判断，`retries: 0`、`debug: false` 这种合法的显式配置会被误判成"这层没配置"而被跳过，导致用户明明配置了 `debug: false` 却因为跟"没配置"混淆，最终生效的还是更上层的 `true`。`mergeSettings` 靠 `Object.entries()` 只遍历真正存在的 key 这个天然语义避免了这个坑，没有专门写额外的判断逻辑。

**为什么模型传的 `env.OPENAI_API_KEY` 不能覆盖 workspace 配置的同名变量**：这是"调用方的输入不能扩大自己的权限"这条原则的延伸——跟 Day16 环境变量白名单（`env` 参数本身就是显式声明，不继承宿主进程）是同一类考虑，只是这次的"调用方"从"宿主进程环境"换成了"模型自己在工具调用参数里传的东西"。如果模型（无论是正常生成了错误参数，还是被 prompt injection 操纵）能用同名变量顶替掉 workspace 管理者预先配置好、本该注入的真实凭据，这个能力就等于让模型可以任意伪造它要访问的外部服务身份——把 `envCredentials` 的注入代码放在 `args.env` 展开之后，让合并顺序本身就保证了这一点，不需要额外写"检测并拒绝模型传同名变量"的逻辑。

**任务1：合并顺序颠倒之后会怎样**：亲手验证过（用隔离脚本复刻了同样的合并逻辑，逻辑与 `src/tools/bash-tool.ts` 完全一致）——把 `envCredentials` 的注入挪到 `args.env` 展开之前，`tests/workspace-context-integration.test.ts` 里"the model cannot override a workspace-configured credential..."这条测试会失败：`result.content` 变成 `model-supplied-fake-value`，而不是预期的 `sk-real-secret-value`。原因很直接——`Object.assign(env, args.env ?? {})` 是最后一步写入的，天然覆盖掉之前 `envCredentials` 写进去的值。另外两条测试不受影响：第一条（"a credential configured on the workspace shows up..."）根本没有传冲突的 `args.env.OPENAI_API_KEY`，谁先写谁后写结果一样；第三条（"with no workspace configured..."）压根没有 `workspace` 参数，`envCredentials` 那整段代码都不会执行，合并顺序变不变都无所谓。

**任务2：`EnvCredentialStore`**：实现思路——`resolve(ref)` 里用 `process.env[ref.id]` 读值（约定 `CredentialRef.id` 直接就是环境变量名，这样最简单直接，不需要额外一层名字映射表；如果担心 `id` 里包含不适合当环境变量名的字符，可以在构造时校验一次），读到 `undefined` 时跟 `InMemoryCredentialStore` 一样抛 `CredentialNotFoundError(ref.id)`，保持两个实现对同一个 `CredentialStore` 接口的行为完全一致——调用方（比如 `run_command`）不需要关心背后到底是哪种实现，这正是"接口稳定、实现可替换"这条原则的一次具体演练。测试用 `vi.stubEnv()`（Vitest 内置，会在测试结束自动还原）而不是直接改写 `process.env`，避免污染其他并行跑的测试用例。

**任务3：显式恢复成上一层的值该怎么设计**：直接把用户层设成 `undefined` **不能**达到"恢复成上一层默认值"的效果——按 study.md 第2节真值表最后一行，`Object.entries()` 照样会把这个 key 列出来（JS 对象里"属性存在但值是 `undefined`"和"属性完全不存在"是两种不同状态,前者会被 `Object.entries` 枚举出来）,所以 `mergeSettings` 会把 `result[key]` 覆盖成 `{ value: undefined, source: 'user' }`，而不是"跳过这一层、保留上一层的值"——这跟目标行为正好相反。真正要支持这种语义，需要一个专门的、跟任何合法配置值都不会混淆的哨兵标记，比如一个具名的 symbol 或者一个带 `__inherit__: true` 这种判别字段的对象（不能用 `null`——`null` 在很多配置场景里本身就是一个合法的业务值，比如"显式关闭某个可选功能"，用 `null` 当哨兵会制造新的"哪个 null 是哪个意思"的歧义）。`mergeSettings` 遇到这个哨兵时的行为要专门处理：不是"用这一层的值覆盖"，而是"跳过这一层对这个 key 的写入，让更早一层的 `{value, source}` 继续生效"——这跟 Day19 把三种交互类型显式区分成一个封闭联合类型是同一个思路：用一个专门的、类型层面就能区分的标记去表达"这是一种特殊语义"，而不是复用一个容易被误认成普通合法值的写法。
