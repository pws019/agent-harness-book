# Day 22 答案

> 对照 [README.md](./README.md)「今天要学会什么」、[exercise.md](./exercise.md)「验收自查」和其中的思考题逐条作答。

## 今天要学会什么

**1. 为什么"流"必须靠 chunked，`res.write()` 返回 `false`/callback 分别对应什么**

`Content-Length` 要求提前知道整个 body 的字节数,一次持续进行的调查不可能提前知道最终会产生多少事件——`Transfer-Encoding: chunked` 让 body 可以边算边发,不用提前定长。`res.write()` 返回 `false` 字面意思就是"这块数据还没被底层真正接受"（内核发送缓冲区满了）,不是一个需要翻译的抽象概念；`res.write(chunk, callback)` 的 callback 在这块数据真的被"消化"之后才触发,`createBacklogWriter`（`src/server/backlog-writer.ts`）的 backlog 计数减少就发生在这个 callback 里,不是 `write()` 调用本身返回的那一刻。

**2. `terminal`/`transport-error` 为什么不能合并**

`terminal` 是应用层信号——这次连接对应的 turn 真的跑完了（正常/取消/出错）,客户端应该展示最终状态。`transport-error` 是传输层信号——连接本身因为跟 Agent 状态无关的原因（这里是积压超限）被放弃,客户端应该重连,不能当成"任务失败了"去展示。合并成一种"流结束了"会让客户端没法区分这两种完全不同的应对方式。

**3. 幂等 key 为什么要先占位、后执行**

`IdempotencyStore.claim(key)` 必须是整条链路里第一个碰这个 key 的地方,且必须在触发真正副作用（`registry.sendMessage()`）之前完成——这样"重复提交"从根源上只会真正执行一次。两个并发请求不会都拿到"是第一次见到"的判断,是因为 Node 单线程,`claim()` 到 `complete()`/`return` 之间没有 `await`（`http-server.ts:117-131`）,一旦某个请求的同步代码开始执行这一段,不会被另一个请求打断。

**4. 为什么 backlog cap 要拆成一个不碰真实 socket 的纯函数**

真实撑爆操作系统 socket 缓冲区依赖具体平台的缓冲区大小,没法写出确定、跨平台稳定的测试。`createBacklogWriter` 把"要不要判定为超限"这个纯记账逻辑从"真实 IO 什么时候真的发出去"里剥离出来,测试可以传一个"永远不调用 `onFlushed`"的假 `write`,不依赖任何真实网络行为就能确定性地验证超限逻辑生效。

**5. bearer token 和真授权模型的区别**

bearer token 只回答"这个请求有没有钥匙",回答不了"这把钥匙的持有者能不能操作*这一个* session"——任何拿到这个共享 token 的调用方能对任何 session 做任何事,没有"这个 token 对应哪些 session"这层映射。今天没有做,详见任务3。

## 验收自查

**为什么"先执行副作用、再检查幂等 key"没法防住重复执行**：亲手验证过（[exercise.md](./exercise.md) 任务1）——把 `sendMessage()` 挪到 `claim()` 之前之后,`tests/http-server.test.ts` 里"两个并发请求同一个 key"那条测试从 `b1.turnNumber===1 && b2.turnNumber===1` 变成 `b1===1 && b2===2`。原因：`claim()` 这个检查本身没有变模糊或者变错——它依然准确地告诉调用方"这个 key 之前见过",但**检查发生的时间点已经晚于副作用真正发生的时间点**,`sendMessage()` 在两次请求里都被调用了一次,已经造成了两次真实的 `agent.send()`,这时候不管 `claim()` 的返回值多准确,已经没有办法把已经执行过的事情收回来。这也是 §4 讲"占位必须发生在执行之前"的具体验证。

**任务2：`cancel()` 需不需要幂等**：`Agent.cancel()` 本身已经是安全的重复调用——`AgentCancelCause` 的"第一个 cause 获胜"规则（见 `agent-handle.ts` 的文档注释）意味着连续调用两次 `cancel()`,第二次不会覆盖第一次已经记录的原因,也不会产生任何额外的副作用（`this.controller?.abort(cause)` 对一个已经 abort 过的 controller 再调用一次 `abort()` 是 no-op）。所以**不需要**再接一层 `IdempotencyStore`——幂等机制本来就是为了防止"一个只应该发生一次的副作用被触发两次",而 `cancel()` 从设计上就是"发生几次都一样"的操作,给它加幂等 key 只是徒增一层没有必要的状态管理。唯一需要留意的场景（但不改变结论）：如果调用方传的 `cause` 每次都不同,`cancel()` 依然只会记录第一次的 `cause`（"第一个 cause 获胜"），第二次调用的 `cause` 会被静默丢弃——这不是幂等性被破坏,而是"幂等"这个词本来就只承诺"重复调用效果一致",没有承诺"每次调用的参数都会被分别记录"。

**任务3：token 该怎么升级成真授权模型**：

