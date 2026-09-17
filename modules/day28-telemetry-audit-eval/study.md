# 白话讲解：遥测、审计与评测体系

> 素材来源：DSH `docs/subsystems/session-telemetry.zh.md`。业内常把"可观测性"拆成三根支柱——**遥测**（Telemetry：系统跑得快不快、花了多少钱）、**审计**（Audit：谁在什么时候被允许做了什么）、**评测**（Eval：做出来的结果对不对）。三个问题看起来不一样，但都在回答同一件更根本的事："凭什么相信这个系统昨天真的按预期工作了"——不是靠印象，是靠一份可以被翻出来核对的记录。今天要建的四个文件，`redact.ts`/`telemetry.ts`/`audit-log.ts`/`eval-harness.ts`，各自负责这个大问题的一个切面，权重不平均——跟 Day24 一样，值得写真代码的地方多写，能一句话讲清楚的地方不硬凑篇幅。

## 0. 今天的四个文件、各自是什么、解决哪个问题

| 文件 | 核心导出 | 是什么 | 解决哪个问题 |
|---|---|---|---|
| `redact.ts` | `createRedactor()` | 给一组已知敏感值，返回一个把它们替换成占位符的函数 | 给"工具真实输出可能意外带出凭据明文"这条路径补最后一道防线 |
| `telemetry.ts` | `deriveTelemetry()` | 从 `SessionEvent[]`（Day8）派生出延迟/token/成本报告的纯函数 | 延迟、吞吐、成本、错误——遥测四件套 |
| `audit-log.ts` | `AuditingApprovalStore` | 包一层 `ApprovalStore`（Day19），转发调用的同时发审计记录 | 谁在什么时候被允许执行了什么 |
| `eval-harness.ts` | `Scenario`/`runScenario()`/`sampleScenario()` | 声明式的场景断言运行器，复用 `cli.ts` 的 `runInvestigation()` | 任务是不是真的做对了，不是模型自己说做对了就算数 |

**这四个文件之间没有互相依赖，除了一处**：`telemetry.ts` 的 `deriveTelemetry()` 接受一个可选的 `redactor: Redactor` 参数（`redact.ts` 导出的类型），用来处理它摸到的工具输出内容——这是今天唯一的跨文件耦合，其余三个各自独立，可以按任意顺序读。

## 1. `deriveTelemetry()`：一个纯投影函数，不是往执行路径里插钩子

### 1.1 先讲人话：为什么不用"钩子"

给系统加遥测,直觉的做法是"在每个工具调用前后插一段计时代码,在每次模型请求前后插一段计时代码"——像这样：

```
调用 tool.execute() 之前 → 记一个时间戳
调用 tool.execute() 之后 → 再记一个时间戳,相减,上报
```

这条路会立刻碰到一个问题：这段"记时间戳、上报"的代码要插在哪？插进 `ToolRegistry.execute()`（Day4）内部,就是在改一个已经稳定、被十几个后续天数依赖的核心文件；插在每一个调用 `ToolRegistry.execute()` 的地方（`Agent`/`SubagentManager`/`WorkflowRunner`……）,就是要在好几个不同的类里重复同一段逻辑。

**今天选的是另一条路**：`Agent` 从 Day8 起，每一次工具调用、每一次模型调用，都已经真实地记了一条 `SessionEvent`——`tool/call`/`tool/result` 各带一个 `time: number`（epoch 毫秒），`assistant/message` 同理。这些时间戳早就在那儿了,只是从来没有人把它们"读出来、配对、算差值"过。`deriveTelemetry()` 要做的不是"采集新数据",是"把已经存在的数据,读成另一种形状"——跟 Day10 `projectSummary()`/`deriveMessages()` 是完全一样的思路：一份仅追加的事件日志是唯一真源,遥测报告只是这份真源的又一个派生视图,不是一个平行的、需要单独维护的采集系统。

### 1.2 配对逻辑：箭头图 + 代码

