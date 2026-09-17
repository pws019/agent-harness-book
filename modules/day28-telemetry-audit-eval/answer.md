# Day 28 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md) 里的思考题逐条作答。

## 今天要学会什么

**1. 为什么 `deriveTelemetry()` 是纯投影函数，不加钩子**

`Agent` 从 Day8 起，每一次工具调用、每一次模型调用都已经真实记了一条带 `time` 字段的 `SessionEvent`——这些时间戳早就存在，只是从来没有被"配对、算差值"过。往 `ToolRegistry.execute()`/`LlmAdapter.stream()` 里插钩子,要么改动已经稳定十几个后续天数都在依赖的核心文件,要么在每个调用方重复同一段逻辑；而"从已有真源派生一份新视图"跟 Day10 `projectSummary()`/`deriveMessages()` 是同一个模式,零侵入,`deriveTelemetry()` 甚至不需要知道 `Agent`/`ToolRegistry` 这两个类的存在,只认 `SessionEvent[]` 这一种输入。

**2. 延迟怎么算**：`step/start` 记时间戳,遇到同一个 `turn:step` 的 `assistant/message` 时相减,得到模型调用延迟（`telemetry.ts:76-78`）；`tool/call` 按 `callId` 记时间戳,遇到同一个 `callId` 的 `tool/result` 时相减,得到工具调用延迟（`telemetry.ts:90-93`）。两组配对逻辑各自独立，互不干扰。

**3. 为什么 `estimatedCostUsd` 必须能是 `'unknown'`**：直接复用 Day12 `TokenMeter` 的"未上报用量永久变成 unknown,不当 0"纪律——`deriveTelemetry()` 把每一条 `assistant/message.usage` 无条件喂给内部的 `TokenMeter`，只要有一次没上报，`totals.inputTokens`/`outputTokens` 就变成 `'unknown'`,`estimatedCostUsd` 的计算条件（`typeof totals.inputTokens === 'number'`）自然也就过不了,只能是 `'unknown'`——不会用"已经累计到的部分数字"冒充"这就是总成本"。

**4. 为什么包一层而不是改 `approval.ts`**：`approval.ts` 已经被 Day21 `propose-edit.ts` 依赖，它自己的状态机（`consumed`/`revoked`/`expired`）已经完整测过、完整讲过——往里面加一个跟"审批本身该不该通过"完全无关的"审计"能力，属于往一个已经稳定的深模块里塞进一个不相关的职责，会让 `approval.ts` 同时要回答"这次批准该不该生效"和"谁在什么时候做了这件事"两个不同的问题。写一个新类包一层，`approval.ts` 一行不改，`propose-edit.ts` 现有调用方式完全不受影响，要不要接审计只是调用点选 `ApprovalStore` 还是 `AuditingApprovalStore` 的问题。

**5. 为什么 `principal` 不是验证过的身份**：这个项目至今没有真实的用户认证/授权系统——Day22 `http-server.ts` 的 bearer token 只回答"有没有钥匙"，不回答"持有者是谁"；`AuditingApprovalStore` 的 `principal` 只回答"调用方自称是谁"，同样没有验证机制。两者是同一类诚实缺口：把"完全没有记录是谁做的"往前推进了一步（至少调用方老实传的话，记录是可信的），但没有推到"密码学级别可验证"那一步。

**6. 为什么 `redact.ts` 只需要管 `tool/result.content`**：Day20 `CredentialRef`/`WorkspaceContext.envCredentials` 的设计就是"真实密钥值只活在 `CredentialStore` 内部和真正解析注入子进程 env 的那一刻（`bash-tool.ts:135`），中间全程只传递不透明引用"——`SessionEvent` 的其余字段（`tool/call.arguments`、`user/message` 等）结构上根本装不进真实密钥值。唯一的例外是 `tool/result.content`——它装的是子进程真实输出了什么，这段自由文本完全不受 `CredentialRef` 的约束，一个被诱导执行"打印环境变量"的命令可以把真实密钥值原样打到 stdout，这条路径不受任何结构性保证约束，只能靠 `redactor` 这道运行时防线补上。

**7. `Scenario` vs `sampleScenario()`**：前者形式化的是"这次调查的结果对不对"这个已经通过手写 `expect(...)` 在验证的问题（`tests/session-milestone.test.ts` 从 Day14 起就在做），只是把断言从散落的代码升级成声明式的 `ScenarioAssertion` 列表。后者要回答的是"同一个任务，模型表现稳不稳定"——这需要一个有真实变动性的 provider 才有意义，这门课至今只有 `HeuristicInvestigationAdapter` 这一种完全确定性的 adapter，用它跑抽样只会得到 100% 或 0%。`createFlakySampleAdapter()` 是专门为了证明"跑 N 次、聚合通过率"这条计算路径本身正确而造的合成 adapter，不代表接入了真实的非确定性 provider——`study.md` §5.2 诚实记录了这一点。

