# Day 22 实践任务

## 任务 1：亲手验证幂等 key 真的防住了重复执行

在 `src/server/http-server.ts` 里，把幂等分支的判断逻辑改成"反过来"的错误版本——先调用 `registry.sendMessage()`，再检查这个 key 是不是已经用过：

```ts
if (idempotencyKey) {
  const turnNumber = registry.sendMessage(sessionId, textToMessage(body.text))
  const response = { turnNumber }
  if (!idempotency.claim(idempotencyKey)) {
    // 已经用过了……但已经晚了，sendMessage() 已经执行过
  }
  idempotency.complete(idempotencyKey, response)
  sendJson(res, 202, response)
  return
}
```

重新跑：

```bash
pnpm vitest run tests/http-server.test.ts
```

确认"两个并发请求同一个 key"那条测试失败——`b1.turnNumber` 和 `b2.turnNumber` 会分别是 `1` 和 `2`，而不是两个都是 `1`。想一想：这个改动没有引入任何明显的逻辑错误（`claim()`/`complete()` 都还在调用），为什么结果会不一样？（提示：`claim()` 现在检查的是"我该不该告诉调用方这是重复的"，但检查这件事本身已经不能阻止 `sendMessage()` 已经执行过这个事实。）跑完记得改回来，确认全绿。

## 任务 2：给 `POST /sessions/:id/cancel` 也接上幂等

现在 `POST /sessions/:id/cancel` 没有走 `IdempotencyStore`。想一想：`cancel()` 本身是不是天然幂等的（连续调用两次 `agent.cancel()` 会不会有问题）？如果是，还需要给它接 `Idempotency-Key` 吗？如果不需要，说出理由；如果你认为某些场景下还是需要，具体是什么场景（提示：想一想 `AgentCancelCause` 这个类型——`cancel()` 的"原因"如果每次都不一样，"幂等"这件事还成立吗）。

## 任务 3：一道思考题（不用写代码）

`study.md` §7 提到 bearer token 只是"有没有钥匙"这一道准入检查，不是真授权模型——任何拿到 token 的调用方能操作任何 session。如果要把它升级成"每个 token 只能操作自己创建的 session"，需要在现有类型/代码里加什么？至少提到：

1. `SessionRegistry` 现在的 `Map<sessionId, SessionEntry>` 需不需要多记一个字段？
2. 检查"这个 token 能不能操作这个 session"这一步，应该加在 `checkAuth()` 里,还是应该是一个独立的、在路由分发之后、真正操作 `SessionRegistry` 之前的检查？为什么（提示：`checkAuth()` 现在只拿得到 `req`，还不知道这次请求要操作哪个 `sessionId`）。

## 验收自查

- [ ] `pnpm test` 全绿，包括你在任务1里临时改坏又改回来之后的状态。
- [ ] 我能解释：为什么"先执行副作用、再检查幂等 key"这个顺序即使代码逻辑本身没写错，也没法防住重复执行——具体是哪个动作发生得太晚了。
- [ ] 我写完了任务2的判断，给出了具体理由，不是"看情况"。
- [ ] 我写完了任务3的设计方向，明确说了要不要改 `SessionEntry`、检查该放在哪一层。