1. `SessionEntry` 需要多记一个字段,比如 `readonly ownerToken: string`——`SessionRegistry.create()` 在创建 session 的时候,把发起这次创建请求所使用的 token 记下来,绑定到这个 session 上。
2. 检查"这个 token 能不能操作这个 session"不应该放进 `checkAuth()`——`checkAuth()` 在路由分发**之前**就被调用（`handleRequest()` 的第一行,`http-server.ts:93`）,这时候还没解析出这次请求要操作哪个 `sessionId`（`segments`/`sessionId` 是后面才算出来的）,`checkAuth()` 现在的签名 `(req, res) => boolean` 根本拿不到这个信息。正确的位置是一个新的、独立的检查——在路由分发确定了 `sessionId` 之后、真正调用 `SessionRegistry` 上任何一个操作方法之前,比较"这次请求带的 token"和"`SessionRegistry.get(sessionId)` 对应的 `ownerToken`",不匹配就返回 403。这跟"鉴权"（你是谁）和"授权"（你能不能对这个具体资源做这件事）是两个不同阶段的检查是同一个道理——`checkAuth()` 只回答第一个问题,第二个问题天然依赖"知道这次请求的目标是谁",不可能提前到路由分发之前完成。

**任务4：`IdempotencyStore` 该怎么防止无限增长**

1. **TTL 而不是数量上限,作为主要淘汰维度**。判断标准看提示那句话："现实中客户端最多可能隔多久重试一次同一个请求"和"服务器愿意为这件事付出多大内存代价",哪个更容易估计——这两个维度对"能不能估计准"是不对等的。重试窗口（TTL 该设多久）是一个业务上界,通常有具体依据（客户端库的重试策略,比如"最多重试 30 秒"）,TTL 设得比这个窗口宽松一点（比如 5 分钟）就能给出一个明确保证："同一个 key 在这个窗口内绝不会导致副作用执行两次"。数量上限做不到这一点——它不是一个跟"这一个 key 该活多久"直接相关的量,而是跟"同一时刻有多少个**不相关**的 key 在竞争同一张表"绑在一起。如果用 LRU 按数量淘汰,一个客户端还在自己重试窗口内、完全没过期的合法重试,可能因为同一时间段涌入了一堆不相关的其它请求被挤出容量上限而被清掉——这时候如果这个客户端真的重试了,`claim()` 会把它当成全新的 key,副作用被重新执行一次,`IdempotencyStore` 存在的意义（防止重复执行）反而被自己的清理机制破坏了。所以设计上：TTL 是主要淘汰维度,数量上限最多作为防御性兜底（防止 TTL 配错或者遭遇异常流量),不该反过来用数量替代 TTL 作为主要判断依据。

   类型签名大致长这样（在原有 `IdempotencyEntry` 基础上多记一个时间戳）：

   ```ts
   export type IdempotencyEntry<Response> =
     | { readonly status: 'in-flight'; readonly expiresAt: number }
     | { readonly status: 'completed'; readonly response: Response; readonly expiresAt: number }
   // expiresAt 在 claim() 的时候算好：Date.now() + ttlMs
   ```

   核心判断逻辑：

   ```ts
   private isExpired(entry: IdempotencyEntry<Response>, now: number): boolean {
     return now > entry.expiresAt
   }
   ```

2. **惰性清理，不用独立的 `setInterval`**。两种方式的代价不对称：`setInterval` 是一个只要进程活着就会一直触发的后台任务,哪怕服务器完全没收到任何新请求——具体到 Node 的后果是,一个没调用 `.unref()` 的 `setInterval` 会阻止进程自然退出,而且这个代码库里 `http-server.ts:213` 已经有一个 `server.on('close', ...)` 收尾钩子,如果加一个 `setInterval` 做清理,必须记得在同一个地方配一个 `clearInterval()`,不然每次 `server.close()` 之后测试/进程会因为这个定时器挂着退不出去。惰性清理（每次 `claim()`/`get()` 顺手检查"当前访问的这个 key 是否已过期,过期就先删了再判断"）不需要考虑这个问题,代价只是：如果服务器长时间没有任何请求,过期记录会一直占着内存,直到下一次任何请求进来才会被顺便清掉。幂等 key 的 TTL 本来就是分钟级别,不是小时/天级别,这点内存代价可以接受,不需要为了这个额外维护一个定时器和对应的收尾逻辑。

3. **不是同一类问题,不能直接照抄 `createBacklogWriter` 的机制**。`createBacklogWriter` 的计数器自带归零信号——`write()` 让它 `+= byteLength`,`onFlushed` 回调让它 `-= byteLength`（`backlog-writer.ts:29-32`),一次写入和它对应的"写完了"是配对的,数字会自己回落到 0,不需要额外的、独立的淘汰逻辑,而且它的生命周期跟一条具体连接绑定——连接关闭,这个计数器（连同整个闭包）自然消失,不需要谁去主动清理。`IdempotencyStore` 完全没有这种配对信号——一个 entry 变成 `completed` 状态恰恰是它必须继续留着的理由（这样晚到的重复请求才能读到正确结果）,"这次操作做完了"这个信号在这里不能触发清理,反而是不清理的原因;它的生命周期也跨越整个服务器进程、由无数个不同客户端的 key 共同决定,没有一个像"连接关闭"那样自然的整体重置时机。换句话说：`createBacklogWriter` 的清理是内建在它核心逻辑里、免费拿到的;`IdempotencyStore` 的清理必须是一套完全独立于它核心逻辑之外、专门为了"记录该在什么时候死"而追加的机制——这是比"一个活得短一个活得长"更根本的原因。