```
SessionEvent[] （Day8 真源）
  │
  ├─ 'step/start' (turn=1, step=1, time=1000)  ──┐
  ├─ 'assistant/message' (turn=1, step=1, time=1050) ─┴─→ 配对成功：latencyMs = 1050-1000 = 50
  ├─ 'tool/call' (callId='c1', name='search_text', time=1055) ──┐
  ├─ 'tool/result' (callId='c1', time=1080) ─────────────────────┴─→ latencyMs = 1080-1055 = 25
  ├─ 'step/end' (...)
  └─ ...
```

`deriveTelemetry()`（[telemetry.ts:64-119](../../mini-harness/src/core/telemetry.ts#L64-L119)）用两个 `Map` 各自记"还没配对上的开始时间"：`stepStartedAt`（键是 `turn:step`）记 `step/start` 的时间,遇到 `assistant/message` 时查表算延迟（[telemetry.ts:76-78](../../mini-harness/src/core/telemetry.ts#L76-L78)）；`toolCalledAt`（键是 `callId`）记 `tool/call` 的时间和名字,遇到 `tool/result` 时查表算延迟（[telemetry.ts:90-93](../../mini-harness/src/core/telemetry.ts#L90-L93)）。整个函数只是一次 `for...of` 循环,`switch (event.type)` 分支处理,没有任何 `await`——纯同步、纯函数,给它同一份事件日志,永远算出同一份报告。

## 2. 为什么"没上报用量"必须变成 `'unknown'`，不能是 0——真值表

`deriveTelemetry()` 内部用一个 `TokenMeter`（Day12）累计所有 `assistant/message.usage`（[telemetry.ts:83](../../mini-harness/src/core/telemetry.ts#L83)）。`TokenMeter.record(usage)` 的纪律（Day12 就定下的）是：只要有一次调用没有上报 `usage`（传 `undefined`）,累计值就**永久**变成 `'unknown'`，不会因为后面又有几次正常上报而"补回来"。

**真值表：`usage` 是否上报 × 是否配置了 `costRates`，决定 `estimatedCostUsd`**

| 这次调用有没有上报 usage | 有没有给 `costRates` | `totals.inputTokens` | `estimatedCostUsd` |
|---|---|---|---|
| 每次都上报了 | 给了 | 一个具体数字 | `token数 × 单价` 算出来的具体数字 |
| 每次都上报了 | 没给 | 一个具体数字 | `'unknown'`（不是没数据，是没定价） |
| 至少一次没上报 | 给了 | `'unknown'` | `'unknown'`（本来就不知道总共花了多少 token，谈不上成本） |
| 至少一次没上报 | 没给 | `'unknown'` | `'unknown'` |

写代码时最容易踩的坑,是 `deriveTelemetry()` 第一版真实写出来过的一个 bug：只在 `event.usage` 为真值时才调用 `meter.record()`（`if (event.usage) meter.record(event.usage)`）——这样"没上报"和"根本没调用 record()"完全等价,`meter` 的初始值本来就是 `0`,永远不会被推成 `'unknown'`，跟"报了 0 个 token"混成了同一个结果。修复是**无条件**调用 `meter.record(event.usage)`（[telemetry.ts:80-83](../../mini-harness/src/core/telemetry.ts#L80-L83) 的注释里记录了这一点）——把 `undefined` 也真的传给 `TokenMeter`，让它自己按 Day12 定的纪律判断要不要翻成 `'unknown'`，不是在 `telemetry.ts` 这一层自作主张先过滤一遍。这条坑被 `tests/telemetry.test.ts` 里"unreported usage makes totals — and therefore cost — unknown"那条测试真实抓到过（改的时候先写坏、跑测试确认真的失败、再修好、再确认恢复通过,不是凭空写在这里的）。

## 3. `AuditingApprovalStore`：包一层，不改 `approval.ts`

### 3.1 设计两次：改内部 vs. 包一层

给 `ApprovalStore`（Day19）加审计,第一个想到的方案是直接在 `approval.ts` 里的 `create()`/`consume()`/`revoke()` 内部加一个可选的 `onEvent` 回调——类似 `Agent` 已经有的 `sink` 模式。这个方案的问题是：`approval.ts` 从 Day19 起已经被 `propose-edit.ts`（Day21 里程碑）依赖，且它自己的状态机（`consumed`/`revoked`/`expired` 四种状态、五个判断条件）已经被完整测过、完整讲过——为了加一个"审计"能力去改动一个已经稳定的类，属于"晦涩"换"方便"的坏交易。

第二个方案——今天选的——是写一个新类 `AuditingApprovalStore`，构造时接一个真实的 `ApprovalStore` 实例（[audit-log.ts:28-31](../../mini-harness/src/core/audit-log.ts#L28-L31)），对外暴露跟 `ApprovalStore` 一样名字的 `create`/`consume`/`revoke` 方法,内部实现就是"转发给被包的那个实例,转发成功之后再多做一步——发一条审计记录"。这样 `approval.ts` 一行没改,它自己的测试、`propose-edit.ts` 现有的调用方式全都不受影响；要不要接审计,只是"用 `ApprovalStore` 还是用 `AuditingApprovalStore`"这一个调用点的选择。

### 3.2 一个真实的接口设计限制：`ApprovalStore` 不能"查"

`AuditingApprovalStore.consume()`/`.revoke()` 只收一个 `nonce`,`ApprovalStore` 自己也是——它不提供"给我这个 nonce 对应的完整 `ApprovalRequest`"这样的查询方法（`consume()`/`revoke()` 只返回 `void`）。但一条完整的审计记录（[audit-log.ts:7-10](../../mini-harness/src/core/audit-log.ts#L7-L10)）需要带上 `action`/`target`——这两个字段只有在 `create()` 那一刻才知道。解决办法是 `AuditingApprovalStore` 自己维护一份小映射 `metadata: Map<nonce, {action, target}>`（[audit-log.ts:26](../../mini-harness/src/core/audit-log.ts#L26)），在 `create()` 成功时顺手记一份（[audit-log.ts:35](../../mini-harness/src/core/audit-log.ts#L35)），`consume()`/`revoke()` 里查出来用。**这份映射只存静态元数据（创建后永远不变），不重复 `ApprovalStore` 内部真正的状态机**——"这个 nonce 现在是 consumed 还是 revoked 还是过期了"这类会变化的判断,完全交给被包的那个 `ApprovalStore` 实例,`AuditingApprovalStore` 自己不重新判断一遍,也不可能因为这份映射漂移而跟真实状态不一致。

### 3.3 只有真正成功的动作才产生审计记录

```ts
consume(nonce: string, args: unknown, principal: string, now: number = Date.now()): void {
  this.inner.consume(nonce, args, now)   // ← 这一行会抛错的话，下面永远不会执行
  const meta = this.metadata.get(nonce)
  this.sink?.record({ kind: 'consumed', principal, nonce, action: meta?.action ?? '(unknown)', target: meta?.target ?? '(unknown)', at: now })
}
```

`this.inner.consume(...)`（[audit-log.ts:43](../../mini-harness/src/core/audit-log.ts#L43)）如果因为参数不对/已经消费过/过期而抛错，函数会在这一行直接中断，永远走不到下面 `sink?.record(...)` 那一行——一次失败的尝试不会被记成"这次消费真的发生过"。这跟 Day22 `IdempotencyStore.claim()` 只在真正执行副作用之前占位、审批 `ApprovalStore.consume()` 全部校验通过才标记消费，是同一种"状态变更只发生在正确的那一刻"的纪律，这里延伸成"审计记录只在动作真的发生了之后才产生"。

### 3.4 `principal`：一个诚实的名字，不是"用户身份"

`create`/`consume`/`revoke` 都多收一个 `principal: string` 参数——这是调用方自己传进来的字符串,`AuditingApprovalStore` 原样记下来,**不做任何验证**。这跟 Day22 `http-server.ts` 的 bearer token 是同一类诚实缺口：token 只回答"有没有钥匙",不回答"这把钥匙的持有者是谁";`principal` 只回答"调用方自称是谁",不回答"这个自称有没有经过验证"。这个项目至今没有真实的用户认证系统,`principal` 这个字段的价值仅限于"如果调用方老老实实传对了身份,审计记录就是可信的"——它把"谁做的"这个问题从"完全没有记录"往前推了一步,但没有推到"密码学级别可信"那一步,`modules/day30-milestone-graduation/threat-model.md`（Day30）会把这条缺口正式收进威胁模型汇总里。

## 4. `redact.ts`：为什么只需要管 `tool/result.content`

### 4.1 一条血统追溯：一个密钥值怎么走到"可能被遥测摸到"这一步

```
Day20 CredentialStore.set('demo-secret', 'sk-真实值')
  │  （真实值只存在这一处，以后全程只流动一个不透明的引用 CredentialRef {id: 'demo-secret'}）
  ▼
WorkspaceContext.envCredentials: {DEMO_SECRET: {id: 'demo-secret'}}   ← workspace-context.ts:17，只是一份"环境变量名 → 引用"的映射
  │
  ▼
run_command 真正执行的那一刻：workspace.credentials.resolve(ref)     ← bash-tool.ts:135，解析成真实值，合并进子进程 env
  │  （模型自己传的、同名的 env 值会被这一步覆盖，赢的是 workspace 配置的——workspace-context-integration.test.ts 已经验证过）
  ▼
子进程真的跑起来——如果这个进程自己把 DEMO_SECRET 打印到了 stdout（不管是不是模型故意诱导的）
  │
  ▼
run_command 工具把 stdout 原样收集成 ToolResult.content
  │
  ▼
Agent 把它写成一条 'tool/result' SessionEvent（session.ts 的 payload 定义,content 字段就是这段原始文本）
  │
  ├─→ 不经过 redactor：原始 SessionEvent 日志——凭据明文原样在里面（这是故意的，日志是真源，不该被篡改）
  └─→ 经过 redactor：deriveTelemetry() 的 TelemetryRecord.redactedContent——明文被替换成 [REDACTED]
```

**这条链路上,真实密钥值只在两个地方存在**：`CredentialStore` 内部,和"子进程真正跑起来之后,它自己往 stdout 写了什么"。中间所有传递的都是不透明引用（`CredentialRef`）——这正是 Day20 专门设计的"引用而不是真实值到处流动"发挥作用的地方：只要遥测/审计代码碰的是 `SessionEvent` 的其余字段（`tool/call.arguments`、`user/message` 等等）,结构上根本摸不到任何密钥值,因为那些字段从来没有装过密钥值,装的最多是 `CredentialRef.id` 这样的引用字符串。

**但 `tool/result.content` 不受这条保证约束**——它装的是子进程真实输出了什么,这是一段完全不受 `CredentialRef` 设计约束的自由文本。一个被诱导执行了"打印所有环境变量"或者"echo 这个变量"之类命令的 `run_command` 调用,完全可能把解析出来的真实密钥值原样打到 stdout,而 stdout 原样进日志——`redact.ts` 就是专门给这一条路径补的最后一道防线,不是给"遥测系统"整体加的通用脱敏能力（`redact.ts` 本身跟 telemetry/audit 没有任何 import 关系,是一个完全独立的小工具函数,只是 `telemetry.ts` 恰好是今天唯一用到它的调用方）。

### 4.2 为什么脱敏发生在读遥测报告的时候，不是发生在写 `SessionEvent` 的时候

`tests/telemetry.test.ts`（"redact() ... but not in the raw SessionEvent log"那条）故意验证了两件事：原始 `agent.sessionEvents` 里凭据明文确实在（[telemetry.test.ts](../../mini-harness/tests/telemetry.test.ts)）；经过 `deriveTelemetry({redactor})` 之后的报告里被替换掉了。日志本身不做任何脱敏,是刻意的——Day8 定下的纪律是"事件日志是唯一真源、仅追加、不改写",如果连日志本身都要被脱敏改写,真源就不再诚实（真出了安全事故要复盘,连真实发生过什么都查不清楚）。脱敏只发生在"要把这份数据往外部系统送"的那个边界——遥测报告要发去外部监控系统、日志要展示给运维看,这些才是真正暴露面扩大的地方,`redactor` 就加在这个边界上,不加在写入的那一刻。

## 5. `eval-harness.ts`：离线场景集 vs. 模型抽样评测,回答的是两个不同的问题

### 5.1 场景断言：形式化已经在做的事,不是发明新机制

`runScenario()`（[eval-harness.ts](../../mini-harness/src/core/eval-harness.ts)）直接复用 `cli.ts` 已有的 `runInvestigation()`——这不是巧合,是刻意的：`tests/session-milestone.test.ts` 从 Day14 起就一直在"跑一次真实调查,断言 `stopReason`/`toolCallCountByName` 长什么样"这件事,`EvalHarness` 只是把这个已经在做的事,从"每次手写一段 `expect(...)`"，升级成"声明式地列一组 `ScenarioAssertion`,跑完自动逐条核对"。三种断言（`final-text-includes`/`tool-called`/`stop-reason`）覆盖的是"离线场景集 + contract test"最常见的三类检查,不需要更多花样。

### 5.2 为什么"模型抽样评测"今天只能靠一个合成 adapter 演示

大纲原文要求"模型抽样评测"——现实中的动机是：面对一个有真实变动性的 provider（同一个 prompt，多次调用可能给出不同回答），单跑一次不能说明"这个任务能不能稳定做对",要跑 N 次,看通过率。`sampleScenario()`（[eval-harness.ts](../../mini-harness/src/core/eval-harness.ts)）实现的正是"跑 N 次、聚合通过率"这条计算路径——但这门课至今只用 `HeuristicInvestigationAdapter` 这一种**完全确定性**的 adapter,同一个输入永远给同一个输出,用它跑 `sampleScenario()` 只会得到 100% 或 0% 的通过率,没法演示"抽样"真正要解决的问题。

`createFlakySampleAdapter(seed, successProbability)`（[eval-harness.ts](../../mini-harness/src/core/eval-harness.ts)）是专门为了证明"聚合通过率"这条计算路径本身是对的而造的合成 adapter——复用 Day2/3 就有的 `mulberry32` 种子 PRNG（跟 Day23 `fault-injecting-transport.ts` 同一个"确定性伪随机"手法,只是那次模拟的是网络故障,这次模拟的是"这次调用运气好不好"）,同一个种子永远复现同一串"这次成功还是失败"的判定序列,`tests/eval-harness.test.ts` 里专门有一条测试验证了这一点（两次用相同种子跑出来的 `SampleReport` 完全相等）。**诚实记录**：这不代表这门课接入了真实的非确定性 provider,只是证明了"如果以后真的接了一个会变动结果的 provider，`sampleScenario()` 这条聚合逻辑是可信的",要看到有意义的抽样评测结果,需要一个真实 provider。

## 一句话总结

今天四个文件都在回答同一个更大的问题的不同切面——"凭什么相信这个系统真的按预期工作了"：`deriveTelemetry()` 证明"跑得快不快、花了多少钱"能从已有的事件日志里如实算出来,不用额外埋点；`AuditingApprovalStore` 证明"谁被允许做了什么"能在不碰动已经稳定的 `ApprovalStore` 的前提下补上;`redact.ts` 证明"能如实记录"和"记录里不该有的东西不外泄"这两件事可以同时成立,只要想清楚泄漏真正发生在哪一层;`eval-harness.ts` 证明"任务真的做对了"能被一组可重复运行的断言检验,不是靠读一遍最终文本、凭印象觉得"看起来对"。
