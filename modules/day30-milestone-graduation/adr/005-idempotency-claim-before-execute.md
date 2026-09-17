# ADR-005：幂等靠"先占位再执行"，不是"执行完再检查"

**状态**：已采纳（Day22，Day28 延伸到审计场景）

## 背景

网络不可靠——客户端可能因为超时而重试同一个请求。如果"检查这个请求是不是重复的"这一步发生在真正执行副作用**之后**，副作用本身已经发生了两次，检查只是"发现问题"，不是"阻止问题"。

## 决定

`IdempotencyStore.claim(key)`（Day22）是整条链路里第一个碰这个 key 的地方，必须在触发真正副作用之前完成，且拿到 `true` 才允许继续。`AuditingApprovalStore.consume()`（Day28）同理——只有 `inner.consume()` 真正成功（没抛错）才会发出审计记录，一次因为参数不对/已过期而失败的尝试不会被记成"这次消费真的发生过"。

## 后果

**好处**：`tests/http-server.test.ts` 里"两个并发请求同一个 key"那条测试证明了这一点——因为 Node 单线程、`claim()` 到真正执行副作用之间没有任何 `await`，两个几乎同时到达的请求，哪个先被事件循环挑中执行，哪个就会真的拿到 `claim()` 返回 `true`，这个保证不依赖锁，纯粹靠"这段代码是同步的"这个事实。`exercise.md`（Day22 任务1）专门验证过：把顺序反过来（先执行、再检查）即使代码逻辑本身没写错，也会让并发请求各自跑出不同的 `turnNumber`。

**代价**：`IdempotencyStore`/`AuditingApprovalStore` 的内部记录都没有清理机制，会随着请求数量无限增长——这是"先占位"这个模式的一个必然推论：既然每个 key 都要被记住"是不是已经用过"，就不能靠"用完即焚"简化实现，需要专门的 TTL/LRU 淘汰策略，`day22-http-server-and-streaming/exercise.md` 任务4、`day28-telemetry-audit-eval/exercise.md` 任务2 都把这个留成了设计题，不是今天补上的。
