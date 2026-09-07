# 企业级 Agent / Agent Harness：30 天进阶学习计划

> 基于 DeepSeek Harness（DSH）架构与 Reference 设计的实践课程  
> 目标不是复刻 DSH，而是通过一个持续演进的 `MiniHarness`，掌握设计、实现和评审企业级 Agent 系统所需的核心能力。

## 1. 学完后应该具备什么能力

30 天结束时，你应该能够：

1. 区分 AI 功能、AI 工作流、Agent 与 Agent Harness，并判断业务是否真的需要 Agent。
2. 从零实现可流式输出、可调用工具、可取消、可恢复的 Agent loop。
3. 用仅追加事件日志建模会话，支持回放、投影、查询、fork 和崩溃恢复。
4. 管理系统提示词、工具 schema、Token 预算、上下文裁剪与压缩。
5. 设计统一的工具执行管线，处理参数校验、超时、取消、输出截断、幂等和错误分类。
6. 为文件、进程、网络和代码执行建立权限、审批、沙箱与凭据边界。
7. 设计后台任务、目标、计划模式、提醒、技能、子 Agent 与动态工作流。
8. 通过 HTTP/流式协议暴露 Agent，并正确处理断线重连、基线快照与增量事件。
9. 建立日志、指标、trace、审计、评测、故障注入与发布门禁。
10. 写出一份可供团队实施和评审的企业级 Agent 架构设计。

这不是“30 天精通所有实现细节”的承诺。合理目标是：形成完整心智模型，完成一个有生产骨架的系统，并知道每一种复杂性为什么存在、何时需要、如何验证。

## 2. 学习假设与时间投入

- 建议每天 3～4 小时：阅读 45～60 分钟，编码 90～120 分钟，测试与复盘 45～60 分钟。
- 默认采用 TypeScript + Node.js，因为 DSH 本身是 TypeScript monorepo，便于对照源码。
- 需要掌握：TypeScript 基础、Promise/async、HTTP、JSON Schema、基本数据库与测试知识。
- 模型供应商不限。通过自建 `LlmAdapter` 隔离供应商差异，不把课程绑定到某个 SDK。
- 前 20 天默认只在本地和模拟环境运行；任何真实写操作都必须在审批和沙箱完成后再接入。

## 3. 课程项目：MiniHarness

### 3.1 为什么选择 MiniHarness

有两个容易想到但都不理想的方案：

- 只做一个业务 Demo：上手快，却看不到恢复、安全、可观测性和演进问题。
- 直接复刻 DSH：覆盖全面，但会被插件系统和平台细节淹没，难以判断哪些是本质复杂性。

本课程采用第三种方案：构建一个“小而完整”的 Harness。它只支持一个本地工作区和一种主 Agent，但保留生产系统最关键的边界与不变式；子 Agent、Web Client、插件化在后期按需加入。

### 3.2 最终架构

```text
CLI / HTTP / 简易 Web Client
              │
        AgentApplication
              │
        AgentRuntime.run()
     ┌────────┼─────────────┐
     │        │             │
 LlmAdapter  SessionStore  ToolRuntime
     │        │             │
 streaming  event log   schema/policy/approval
 token      projection   timeout/cancel/result
     │        │             │
 ContextManager     Capability Providers
 prompt/compact     fs/process/web/code/subagent
              │
      Policy + Sandbox + Credentials
              │
       Telemetry + Eval + Audit
```

核心接口要保持少而深：

```ts
interface AgentRuntime {
  run(request: RunRequest): AsyncIterable<AgentEvent>
  cancel(runId: RunId, reason?: string): Promise<void>
  resume(sessionId: SessionId): AsyncIterable<AgentEvent>
}
```

调用者不应该负责拼接历史、回填工具结果、压缩上下文、恢复半截轮次或协调审批；这些复杂性属于 Harness 内部。

### 3.3 推荐目录

```text
mini-harness/
├── src/
│   ├── core/          # Agent、turn、step、事件与运行循环
│   ├── llm/           # Adapter、stream assembler、token meter
│   ├── session/       # 事件日志、持久化、投影、查询
│   ├── context/       # system prompt、预算、compaction
│   ├── tools/         # registry、schema、执行管线
│   ├── capabilities/  # fs、process、web、code、skills
│   ├── policy/        # permission、approval、sandbox
│   ├── orchestration/ # goal、job、subagent、workflow
│   ├── platform/      # HTTP、stream、workspace、settings
│   └── telemetry/     # log、metric、trace、audit
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── scenarios/
│   └── chaos/
├── evals/
├── fixtures/
└── docs/
```

不要在第一天创建全部空目录。只在某项能力出现时建立对应模块，避免分类学式的空壳架构。

## 4. 30 天总览

