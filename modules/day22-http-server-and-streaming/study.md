# 白话讲解：HTTP Server、API Gateway 与流式协议

> 素材来源：DSH `docs/subsystems/web-server.zh.md`、`docs/subsystems/api-gateway.zh.md`。今天第一次让 Agent 能被"外面"访问——不再是同一个进程里直接 `new Agent()`，而是通过真实的网络连接。这是阶段四"平台化"的第一天，也是本课程第一次要求你从零理解 HTTP/TCP 层面的机制,不能只学"怎么调用一个流式 API"这个上层抽象。

## 0. 前置知识：TCP、HTTP、chunked 编码、backpressure——四个后端常识

前端代码通常只跟 `fetch()`/`EventSource` 这类高层 API 打交道，这些 API 已经把下面几层机制包好了。今天要自己实现服务端,这些机制必须真正理解。

**TCP 是什么**：一个 TCP 连接是操作系统在两台机器（或者同一台机器的两个进程）之间维护的一条**有序字节流**——你往这头写的字节,另一头会按写入的顺序收到,不会乱序、不会丢（网络层出问题会自动重传，直到连接彻底断开为止）。但 TCP 只保证"字节顺序对",不知道"这些字节应该在哪里被切成一条条有意义的消息"——那是更上层协议的事。

