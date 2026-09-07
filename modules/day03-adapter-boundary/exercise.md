# Day 3 实践任务

## 任务 1：读代码

打开 `mini-harness/src/llm/adapter.ts`，重点看这几处：

- `LlmAdapter` 抽象类——为什么只有一个抽象方法。
- `AdapterRegistry.register()`——为什么冲突检测要先扫一遍全部 `providers` 再决定要不要注册（原子性）。
- `freezeRequest()`/`deepFreeze()`——请求冻结是怎么实现的。
- `classifyFinish()`——"空 completion" 是怎么被判定为可重试错误的。
- `generateWithRetry()`——重试循环、退避延迟、`ABORTED` 永不重试的边界。

## 任务 2：写一个"前 N 次失败、之后成功"的假 adapter

在 `mini-harness/tests/adapter.test.ts` 里（已提供骨架和部分测试，你需要补的部分见任务3-5），实现一个 `FlakyAdapter`：

```ts
class FlakyAdapter extends LlmAdapter {
  private calls = 0
  constructor(private readonly failTimes: number, private readonly failureCode: LlmFailureCode) { super() }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls <= this.failTimes) {
      throw new LlmError({ code: this.failureCode, message: `synthetic failure #${this.calls}` })
    }
    // 成功路径：吐出一条简单的文本消息
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, delta: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  get callCount() { return this.calls }
}
```

用它验证：

1. `failTimes=2`、`failureCode='SERVER_ERROR'`、`policy.maxRetries=3` 时，`generateWithRetry` 应该在第 3 次尝试成功，`result.attempts === 3`，`callCount === 3`。
2. `failTimes=5`（超过 `maxRetries`）时，最终应该以 `finish.kind === 'error'` 收场，`attempts === maxRetries + 1`。
3. `failureCode` 不在 `retryableCodes` 白名单里时（比如 `CONTEXT_WINDOW_EXCEEDED`），应该**第一次失败就直接返回**，不重试，`attempts === 1`。

## 任务 3：验证取消永远不重试

构造一个 `AbortController`，在调用 `generateWithRetry` 之前就 `abort()`，断言：

- `result.finish` 是 `{ kind: 'aborted', failure: { code: 'ABORTED', ... } }`
- `result.attempts === 1`
- 适配器的 `stream()` 根本没被调用过（`callCount === 0`）

## 任务 4：验证请求冻结

```ts
const options: GenerateOptions = { provider: 'fake', model: 'x', messages: [] }
await generateWithRetry(adapter, options)
expect(() => { (options as any).model = 'y' }).toThrow()
```

想一想：如果这里不用 `freezeRequest`，而是约定"大家自觉不要改"，会在什么场景下出问题？把你的答案写在测试文件的注释里。

## 任务 5：验证退避延迟符合指数增长

用 `runtime.sleep` 注入一个记录延迟的假函数（不要真的等待），断言相邻两次重试的延迟大致按 2 倍增长（允许抖动范围内的浮动）。

## 验收自查

- [ ] `pnpm test` 全绿。
- [ ] 我能解释：为什么"provider 说的 retryAfterMs"和"我们要不要重试"是两回事。
- [ ] 我能解释：如果适配器内部自己又做了一层重试，会破坏 `generateWithRetry` 的哪个假设。
