# 阶段四测试索引：Day22-27 各自验证过的边界/故障注入点

这不是新写的测试——是把 Day22-27 各自独立验证过的、跟"平台化与编排"这个阶段主题直接相关的边界条件汇总成一份索引（同一个模式见 `modules/day21-milestone-secure-agent/security-test-index.md`）。写这份索引之前逐条跑过对应的 `pnpm vitest run <file> -t <name>` 确认它们真的存在、真的通过。分组按"防的是哪一类问题"，不按天数——同一天的测试可能分散在不同组里。

## 1. 流式传输的边界（Day22）

| # | 测试 | 防的是什么 |
|---|---|---|
| 1 | `tests/backlog-writer.test.ts:6` | 一个永不 flush 的慢客户端最终会触发积压上限，不依赖真实 OS socket 缓冲区大小这种不确定的东西 |
| 2 | `tests/backlog-writer.test.ts:53` | 溢出之后，写入端被永久放弃——不会在溢出后继续悄悄接受更多数据 |
| 3 | `tests/http-server.test.ts:255` | 真实超过每连接积压上限会收到 `transport-error` 并断开连接，不是内存占用低这种测不准的断言 |
| 4 | `tests/http-server.test.ts:204` | `POST /cancel` 在一次调用真的进行到一半时产生 `cancelled` 终态,不是 `completed` |

## 2. 幂等与准入（Day22）

| # | 测试 | 防的是什么 |
|---|---|---|
| 5 | `tests/idempotency-store.test.ts:5` | 同一个 key 的第一次 `claim()` 成功，之后所有 `claim()` 都失败——防重复提交 |
| 6 | `tests/http-server.test.ts:165` | 两个并发的、带同一个 Idempotency-Key 的 `POST /messages` 只真正调用一次 `Agent.send()` |
| 7 | `tests/http-server.test.ts:229` | 缺失/错误的 bearer token 被拒绝——这只是准入检查，不是授权模型（`README.md` 里诚实记录的边界） |

## 3. 断线重连收敛（Day23）

| # | 测试 | 防的是什么 |
|---|---|---|
| 8 | `tests/client-reconnection.test.ts`（8 个种子，`fault-injecting-transport.ts` 注入缺口/重复/乱序/断线） | `Conversation` 在故障注入之后的最终状态，跟权威来源 `deriveMessages(session.events)`（Day8）完全相等 |
| 9 | `tests/client-reconnection.test.ts:86` | 每次尝试都断线的连接最终放弃，而不是无限重试下去 |
| 10 | `tests/client-reconnection.test.ts:97` | `AbortSignal` 能真正打断重连循环，不是要等到下一次重试才生效 |

## 4. 验证后才能关闭（Day24）

| # | 测试 | 防的是什么 |
|---|---|---|
| 11 | `tests/goal.test.ts:13` | `close()` 只在 `verify()` 真的返回 `true` 时成功 |
| 12 | `tests/goal.test.ts:21` | `verify()` 返回 `false` 时 `close()` 抛错，目标停在 `pending-verification`，不会被悄悄关闭 |
| 13 | `tests/goal.test.ts:41` | 跳过 `markPendingVerification()` 直接从 `open` 调 `close()` 被拒绝——模型不能绕过"先声明完成"这一步 |

## 5. 外部内容标记与降级（Day25）

| # | 测试 | 防的是什么 |
|---|---|---|
| 14 | `tests/web-fetch-tool.test.ts:30` | 一次成功的抓取，返回内容带 `provenance: 'untrusted-external'` 标记 |
| 15 | `tests/web-fetch-tool.test.ts:56` | 一个永不响应的服务器在配置的超时内被报告为 `timeout`，不是无限挂起 |
| 16 | `tests/web-fetch-tool.test.ts:88` | 不在白名单里的 host 在真正发起连接之前就被拒绝——复用 Day18 `CommandPolicy` |
| 17 | `tests/web-fetch-tool.test.ts:104` | policy 求值本身抛异常时 fail-closed 拒绝，跟 `run_command` 同一个纪律 |
| 18 | `tests/semantic-query.test.ts`（`withFallback`） | `TsserverProvider` 查询失败时诚实降级到 `TextSearchFallbackProvider`，不是伪装成"查到了"——这门课第一个刻意的 fail-open 例子 |

## 6. `node:vm` 沙箱纪律（Day25，Day27 直接复用）

| # | 测试 | 防的是什么 |
|---|---|---|
| 19 | `tests/code-runtime.test.ts:11` | `process`/`require` 不是环境里默认能碰到的东西，是真正 `undefined`，不是宿主对象的引用 |
| 20 | `tests/code-runtime.test.ts:17` | 没有显式传进 `bindings` 的东西，脚本里完全够不着 |
| 21 | `tests/code-runtime.test.ts:52` | 沙箱逃逸需要一个宿主 realm 的函数绑定——纯数据绑定本身不启用逃逸（这是 Day27 `agent()`/`parallel()`/`pipeline()`/`phase()` 能安全作为绑定注入的前提） |
| 22 | `tests/workflow.test.ts:77` | `buildWorkflowFromScript()` 跑的脚本同样够不着 `require`——`CodeRuntime` 的白名单纪律原样延续到 Day27 的调用方，不是重新发明一套 |

## 7. 委派边界（Day26，Day27 直接复用）

| # | 测试 | 防的是什么 |
|---|---|---|
| 23 | `tests/subagent.test.ts:66` | 超过 `maxConcurrent` 直接拒绝，不会真的创建出第 N+1 个子 Agent |
| 24 | `tests/subagent.test.ts:90` | 子 Agent 声明的 preset 排名高于父 Agent 的，在真正创建子 Agent 之前就被拒绝——权限不能升级 |
| 25 | `tests/subagent.test.ts:112` | 父 `disposeAll()` 时级联清理每一个还在跑的子 Agent，不留孤儿 |

## 8. 编排层本身（Day27）

| # | 测试 | 防的是什么 |
|---|---|---|
| 26 | `tests/workflow.test.ts:140` | `maxAgents` 在任何子 Agent 真正启动之前就 fail-closed 拒绝——`manager.runningChildCount` 事后验证为 0 |
| 27 | `tests/workflow.test.ts:151` | 一个永不 resolve、完全忽略自己 `AbortSignal` 的卡死子任务，`cancel()` 依然在 200ms 内 resolve——runner 自己的记账不被一个不配合的子任务拖住 |
| 28 | `tests/workflow.test.ts:170` | `forceCancelAfterMs` 超时到了之后，不需要调用方主动 `cancel()`，自己就会把终态定成 `cancelled` |
| 29 | `tests/workflow.test.ts:179` | `cancel()` 和自然完成赛跑，只产生一条终态记录——先跑到的赢，后到的是 no-op |
| 30 | `tests/workflow.test.ts:131` | 引用一个注册表里不存在的 `agentId`，整个运行以 `error` 终态收尾，不是抛出一个未处理的异常炸穿调用方 |