**HTTP 请求/响应是怎么在 TCP 字节流上"分帧"的**：一个 HTTP 响应的开头是一段纯文本的"头部"（状态行 + 一堆 `Key: Value` 头），头部结束的标志是一个空行（`\r\n\r\n`）。头部之后是"body"——body 有多长，必须提前用某种方式告诉对方,不然对方不知道该在哪里停止读取（会一直等下去，或者把下一个响应的头部也当成这个响应的 body 读进去）。最常见的两种"告诉对方 body 有多长"的方式：① `Content-Length: N`——提前算好总字节数，写死在头部（这是今天代码里 `sendJson()` 用的方式，见 [http-server.ts:50](../../mini-harness/src/server/http-server.ts#L50)）；② `Transfer-Encoding: chunked`——不提前说总长度,而是把 body 拆成一块一块（chunk）发,每一块前面加一个十六进制的"这一块有多少字节",最后用一个"长度是 0"的块表示"body 结束了"。

**为什么"流"必须靠 chunked，不是靠 `Content-Length`**：`Content-Length` 要求你在写第一个字节之前，就已经知道整个 body 会有多少字节——这跟"流"的本质矛盾：一次调查可能要跑很久，你不可能提前知道最终会产生多少字节的事件。`Transfer-Encoding: chunked`（[http-server.ts:168](../../mini-harness/src/server/http-server.ts#L168) 里 `res.writeHead(200, {'Transfer-Encoding': 'chunked', ...})`）解决的正是这个问题：body 不用提前定长，可以边算边发，每次 `res.write()` 就是发一个新的 chunk——`GET /sessions/:id/events` 这个接口的响应就是一条会持续增长的 chunked body,不是一次性发完就关闭的普通响应。

**Backpressure（背压）是什么，为什么它不是一个抽象概念**：往一个 TCP 连接的"写端"写数据时,数据不是直接飞到对方手里的——先进操作系统的**内核发送缓冲区**,由内核负责真正通过网络发出去、等对方 ACK。如果接收方一直不读（应用层没调用读取 API，或者干脆卡住了），TCP 有一套"接收窗口"机制会让发送方的内核缓冲区也跟着写不进去——内核缓冲区满了以后，Node 的 `res.write(chunk)` 会返回 `false`,这**不是一个需要你翻译成"背压"的抽象警告，`false` 这个布尔值字面意思就是"背压发生了，这块数据还没被真正接受"**。`res.write(chunk, callback)` 的第二个参数会在这块数据真的被系统"消化掉"（不代表对方已经读走，只代表这一层缓冲区腾出了空间）之后才触发——今天的 `createBacklogWriter`（[backlog-writer.ts](../../mini-harness/src/server/backlog-writer.ts)）就是靠这个 callback 来判断"这块数据到底有没有真的发出去"，不是靠 `write()` 调用本身"返回了"就当成写完了。

## 1. 今天要加的是什么能力，为什么会有一整套新概念冒出来

前 21 天，`Agent` 只能被同一个 Node 进程里的代码直接持有和调用（`cli.ts` 里 `new Agent(deps)`）。今天让它能被**另一个进程/另一台机器**通过网络访问——这个跨越带来了三类前 21 天完全不存在的新问题：① 网络连接会断，断了要能续上，续上的时候该重发多少数据；② 同一个操作可能因为客户端超时重试而被"意外提交两次"，不能真的执行两次；③ 一个连上来的客户端可能不读数据（不管是恶意的还是自己卡住了），服务器不能因为一个不配合的客户端而无限攒数据、把自己内存耗尽。

**今天新增的四个文件、各自是什么、解决上面哪个问题、后面哪一节细讲**——在看下一节的调用链图之前先认识这几个名字，不然图上一冒出来会不知道它们是什么：

| 文件 | 核心导出 | 是什么 | 解决哪个问题 | 哪一节细讲 |
|---|---|---|---|---|
| `wire-protocol.ts` | `StreamEnvelope` | 流式响应里每条消息的线格式（四选一判别联合），客户端和服务端共用的约定 | ① 断线重连——靠这套约定区分"任务做完了"和"连接坏了" | 第3节 |
| `session-registry.ts` | `SessionRegistry` | `Map<sessionId, Agent>` 的生命周期所有者——创建/查找/操作某个 session 背后真正的 `Agent`，都要经过它 | 三个问题共同的地基——下面两个部件都要通过它才能碰到真正的 `Agent` | 第5节 |
| `idempotency-store.ts` | `IdempotencyStore` | 记录"这个客户端给的幂等 key 有没有被用过" | ② 重复提交不能真的执行两次 | 第4节 |
| `backlog-writer.ts` | `createBacklogWriter()` | 给一条 `GET /events` 连接记账"写出去但还没被真正消化的字节数" | ③ 慢客户端不能让服务器无限攒内存 | 第6节 |

`http-server.ts` 是唯一同时持有 `SessionRegistry` 和 `IdempotencyStore` 两个实例的地方（[http-server.ts:65-67](../../mini-harness/src/server/http-server.ts#L65-L67)）——这两者互相不知道对方存在，是`http-server.ts` 的路由代码按需协调它们（比如"先问 `IdempotencyStore` 能不能执行，能的话再调 `SessionRegistry` 真正执行"）；`createBacklogWriter()` 则是在 `handleEventsStream()` 内部按连接现造一个，不是一个全局共享的实例。

## 2. 一次 HTTP 调用要经过哪些代码

### 2.0 先从客户端视角搞清楚：这五个接口分别是干嘛的，正常怎么用

在看"某一次调用具体经过哪些代码"之前，先搞清楚一件更基础的事：一个真实客户端（不管是 Day23 的终端 client，还是随便一个 `curl`/前端页面）要跟这个服务器打交道，正常会按什么顺序调用这五个接口、每个接口各自在解决什么问题。

| 接口 | 客户端为什么调它 | 返回/行为 |
|---|---|---|
| `POST /sessions` | "我要开始一次新的调查/对话" | 服务端 `new` 一个全新的 `Agent`，返回一个 `sessionId`——后面四个接口都要带着这个 id |
| `GET /sessions/:id/events?since=<seq>` | "我要实时看这个 session 里发生的一切"——这是一个**长连接**，不是"问一次答一次" | 先发一份到目前为止已经发生过的所有事件（`baseline`），然后只要 session 还在跑，新事件一发生就立刻推过来（`increment`），turn 真正跑完了发一条 `terminal` 然后正常关闭连接 |
| `POST /sessions/:id/messages` | "我要给这个 session 发一句话，让 Agent 开始/继续干活" | 服务端调 `agent.send()`，**返回值本身不含 Agent 的回复**——回复要靠上面 `GET /events` 那条长连接才能实时看到（这一点最容易看反，下面单独讲） |
| `POST /sessions/:id/cancel` | "算了，别跑了"——用户中途反悔 | 服务端调 `agent.cancel()`，效果会作为一条 `turn/end` 事件出现在 `GET /events` 流里（`reason.kind === 'cancelled'`），不是这个 `cancel` 请求自己的响应体里 |
| `GET /sessions/:id` | "我现在只想瞄一眼这个 session 大概跑成什么样了"——不想为了看一眼就开一条长连接 | 一次性返回 `projectSummary()`（Day10）算出来的快照，问完这次 HTTP 请求就结束，不会持续推送 |

**`POST /messages` 不返回 Agent 的回复，这不是疏漏，是这五个接口分成"写"和"读"两条线的必然结果**——`POST /messages` 只负责"把这句话交给 Agent、告诉你它确实收到了并且排到了第几个 turn"（响应体是 `{turnNumber}`），Agent 真正想什么、调用了什么工具、最终回复了什么，这些全部通过 `GET /events` 那条持续存在的连接推送出来。这跟前端"发一个 mutation 请求,UI 的更新靠另一条订阅/轮询拿到"是同一个形状,只是这里的"订阅"具体落地成了一条 chunked HTTP 连接。

**一次典型的客户端使用顺序**：

```
客户端                                      服务端
  │
  ├─ POST /sessions ─────────────────────▶  新建 Agent，返回 sessionId
  │◀───────────────── { sessionId } ─────
  │
  ├─ GET /sessions/:id/events (长连接打开，一直挂着不断) ──▶
  │◀── { kind: 'baseline', snapshot: [] } ──（这个 session 还没发生过任何事，snapshot 是空的）
  │
  ├─ POST /sessions/:id/messages { text: '...' } ────────▶  agent.send(...)
  │◀────────────────── { turnNumber: 0 } ─────────────────  （这一步不含任何回复内容）
  │
  │◀── { kind: 'increment', event: {...} } ──（Agent 调了第一个工具）  ┐
  │◀── { kind: 'increment', event: {...} } ──（工具结果回来了）        │ 都从上面
  │◀── { kind: 'increment', event: {...} } ──（模型给出最终回复）      │ 那条长连接推过来
  │◀── { kind: 'terminal', reason: 'completed', lastSeq: N } ────────┘  （turn 跑完了,这条连接自己关闭）
  │
  ├─（可选）GET /sessions/:id ────────────▶  一次性看一眼当前状态摘要
  │◀───────────── projectSummary(...) ─────
  │
  ├─（可选，如果还想接着聊）POST /sessions/:id/messages { text: '...' } ──▶ agent.send(...)（开下一个 turn）
  │   ↑ 这时候上一条 GET /events 连接已经因为收到 terminal 而正常关闭了——
  │     要继续看新一轮 turn 的事件，客户端需要重新开一条 GET /events?since=<上次的 lastSeq> 连接
  │
  └─（任意时刻，只要还没收到 terminal）POST /sessions/:id/cancel ──▶  agent.cancel()
      效果不会出现在这次 cancel 请求的响应里，而是作为一条 reason:'cancelled' 的 terminal
      出现在 GET /events 那条连接上——跟上面"POST /messages 不直接返回回复"是同一个道理
```

这张图里有两个容易看反的地方，专门点破：① `GET /sessions/:id/events` 和 `POST /sessions/:id/messages` 是**两条独立的、互不阻塞的连接**——`POST /messages` 的 HTTP 响应几乎立刻就会回来（只是"收到了"），Agent 真正的思考过程需要多久，`POST /messages` 的调用方完全不需要等，实时进展全靠旁边那条已经打开的 `GET /events` 长连接持续推送；② 一条 `GET /events` 连接只服务**一个 turn 的生命周期**——`terminal` 一发出，这条连接就正常关闭了，不是"整个 session 期间只用开一次"，下一个 turn 想继续实时看,客户端要用上一次拿到的 `lastSeq` 重新开一条新的 `GET /events?since=<lastSeq>` 连接（Day23 的 `Conversation`/`runReconnectingStream()` 就是专门处理这个"连接会关闭、要用 seq 接回去"的场景的）。

### 2.1 具体到代码层面，一次 HTTP 调用经过哪些代码

```
客户端 fetch('POST /sessions')
      │
      ▼
http.createServer() 的请求回调（http-server.ts:77）
      │
      ├─ 分配/回显 correlation id（http-server.ts:78-79）
      ▼
handleRequest(req, res)（http-server.ts:92）
      │
      ├─ checkAuth()：没配 bearerToken 直接放行；配了就校验 Authorization 头
      ├─ 按 method + 路径 手写分发（没有用任何路由框架）
      │
      ├─ POST /sessions              → SessionRegistry.create(deps)         ← 新建一个 Agent
      ├─ POST /sessions/:id/messages → IdempotencyStore + SessionRegistry.sendMessage()
      ├─ POST /sessions/:id/cancel   → SessionRegistry.cancel()             ← agent.cancel()
      ├─ GET  /sessions/:id          → projectSummary(agent.sessionEvents)  ← Day10 现成的函数
      └─ GET  /sessions/:id/events   → handleEventsStream()                 ← 本篇重点
                                          │
                                          ├─ registry.subscribe()：挂一个监听器，
                                          │    SessionRegistry 塞进 Agent 的自定义 sink 会
                                          │    把每条新事件转发给它（session-registry.ts:41-45）
                                          ├─ write({kind:'baseline', snapshot})
                                          └─ 每来一条新事件 → write({kind:'increment', event})
                                               → createBacklogWriter 决定这次写有没有超过积压上限
```

## 3. `StreamEnvelope`：四选一，不是"一种消息格式"

原始大纲要求流协议区分 baseline/increment/terminal error/transport error 四种情况。跟 `SessionEvent`/`UserInteractionRequest` 一样的做法：不是共用一个含糊的消息形状让调用方自己猜"这条是什么意思"，是一个封闭联合类型（[wire-protocol.ts:23-27](../../mini-harness/src/server/wire-protocol.ts#L23-L27)），配 `assertNeverEnvelope` 兜底：

```ts
type StreamEnvelope =
  | { kind: 'baseline'; snapshot: readonly SessionEvent[] }
  | { kind: 'increment'; event: SessionEvent }
  | { kind: 'terminal'; reason: 'completed' | 'cancelled' | 'error'; lastSeq: number }
  | { kind: 'transport-error'; message: string }
```

**`terminal` 和 `transport-error` 的区别，真值表**：

| 情况 | 谁的责任 | 客户端该怎么反应 |
|---|---|---|
| `terminal` | 应用层——这次连接对应的 turn 真的跑完了（正常完成/被取消/出错） | 展示对应的最终状态,这个连接的生命周期正常结束 |
| `transport-error` | 传输层——连接本身出了问题（这里是"积压缓冲超限被强制放弃"） | 跟 Agent 状态无关,应该重连（带着最后收到的 seq）,不能当成"任务失败了" |

`increment` 里没有单独的 `seq` 字段——它复用 `event.seq`（Day8 `SessionEvent` 本来就有的那个字段，[wire-protocol.ts](../../mini-harness/src/server/wire-protocol.ts) 没有重新发明一个游标概念），客户端记住收到的最后一个 `seq`，断线重连时带着 `?since=<seq>` 请求 baseline，就能拿到"断线期间漏掉的那一段"（Day23 会真的用到这一点）。

## 4. 为什么幂等 key 要"先占位、后执行"，不是"执行完之后查有没有重复"

`IdempotencyStore`（[idempotency-store.ts](../../mini-harness/src/server/idempotency-store.ts)）只有两个会改变状态的方法：

```ts
claim(key: string): boolean       // 第一次见到这个 key 才返回 true
complete(key: string, response: Response): void
```

路由代码（[http-server.ts:117-132](../../mini-harness/src/server/http-server.ts#L117-L132)）的顺序是：先 `claim()`，**拿到 `true` 才允许调用 `registry.sendMessage()`**（真正触发副作用——`agent.send()`），成功之后才 `complete()` 记录结果。第二次带着同一个 key 来的请求，`claim()` 会返回 `false`，代码**根本不会走到 `sendMessage()` 那一行**，直接把上次记录的结果原样返回。

**为什么这个顺序很重要**：如果反过来——先执行 `sendMessage()`，事后再去检查"这个 key 是不是已经用过了、要不要报错"——那"执行"这件事本身已经发生了两次，检查只是"发现问题",不是"阻止问题"。`claim()` 必须是整条链路里**第一个**碰这个 key 的地方，且必须在触发真正副作用之前完成，这样"重复提交"从根源上就只会真正执行一次。这跟 Day19 `ApprovalStore.consume()` "全部校验通过才真正标记消费"是同一种"状态变更只能发生在正确的那一刻"的纪律，只是这里反过来：`claim()` 要尽量**早**地占位，而 `ApprovalStore.consume()` 要尽量**晚**地标记消费。

**为什么两个并发请求不会都拿到 `true`**：Node 是单线程的——`handleRequest()` 里 `claim()` 到 `complete()` 之间没有任何 `await`（[http-server.ts:118-131](../../mini-harness/src/server/http-server.ts#L118-L131)），也就是说一旦某个请求的处理函数执行到 `claim()`，会一路同步跑到 `complete()`/`return`，中途不会被另一个请求的代码打断——两个几乎同时到达的请求，哪个先被 Node 的事件循环挑中执行，哪个就会真的拿到 `claim()` 返回 `true`，另一个无论多"同时"，只要它的这段同步代码还没轮到，就必然会在 `claim()` 那一行看到 `false`。`tests/http-server.test.ts` 里"两个并发请求"那条测试断言的就是这件事。

## 5. `SessionRegistry`：一层广播转发，不是重新发明持久化

```ts
const agent = new Agent({
  ...deps,
  sink: { append: (event) => { for (const listener of listeners) listener(event) } },
})
```

`Agent` 从 Day9 开始就支持一个可选的 `sink`（`{append(event): void}`）——当时是为了接 `JsonlSessionStore` 做持久化。`SessionRegistry.create()`（[session-registry.ts:36-48](../../mini-harness/src/server/session-registry.ts#L36-L48)）复用了同一个接口，但这次接的不是"写盘"，是"广播给所有正在监听 `GET /events` 的连接"——`SessionSink` 这个接口本身足够通用，不用为"流式转发"专门发明一个新的钩子。这也是为什么它不写盘：今天的服务器演示的是"多个客户端怎么实时看到同一个 session 的进展"，不是"崩溃恢复"（Day9/14 已经讲过），两条能力可以独立接，互不冲突——真要同时做持久化+广播，`sink.append()` 里两件事都做就行，接口不用变。

## 6. `createBacklogWriter`：为什么把它从真实 socket 里拆出来

一个"故意不读数据的慢客户端"要测出来,最直接的办法是真的开一个 socket、真的不读、指望 OS 缓冲区被撑爆——但这依赖具体操作系统的缓冲区大小（不同平台不一样、CI 环境可能又不一样），没法写出一条可靠、跑多少次结果都一样的测试。`createBacklogWriter`（[backlog-writer.ts](../../mini-harness/src/server/backlog-writer.ts)）把"要不要判定为超限"这件事从"真实 IO 什么时候真的把数据发出去"里剥离出来，变成一个纯粹的记账逻辑：

```ts
function createBacklogWriter(options): (envelope: StreamEnvelope) => boolean {
  let backlogBytes = 0
  return (envelope) => {
    // 算 envelope 编码后的字节数，加上去看是不是超过 maxBytes；
    // 没超：backlogBytes += 字节数，调用 options.write(line, onFlushed)，
    //       onFlushed 触发时 backlogBytes -= 字节数（真正被"消化"了才释放）
    // 超了：调用 options.onOverflow()，以后这个 writer 永久返回 false
  }
}
```

`http-server.ts` 用真实的 `res.write(line, onFlushed)` 接它；测试用一个完全受控的假 `write`（比如"永远不调用 `onFlushed`，模拟死活不读的客户端"）就能确定性地验证"超过上限就报错并且不再继续写"——不需要真的撑爆任何操作系统缓冲区，也不需要 `sleep()` 猜时机。这是"把不确定的真实 IO 和确定的判断逻辑分开测"这条原则在网络编程场景下的一次具体应用。

`http-server.ts` 收到 `onOverflow()` 回调时（[http-server.ts:175-184](../../mini-harness/src/server/http-server.ts#L175-L184)），用的是 `res.end(...)` 而不是 `res.destroy()`——先把最后一条 `transport-error` 消息写完、再正常结束这次 HTTP 响应，而不是直接砸断 socket。直接 `destroy()` 会有一个隐蔽的自我矛盾：本来是想告诉客户端"这次连接要被放弃了、你应该重连"，但如果这条诊断消息自己都因为连接被砸断而发不完整，客户端反而收不到这个信号——`end()` 保证 chunked 响应能正常收尾，这条最后的消息真的能被完整送达。

## 7. Bearer token：一道准入检查，不是真授权模型

```ts
if (header === `Bearer ${options.bearerToken}`) return true
```

这不是本课程第一次遇到"故意做得比听起来简陋"的安全机制——跟 Day18 `CommandPolicy` 不做真 OS 沙箱、Day20 `CredentialRef` 不做真密钥轮换是同一类诚实取舍。这里的 token 只回答一个问题："这个请求有没有钥匙"，回答不了"这把钥匙的持有者能不能操作*这一个* session、不能操作*那一个* session"——任何拿到这一个共享 token 的调用方，能对任何 session 做任何事。真正的多用户授权模型需要"这个 token/身份对应哪些 session"这层映射，今天没有做，`answer.md` 里会具体说如果要补上需要什么。

## 一句话总结

今天四个新文件对应的都是"Agent 一旦能被网络访问，会出现哪些进程内调用完全不会遇到的新问题"：`StreamEnvelope` 区分"任务真的做完了"和"连接本身断了"；`IdempotencyStore` 保证"网络不可靠导致的重试"不会变成"重复执行"；`SessionRegistry` 把"多个人可能同时在看同一个 session"这件事用一层广播转发解决,复用 Day9 已经有的 `SessionSink` 接口；`createBacklogWriter` 保证"一个不配合的客户端"不能让服务器为它无限攒内存。四个问题看起来不相关，但都指向同一件事：网络连接是一个"不完全受你控制"的东西，这跟 Day16 讲"子进程一旦启动就不完全受你控制"是同一种警觉，只是这次换成了"连接一旦建立，对方什么时候读、读不读、会不会断，都不由你说了算"。