| 阶段 | 天数 | 主线 | 阶段产物 |
|---|---:|---|---|
| I. 最小但正确的内核 | 1～7 | Agent loop、流式模型、工具、生命周期 | 可测试的单 Agent CLI |
| II. 可回放的状态与上下文 | 8～14 | 事件溯源、持久化、投影、Token、压缩 | 可崩溃恢复的会话系统 |
| III. 受控执行与人机协作 | 15～21 | 文件/进程/后台任务、审批、沙箱、凭据 | 安全的执行型 Agent |
| IV. 平台化与编排 | 22～27 | API、Client、skills、goal、subagent、workflow | 可远程使用的 MiniHarness |
| V. 生产验证与毕业设计 | 28～30 | 遥测、评测、压力、混沌、安全与架构评审 | 企业级设计包与演示 |

## 5. 每日课程

## 阶段 I：最小但正确的内核（Day 1～7）

### Day 1：识别系统边界，设计两次

**学习目标**

- 区分业务 Agent、Agent runtime、Agent Harness 和完整 Agent 平台。
- 理解 DSH 的“everything is a plugin”是平台扩展策略，不是最小 Agent 的必要条件。
- 学会从目标、环境、能力、状态、策略、完成条件六个维度定义 Agent。

**阅读**

- [DSH README](https://github.com/deepseek-ai/deepseek-harness)
- [DSH 架构](https://deepseek-harness.github.io/deepseek-harness/reference/)
- [子系统总览](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/)

**实践**

1. 选择毕业项目：建议“企业知识与代码调查 Agent”，先只读，后加入受控修改。
2. 写两套设计：
   - A：固定工作流 + 若干 LLM 节点。
   - B：Agent loop + 工具 + 策略。
3. 比较任务开放度、错误代价、可测试性、权限和成本，写 ADR-001 说明为什么选择或混合两者。
4. 写 10 个真实任务、5 个明确拒绝任务、5 个需要人工确认的任务。

**验收**

- 每个任务都有可观察的完成条件，而不是“回答看起来不错”。
- 能指出系统里哪些判断交给模型、哪些必须由确定性代码完成。

**产物**：`docs/product-scope.md`、`docs/adr/001-agent-vs-workflow.md`。

### Day 2：LLM 消息模型与流式协议

**学习目标**

- 理解 user/assistant/tool 消息、文本块、推理块、工具调用块。
- 区分供应商 wire event 与系统内部统一事件。
- 理解流式响应不能简单当作字符串拼接：工具调用参数可能分片抵达，取消时也可能只有前缀。

**阅读**

- [LLM 流式响应](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/llm-streaming)
- [Agent 生命周期](https://deepseek-harness.github.io/deepseek-harness/reference/agent-lifecycle)

**实践**

- 定义内部 `Message`、`ContentBlock`、`StreamChunk`、`FinishReason`。
- 实现一个 fake adapter，按随机分片输出文本和工具参数。
- 实现 `BlockAssembler`，把 chunks 组装成完整 assistant message。

**故障注入**

- 在 UTF-8 字符、JSON 参数和工具调用中间断流。
- 返回空内容、未知 chunk、重复结束事件。

**验收**

- 同一完整消息经过 100 种随机分片后组装结果一致。
- 中断前缀被标记为 interrupted，未完成工具调用绝不执行。

**产物**：`src/llm/types.ts`、`src/llm/fake-adapter.ts`、流式属性测试。

### Day 3：Adapter 边界与请求信封

**学习目标**

- 用 Adapter 隔离 provider、model、reasoning、采样参数和用量差异。
- 理解一次模型请求必须可重建：模型配置、系统提示词和工具 schema 都属于请求事实。

**实践**

- 定义 `LlmAdapter.stream(request, signal)`。
- 接入一个真实模型和 fake adapter。
- 规范化 provider error：认证、限流、超时、上下文溢出、服务端错误、协议错误。
- 对请求信封做稳定序列化和指纹计算，但日志不得记录密钥。

**故障注入**

- 429、500、连接中断、无 usage、未知模型、上下文超限。

**验收**

- 上层 Agent loop 不依赖供应商 SDK 类型。
- 重试策略只重试可恢复错误，并尊重取消信号。

**产物**：`src/llm/adapter.ts`、错误分类表、adapter contract tests。

### Day 4：工具定义——接口质量决定 Agent 上限

**学习目标**

- 理解工具名、描述、JSON Schema、结果和错误是模型与确定性世界的契约。
- 识别浅工具：需要模型连续拼接大量低层调用才能完成一个稳定操作。
- 设计深工具：接口简单，内部承担校验、事务、幂等和错误细节。

**阅读**

- [工具子系统](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools)
- [Tool Schema Catalog](https://deepseek-harness.github.io/deepseek-harness/reference/tool-catalog)

**实践**

- 实现 `ToolRegistry` 与 schema 校验。
- 实现三个只读工具：`list_files`、`search_text`、`read_file`。
- 为每个工具写前置条件、后置条件、错误码和最大输出约束。
- 对比 `read_bytes/open/seek/close` 与 `read_file(range)` 两种设计，写 ADR-002。

**验收**

- 未知参数、额外字段、错误类型、越界路径都稳定失败。
- 所有工具结果都是可序列化数据，模型展示与内部元数据分离。

### Day 5：实现 Agent loop

**学习目标**

- 掌握 turn、step、模型请求、并行工具调用和停止原因。
- 区分“模型说完成了”和“系统确认满足完成条件”。

**阅读**

- [核心](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/core)
- [工具执行流水线](https://deepseek-harness.github.io/deepseek-harness/reference/tool-execution-pipeline)

**实践**

- 实现 `run(goal)`：请求模型、执行工具、回填结果、继续请求。
- 加入 max steps、max tool calls、deadline、取消信号和明确 stop reason。
- 每次模型调用和它要求的工具执行定义为一个 step；一次用户输入触发的连续工作定义为一个 turn。
- 在代码和时序图中明确区分五个尺度：session、turn、step、provider attempt、request series；重试 attempt 不能被伪装成同一次成功调用。
- 将工具执行固定为 `pre-policy → monotonic guard → execute/timeout → post-policy → canonical result`；后续 guard 只允许缩权，不能把先前的 deny 重新放行。

**故障注入**

- 模型重复调用同一工具、调用不存在工具、参数不是合法 JSON、永不主动结束。

**验收**

- 所有路径都产生唯一终态：completed、cancelled、budget_exhausted 或 error。
- 不允许吞掉工具错误后伪装成功。

### Day 6：生命周期、取消与并发

**学习目标**

- 理解 Agent handle、运行所有权、inbox、steering、取消和资源清理。
- 理解取消不是布尔值，而是需要跨模型流、工具、子进程传播的协议。

**实践**

- 建立 `AgentHandle`，支持 `send()`、`cancel()`、`whenIdle()`。
- 实现每会话单 writer；新用户消息进入 inbox，不直接修改当前 request。
- 用 `AbortSignal` 贯穿模型与工具执行。
- 明确 dispose 幂等，所有资源由创建者负责释放。

**故障注入**

- 模型流期间取消、工具执行期间取消、结束与取消同时发生、用户连续发送消息。

**验收**

- 无悬挂 Promise、重复终态、取消后继续写日志或遗留进程。
- 竞态测试重复 100 次通过。

### Day 7：里程碑一——可测试的单 Agent CLI

**实践**

- 完成 CLI：输入调查目标，Agent 自主使用三个只读工具并输出带文件证据的结论。
- 建立 20 条场景评测：成功、证据不足、工具失败、循环、取消、预算耗尽。
- 用 deterministic fake adapter 做集成测试；真实模型测试只作为抽样，不作为唯一 CI 判据。

**阶段门禁**

- 单元测试覆盖组装器、schema、loop 终态和取消竞态。
- 20 条场景全部产生合法终态；不以“程序未抛异常”作为成功。
- 能画出一次 turn 中多个 step 和 tool call 的时序图。

**复盘问题**

- 哪些复杂性来自 LLM 的概率性？哪些来自普通分布式/异步系统？
- 如果去掉模型，这套生命周期设计还剩下多少？

## 阶段 II：可回放的状态与上下文（Day 8～14）

### Day 8：仅追加事件日志与真源

**学习目标**

- 理解 DSH 将 Session 设计为类型化、仅追加日志，模型历史从日志派生而非另存一份。
- 区分持久事实与瞬态控制状态。

**阅读**

- [会话](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session)
- [持久化事件目录](https://deepseek-harness.github.io/deepseek-harness/reference/persistence-catalog)

**实践**

- 定义 `turn/start|end`、`step/start|end`、`user/message`、`assistant/chunk|message`、`tool/call|result`。
- 每条事件具有连续 seq、time、version；payload 必须是无损 JSON。
- 实现 `deriveMessages(events)`，禁止单独维护一份可漂移的 message history。

**不变式**

- 同一 turn/step 的开闭必须配对；tool result 必须对应先前 callId。
- 已记录为模型可见的输入必须能从日志重建。
- replay 两次得到相同派生结果。

### Day 9：持久化、flush 与崩溃恢复

**阅读**

- [会话持久化](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/persistence)
- [运行时不变式](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/invariants)

**实践**

- 先实现 JSONL `SessionPersistence`，接口包含 create、append、load、flush、list。
- 将事件追加与业务循环解耦，但在关键边界执行 flush checkpoint。
- 对未闭合 turn 做恢复：保留已写事件，并追加 `interrupted` 终止事实，不静默截断。
- 引入 session header：格式版本、创建时间、cwd、parent、agent preset。

**故障注入**

- 在写入每一类事件后强杀进程；注入半行 JSON、重复 seq、磁盘写失败和未来版本。

**验收**

- 重启后能区分 interrupted、corrupted、unsupported_version。
- flush 失败不得被记录成成功；恢复过程不得改写已持久化历史。

### Day 10：投影、查询、引用、标题与 Spill

**阅读**

- [会话投影](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-projection)
- [会话查询](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-query)
- [会话引用](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-reference)
- [会话标题](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-title)
- [Spill 存储](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/spill)

**实践**

- 写纯函数 projection：turn 边界、token 总量、工具统计、当前 goal。
- 提供按 seq 的精确分页，不用数组 index 冒充稳定游标。
- 为大工具结果建立 `SpillRef`：日志保存摘要和引用，大正文独立存放。
- 标题生成必须记录来源消息 seq；跨会话引用使用结构化 id，不复制模糊文本。

**验收**

- 全量 replay 与增量 projection 结果逐字段一致。
- Spill 丢失返回稳定错误，不让模型误以为读到了空内容。

### Day 11：系统提示词与能力组装

**阅读**

- [系统提示词](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/system-prompt)
- [能力服务](https://deepseek-harness.github.io/deepseek-harness/reference/capability-services)
- [作用域](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/scope)

**实践**

- 将 prompt 分成稳定段：身份、工作区、政策、能力说明、任务上下文。
- 工具 schema 与 prompt 在每次请求前由同一能力快照组装。
- 记录渲染后的请求信封，确保恢复时知道当时模型实际看到了什么。
- 设计 global/workspace/session/agent 四级作用域，先实现 session 与 agent 两级。

**验收**

- 工具被移除后，prompt 不得继续宣称它可用。
- 相同能力快照产生稳定 prompt；敏感凭据绝不进入 prompt。

### Day 12：Token 计量、预算与成本控制

**阅读**

- [Token 计量](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/token-meter)

**实践**

- 记录输入、输出、缓存、推理 token；保留 provider 未报告 usage 的“未知”，不要写成 0。
- 建立单请求、单 turn、单 session 三层预算。
- 同时记录 step 数、工具次数、墙钟时间和估算费用。
- 预算耗尽必须产生独立 stop reason。

**故障注入**

- provider 补发 usage、缺失 usage、重试后重复上报、取消时只有部分 usage。

**验收**

- replay 得到的累计值与实时累计一致。
- 已取消或失败请求的已消耗成本不会消失。

### Day 13：上下文窗口与压缩

**阅读**

- [上下文压缩](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/compaction)

**实践**

- 先实现确定性裁剪：去除过旧的大型工具正文，保留调用与摘要。
- 再实现模型摘要：记录 compaction start/summary/end，不原地改写历史。
- 定义必须保留信息：当前目标、未完成承诺、审批状态、关键事实与来源、最近交互。
- 压缩后开启新的请求序列；失败则保留原历史并明确报错。

**故障注入**

- 摘要模型超时、产生过大摘要、遗漏未完成任务、压缩后仍超窗。

**验收**

- 用“针藏在长历史中”的测试验证关键事实保留率。
- 对同一历史重复压缩不会不断复制摘要或破坏 tool call 配对。

### Day 14：里程碑二——可恢复的长会话

**实践**

- 将 Day 7 CLI 接入事件日志、JSONL、projection、预算和 compaction。
- 运行一个至少 30 step 的任务，在模型流、工具执行、flush 三个位置分别强杀并恢复。
- 增加 `inspect-session` 和 `replay-session` 命令。

**阶段门禁**

- 日志是唯一真源；UI/CLI 状态均能从日志或明确的瞬态状态重建。
- 崩溃恢复、未来版本拒绝、日志损坏均有稳定分类。
- 能解释为什么“聊天记录数组 + 每次覆盖 JSON 文件”不足以支撑生产系统。

## 阶段 III：受控执行与人机协作（Day 15～21）

### Day 15：文件系统能力与一致性

**阅读**

- [文件系统](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/filesystem)

**实践**

- 把 path 解析、工作区边界、symlink、编码、文件大小限制下沉到 `FileSystemService`。
- 增加带观测前置状态的写/编辑操作，例如 expected hash，避免覆盖并发修改。
- 写操作先支持 dry-run 和 diff，再支持 commit。

**故障注入**

- `../` 穿越、symlink 逃逸、文件在读写之间变化、二进制文件、超大文件、权限失败。

**验收**

- Agent 无法靠路径技巧越过 workspace root。
- 冲突时明确失败，不以“最后写入者获胜”覆盖用户修改。

### Day 16：子进程与 Bash 执行

**阅读**

- [Bash 执行](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/shell)
- [子进程](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subprocess)

**实践**

- 将 shell 语义与底层 process spawn 分层。
- spawn spec 显式包含 argv、cwd、环境 allowlist、stdin、timeout；避免隐式继承完整宿主环境。
- stdout/stderr 使用有界、基于 offset 的读取；终态包含 exit、signal、timeout、cancelled。
- 为写命令建立 dry-run 或审批描述。

**故障注入**

- 输出洪水、永不退出、fork 子进程、环境变量泄露、cwd 消失、取消竞态。

**验收**

- 超时/取消后进程树被回收，输出有界且截断事实可见。
- secret 不进入命令日志、模型上下文或错误消息。

### Day 17：PTY、后台任务与资源所有权

**阅读**

- [PTY 会话](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/terminal)
- [后台任务](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/jobs)

**实践**

- 理解一次性 exec 与可交互 terminal 的区别；PTY 作为选做实现。
- 必做 `JobRuntime`：start、poll/read、cancel、dispose、终态。
- Job 只暴露稳定 ID 和有界快照；创建者拥有清理责任。
- Session 重启后明确区分“可恢复 Job”和“已失联 Job”。

**验收**

- Agent turn 结束不等于后台任务被遗忘。
- 同一 Job 的终态只出现一次，重复 cancel/dispose 幂等。

### Day 18：沙箱与最小权限

**阅读**

- [进程沙箱](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sandbox)
- [项目安全说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)

**实践**

- 写威胁模型：资产、信任边界、攻击者、入口、影响、缓解措施。
- 将政策判断与底层强制执行分开：policy 决定允许什么，sandbox 保证逃不出去。
- 建立 fail-closed 行为：sandbox 不可用时，危险工具不可静默降级为宿主执行。
- 明确网络、文件、进程、CPU、内存和时间限制。
- 注意 DSH 当前 sandbox seam 主要描述文件系统效果约束，并不自动覆盖网络或进程可见性；你的威胁模型必须为网络、进程和资源限制另外设置强制控制，不能从“启用了 sandbox”推断它们已经安全。

**红队用例**

- prompt injection 要求读取密钥；命令通过 shell 特性绕过；symlink 逃逸；网络外传；fork bomb。

**验收**

- “模型答应不做”不算安全控制。
- 每个高风险能力都有独立于模型的强制边界和测试证据。

### Day 19：审批、权限预设与用户问答

**阅读**

- [审批](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/approval)
- [权限预设](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/permission-presets)
- [用户交互](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/user-questions)

**实践**

- 区分信息缺失问题、偏好选择和风险审批；三者不能共用含糊的 yes/no 接口。
- 审批请求包含：动作、目标、影响、参数摘要、有效期、一次性 nonce。
- 审批绑定具体 tool call 与参数摘要；参数变化后旧批准失效。
- 设计 readonly、balanced、autonomous 三个 preset，但底层仍由细粒度 policy 决策。

**故障注入**

- 重放批准、批准后换参数、双击批准、过期回复、断线后回复。

**验收**

- 审批是一次性可审计能力令牌，不是聊天里的一句“可以”。
- 拒绝或超时不会被模型解释成工具执行成功。

### Day 20：凭据、设置、存储与工作区

**阅读**

- [用户凭据](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/credentials)
- [用户设置](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/settings)
- [存储](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/storage)
- [工作区](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/workspace)

**实践**

- 配置只保存 `CredentialRef`，真实值在执行时按操作解析。
- 设置按 default → deployment → workspace → user 合并，并保留来源。
- Workspace 是身份与能力边界，不只是 cwd 字符串。
- 将 domain storage 与 session event log 分开：前者保存产品状态，后者保存交互事实。

**验收**

- 日志、trace、异常、prompt、工具结果扫描不到 secret。
- 切换 workspace 后，文件权限、凭据和会话查询范围同步变化。

### Day 21：里程碑三——安全执行型 Agent

**实践**

- 给调查 Agent 增加“提出补丁 → 展示 diff → 用户审批 → 受控写入 → 运行验证”的闭环。
- 建立 25 条安全测试：路径逃逸、命令注入、prompt injection、审批重放、secret 泄漏、资源耗尽。
- 写事故演练：模型发起危险命令、sandbox provider 故障、写入后验证失败。

**阶段门禁**

- 默认只读；副作用必须经过确定性 policy。
- 审批绑定精确动作；sandbox 故障关闭；凭据按需解析。
- 每次外部副作用都有 audit 记录、执行结果和关联 session/tool call。

## 阶段 IV：平台化与编排（Day 22～27）

### Day 22：HTTP Server、API Gateway 与流式协议

**阅读**

- [HTTP 服务器](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-server)
- [API Gateway](https://deepseek-harness.github.io/deepseek-harness/reference/api-gateway)
- [Typert](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/typert)

**实践**

- 暴露 create session、send message、cancel、inspect、events stream。
- 请求使用 correlation id；所有 mutation 做认证、授权和幂等控制。
- 流协议区分 baseline、increment、terminal error 和 transport error。
- 客户端取消必须传播到 host 的 Agent/工具，而不是只关闭浏览器连接。

**验收**

- 重复提交同一 idempotency key 不启动两个任务。
- 慢客户端不会无限增长服务端内存；断连不会自动取消不应取消的业务任务。

### Day 23：Client model、Conversation 与重连语义

**阅读**

- [Web Client 架构](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client)
- [客户端模块](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/client-modules)
- [客户端 Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots)
- [Conversation 组装](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/conversation)

**实践**

- 不必复刻完整 React UI；实现一个简易页面或终端 client model。
- 持久流使用 cursor/seq 补洞；瞬态 control 流在每次重连后发送完整 baseline。
- Conversation 从事件组装显示节点，不让 UI 成为第二份业务真相。
- 设计一个 tool card extension point，理解 Slots 的目的即可。

**故障注入**

- baseline 与延迟增量交错、重复事件、缺口、乱序、断线期间任务结束。

**验收**

- 强制断网并重连后，客户端最终状态与服务端权威状态一致。
- 不能依靠“所有通知都会重放”的错误假设。

### Day 24：技能、命令、计划、目标与提醒

**阅读**

- [技能](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/skills)
- [命令](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/commands)
- [计划模式](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/plan)
- [目标](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/goal)
- [定时提醒](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/schedule)

**实践**

- Skill 是按需加载的过程知识，不要把全部说明永久塞入 system prompt。
- Command 是人类直接调用的确定性动作，不必绕经模型。
- Plan mode 把探索/设计与执行分开；退出计划模式需要明确审阅。
- Goal 有状态、完成条件和继续轮次；Reminder 只负责在会话内重新送达事件。

**验收**

- 能清楚回答：某能力应是 prompt、skill、tool、command、workflow 还是普通代码？
- goal 不能仅因模型声称“完成”而关闭，必须通过验证器或用户确认。

### Day 25：Web、LSP 与代码运行时能力

**阅读**

- [Web 访问](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web)
- [LSP 导航](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/lsp)
- [代码运行时](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/code-runtime)

**实践**

- Web search/fetch 分离，结果携带来源、时间、截断和错误类型。
- LSP 提供 definition/references/symbol 等语义查询；不存在时明确降级到文本搜索。
- Code runtime 使用声明式 bindings 和捕获日志，不把任意宿主对象暴露给代码。
- 给三类能力分别写 SSRF、prompt injection、资源限制和不可信输出策略。

**验收**

- 外部内容始终作为不可信数据进入上下文，不能覆盖系统策略。
- 代码和 Web 能力受与 Bash 同级别的 policy/sandbox 控制。

### Day 26：Subagent——隔离、委派与预算

**阅读**

- [Subagent](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/subagent)

**实践**

- 只有当任务可独立、上下文可隔离、并行有收益时才委派。
- 定义 start request、run handle、result、cancel/dispose；区分可继续与一次性 child。
- 持久化 parent、child、delegation depth、预算和能力 preset。
- child 返回结构化结果与证据，不共享可变 message 数组。

**故障注入**

- child 超时、父取消、递归创建、部分 child 成功、结果过大、重复回收。

**验收**

- 有全局并发、总 child 数、深度、Token 和时间预算。
- 父结束后不存在孤儿 child；子 Agent 权限不得默认超过父 Agent。

### Day 27：Workflow——可审计编排，不是万能抽象

**阅读**

- [工作流](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/workflow)

**实践**

- 对比三种编排：确定性业务代码、模型动态选择工具、模型生成 workflow 脚本。
- 实现受限 workflow DSL：`agent()`、`parallel()`、`pipeline()`、`phase()`；不要直接开放任意宿主 JS。
- 每个 run 有 max agents、取消、有限清理时间、唯一终态和事件轨迹。
- fatal 配置/协议错误必须终止；普通 child 失败可以作为数据由 workflow 决定。

**验收**

- 脚本卡死或 child 不退出时，cancel/dispose 在有界时间内完成。
- 能说明为何 workflow 和 subagent 是可选能力，而不是 Agent loop 本身。

## 阶段 V：生产验证与毕业设计（Day 28～30）

### Day 28：遥测、审计与评测体系

**阅读**

- [会话遥测](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/session-telemetry)
- 回看 [运行时不变式](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/invariants)

**实践**

- 建立三类数据：
  - Telemetry：延迟、吞吐、Token、成本、错误、队列与资源。
  - Audit：谁在何时授权并执行了什么副作用。
  - Eval：任务是否正确完成、证据是否充分、策略是否遵守。
- trace 关联 session → turn → step → model call → tool call → subprocess/subagent。
- 日志进入 sink 前统一脱敏；遥测失败不得破坏主要任务。
- 不要假设框架默认替你脱敏：把完整 message、系统提示词、工具参数/结果、cwd 和命令输出都视为潜在敏感出站数据，并用含 canary secret 的测试验证。
- 建立离线场景集、deterministic contract tests、模型抽样评测和人工抽检。

**验收**

- 能从一个失败 session 还原决策轨迹、成本、工具输入输出和停止原因。
- 仪表盘漂亮不算通过；必须能定位至少三个注入故障。

### Day 29：压力、混沌、安全与上线门禁

**实践**

- 压测：并发 session、长 stream、大工具结果、慢客户端、后台任务。
- 混沌：模型 429/500、磁盘满、进程挂死、网络分区、服务重启、日志尾损坏、审批断线。
- 安全：prompt injection、越权工具、路径穿越、SSRF、secret exfiltration、审批重放。
- 为关键状态写运行时不变式，并确保失败可归因到拥有该状态的模块。
- 完成发布检查表：容量、SLO、降级、备份、迁移、回滚、值班手册、数据保留。

**验收**

- 预先定义至少 30 个故障场景及期望终态，不能只做 happy path。
- 每个严重故障都满足：可发现、可定位、可停止扩散、可恢复或明确升级人工。
- 故障时宁可明确停止，也不静默扩大权限或伪造成功。

### Day 30：毕业设计与架构答辩

**最终演示**

演示一个完整任务：

```text
创建 session
→ 调查多个来源
→ 长上下文触发 compaction
→ 提出文件修改
→ 请求精确审批
→ 沙箱内执行
→ 启动后台验证
→ 断线重连
→ 模拟服务重启并恢复
→ 验证目标
→ 输出证据、审计和成本
```

**设计包**

- `architecture.md`：系统上下文、容器、核心组件和数据流。
- `invariants.md`：真源、状态机、所有权与至少 15 条关键不变式。
- `threat-model.md`：资产、信任边界、攻击路径与控制。
- `failure-model.md`：错误分类、重试、取消、恢复、降级和人工介入。
- `eval-plan.md`：任务集、指标、基线、回归门槛与抽检流程。
- `runbook.md`：部署、监控、事故处理、备份与回滚。
- ADR：至少记录 Agent/Workflow、事件日志、工具粒度、沙箱、compaction、subagent 六项设计选择，每项比较两个方向不同的方案。

**毕业门禁**

| 维度 | 通过标准 |
|---|---|
| 正确性 | 关键场景有可执行验收器；不存在只凭模型自报完成的任务 |
| 可恢复 | 在模型、工具、持久化和后台任务边界中断后有明确恢复语义 |
| 安全 | 默认最小权限；高风险副作用经 policy、审批和 sandbox 三层约束 |
| 一致性 | 会话只有一个真源；重放、投影与客户端最终收敛 |
| 可观测 | 能关联完整轨迹、成本、审批和副作用，且经过脱敏 |
| 可测试 | fake adapter、contract test、scenario eval、chaos test 分层完整 |
| 可演进 | provider 与能力可替换，但核心不变式不会被插件化冲淡 |
| 可运维 | 有 SLO、容量假设、告警、runbook、数据保留和回滚策略 |

## 6. DSH Reference 完整覆盖地图

这张表用于查漏补缺，不代表应该按目录顺序学习。

| DSH 能力 | 安排 | 你要掌握的本质 |
|---|---:|---|
| 核心、作用域、运行时不变式 | 1、5、6、9、11、29 | 生命周期、所有权、隔离与可执行契约 |
| 会话、持久化 | 8、9、14 | 仅追加真源、flush、回放、恢复 |
| 会话查询、引用、标题、投影、Spill | 10 | 派生视图、稳定游标、跨会话身份、大结果外置 |
| 遥测 | 12、28 | 用量、trace、脱敏、失败隔离 |
| LLM 流式响应 | 2、3 | 供应商协议归一化、组装和中断前缀 |
| Token 计量 | 12 | 未知值、位置回放、预算与成本 |
| 系统提示词 | 11 | 按能力和作用域组装、请求可重建 |
| 上下文压缩 | 13、14 | 不改写历史的 surface replacement 与恢复 |
| 工具、Tool Schema、执行管线 | 4、5 | 深接口、校验、策略、执行、结果与展示分层 |
| Bash、子进程 | 16 | 显式 spawn、资源边界、输出与终态 |
| PTY、后台任务 | 17 | 长生命周期句柄、所有权和有界清理 |
| 文件系统 | 15 | 工作区约束、并发修改、原子性与错误分类 |
| LSP、代码运行时、Web | 25 | 专用能力 seam 与不可信输入/执行隔离 |
| 技能 | 24 | 按需加载的过程知识 |
| 工作流、子代理 | 26、27 | 有预算的委派和可审计编排 |
| 审批、权限预设、沙箱 | 18、19、21 | 决策、授权与强制执行三者分离 |
| 计划模式、用户交互、命令、目标、提醒 | 19、24 | 人机协同、确定性入口、持续任务状态 |
| HTTP 服务器、API Gateway、Typert | 22 | 可信远程边界、取消与逻辑流 |
| Web Client、客户端模块、Slots、Conversation | 23 | Host 真源、Client projection、扩展 UI 和重连 |
| 存储、工作区、设置、凭据 | 20 | 产品状态、租户边界、分层配置和秘密解析 |
| 插件配置、Cordis Context/Events/Fiber/Registry/Service | 1、11、23、30 | 能力生命周期和可组合平台；理解即可，不要求完整复刻 |

## 7. 每天固定执行的学习闭环

每天不要只做“看文档 + 抄代码”，固定执行以下流程：

1. **预测**：阅读前先写下你认为该子系统解决的问题。
2. **阅读**：读 Reference 的概念段、关键类型、不变式和失败语义，再定位对应源码。
3. **设计两次**：至少提出两种不同方案，比较依赖、晦涩性、失败模式和调用者负担。
4. **实现纵切**：让能力穿过 API、运行时、持久化和测试，而非建立大量空抽象。
5. **故障注入**：主动让模型、网络、磁盘、工具或用户行为失败。
6. **写不变式**：把“绝不能发生什么”写成测试或运行时断言。
7. **复盘**：记录今天引入的复杂性是被消除、被下沉，还是被转嫁给了调用者。

## 8. 企业级 Agent 的核心不变式清单

毕业项目前至少落实以下不变式：

1. 每个 run、turn、step、tool call 只有一个合法终态。
2. 所有模型可见输入都能从持久日志重建。
3. 会话事件 seq 连续、仅追加、可验证；历史不被压缩或恢复过程改写。
4. tool result 必须对应已存在且尚未闭合的 tool call。
5. 未完整组装的工具调用绝不执行。
6. 取消从入口传播到模型、工具、进程、Job、workflow 和 subagent。
7. dispose 幂等且有界；所有长生命周期资源都有明确 owner。
8. 未知用量是 unknown，不是 0；失败请求的真实成本仍被记录。
9. policy 决策、用户审批、sandbox 强制执行是三层不同机制。
10. 审批绑定具体动作和参数，不能跨调用重放。
11. secret 不进入 prompt、会话日志、普通错误、trace 或工具展示。
12. sandbox 不可用时高风险操作故障关闭。
13. Agent、child、workflow 都受深度、并发、Token、时间和工具次数预算约束。
14. 客户端断线重连后通过 baseline/cursor 收敛，不把通知流误当可靠状态存储。
15. goal 完成需验证器或用户确认，不能只相信模型自报。
16. telemetry sink 故障不能破坏主任务，且出站前经过脱敏。
17. 相同事件日志的全量 replay 与增量 projection 结果一致。
18. 任何副作用都能关联到用户、session、审批、tool call 和执行结果。

## 9. 不要机械照搬 DSH 的地方

DSH 是快速迭代中的 developer preview，官方明确提醒存在兼容性破坏。因此课程学习其问题分解、不变式和接口边界，不把当前包名或 Cordis API 当作行业标准。

- 不要第一天就实现“万物皆插件”。先证明第二个 provider 或消费方确实存在。
- 不要为了像 DSH 而拆成几十个浅 package。MiniHarness 应优先使用少而深的模块。
- 不要默认 coding agent 的所有能力都适合业务 Agent。PTY、LSP、Bash 对客服 Agent 可能完全不需要。
- 不要把事件溯源用到所有业务表。它适合会话与执行轨迹，不代表用户账户等领域数据也必须 event sourced。
- 不要因为有 subagent/workflow 就使用它们。只有隔离、并行或专业化收益超过成本时才启用。
- 不要把模型输出当授权、事务结果或事实真源。

## 10. 进一步阅读与源码阅读方法

主资料只使用 DSH 官方来源：

- [DeepSeek Harness GitHub](https://github.com/deepseek-ai/deepseek-harness)
- [架构参考](https://deepseek-harness.github.io/deepseek-harness/reference/)
- [完整子系统目录](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/)
- [Agent 生命周期](https://deepseek-harness.github.io/deepseek-harness/reference/agent-lifecycle)
- [工具执行流水线](https://deepseek-harness.github.io/deepseek-harness/reference/tool-execution-pipeline)
- [能力服务](https://deepseek-harness.github.io/deepseek-harness/reference/capability-services)

阅读每个子系统时按这条路径走：

```text
Reference 概念段
→ 公共类型与错误联合
→ 生命周期/所有权/取消语义
→ invariant companion
→ provider 实现
→ contract tests 与故障测试
```

不要从类型声明第一行一直读到最后一行。先回答五个问题：

1. 它拥有哪份权威状态？
2. 谁创建、谁释放？
3. 它的输入输出契约是什么？
4. 失败、取消、重启时发生什么？
5. 哪条不变式能证明它没有静默损坏系统？

## 11. 最终自测：你是否真的能设计企业级 Agent

如果能够不依赖框架术语，清楚回答以下问题，才算真正完成课程：

- 为什么你的任务需要 Agent，而不是普通工作流？
- 什么是系统里的唯一真源？重启后如何恢复？
- 模型在第 17 步看到的完整请求能否重建？
- 工具执行了一半进程崩溃，如何判断是否可以重试？
- 谁拥有后台任务，什么时候回收？
- 用户批准的是哪一个精确动作？批准能否被重放？
- 模型被网页中的恶意提示诱导时，哪一层会真正阻止越权？
- 上下文压缩遗漏关键事实时，如何发现并回归测试？
- 多个子 Agent 如何限制并发、递归、Token 和权限？
- 客户端断线期间任务完成，重连后如何收敛？
- 线上一次错误回答，能否还原使用的模型、prompt、工具、上下文、成本和审批？
- 如何灰度发布、监控退化并回滚？

能回答这些问题，并用测试、日志和设计文档给出证据，你就不再只是“会调 LLM API”，而是具备了 Agent 工程师的系统设计基础。