## 任务 1：为什么"只在真值时调用"会让 unknown 变成 0

`meter`（`TokenMeter` 实例）的初始状态是 `{inputTokens: 0, outputTokens: 0, ...}`——全是数字 0，不是 `'unknown'`。`TokenMeter.record(usage)` 只有在**真的被调用、且参数是 `undefined`**时才会把内部状态推成 `'unknown'`；如果调用方在 `usage` 为假值时干脆不调用 `record()`，那么"这次调用没上报用量"这个事实就从来没有被告诉过 `meter`——`meter` 只会看到"从来没有关于这次调用的任何信息传进来"，它的状态不会因为"没被调用"而改变，永远停留在初始的 `0`。"没上报"和"报了 0"因此在这段代码里变成了完全无法区分的同一件事——这正是 Day12 `TokenMeter` 那条注释反复强调"未报告的 usage 记成 unknown，不是 0"想要防住的错误，只是这次是在**调用方这一层**不小心把它重新引入了（`TokenMeter` 自己的实现没有问题，问题出在"要不要调用它"这个决定上）。

## 任务 2：`history()` 的设计取舍

**要不要给历史列表设上限**：会。`AuditingApprovalStore` 只要长期运行、不断有审批被创建/消费，内部 `history` 数组会无限增长，这正是 Day22 `IdempotencyStore` 已经记录过的同一类诚实缺口（`modules/day22-http-server-and-streaming/study.md` §4）——补 `history()` 之前不特意提醒的话，会不知不觉重新犯一次同样的错误。合理的做法是复用同一份诊断里已经给出的两个方向之一（按时间淘汰或按数量上限淘汰），今天不强求实现，但至少要在设计里显式承认这个上限的存在，不能悄悄留一个新的无界增长点。

**`sink` 抛错要不要影响内部历史**：不应该。这正是根 `README.md` 不变式清单第16条"telemetry sink 故障不能破坏主任务"的具体体现——`record()` 应该先把记录追加进内部 `history`（这一步不会失败），再尝试通知外部 `sink`，并且要把 `sink.record()` 包进 `try/catch`：`sink` 抛错只应该影响"外部系统有没有及时收到这条通知"，不应该让 `create()`/`consume()`/`revoke()` 本身抛出去、打断调用方真正在做的审批流程——审计/遥测系统本身出故障，不能变成拖垮主任务的理由，这条原则跟"数据库写失败不能让整个请求 500"是同一个心智模型。

## 任务 3：精确匹配脱敏 vs 模糊匹配脱敏

`createRedactor()` 的精确匹配策略在"敏感值本身足够独特"（比如一个足够长的随机 API key）时工作得很好——不会有任何误伤，因为这个具体字符串几乎不可能在无关文本里偶然出现。但如果敏感值很短、很常见（`'123'`、一个常见单词、甚至一个短用户名），精确匹配会把文本里所有恰好包含这个子串的无关内容也一起替换掉——比如密钥恰好是 `'123'`，那么任何提到"共 123 个文件"的正常输出都会被误伤成"共 [REDACTED] 个文件"，脱敏本身反而破坏了日志的可读性和准确性。

正则式的模糊匹配（"看起来像不像一串随机字符/像不像一个已知格式的 key，比如 `sk-` 开头）"换了一种风险：它不需要调用方提前知道具体的敏感值是什么，能抓住"没在已知列表里、但长得像密钥"的东西，但代价是既可能漏掉不符合已知格式的真实密钥，也可能把恰好长得像密钥的正常内容（一段 base64 编码的非敏感数据）误判成敏感信息。

两种思路不是二选一，而是分别覆盖了不同的场景，适合叠加使用：精确匹配（`redact.ts` 今天做的）处理"调用方明确知道有哪些具体的敏感值"这种场景（比如 `WorkspaceContext.envCredentials` 里配置过的每一个凭据），格式匹配处理"调用方不知道具体值是什么，但知道这类东西通常长什么样"这种场景（比如未知来源的 API key 格式）——今天只做了前者，因为它对应的是这门课已经存在、结构清晰的凭据体系；后者是一个更通用、误判率更难控制的能力，值得单独设计、单独评估误报率，不该在今天顺手加一个正则就算完成。
