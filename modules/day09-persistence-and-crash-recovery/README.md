# Day 9・持久化、flush 与崩溃恢复

> 阶段：II. 可回放的状态与上下文　|　产出：`src/core/persistence.ts`，`agent-handle.ts` 接入 `Session`

## 今天要学会什么

1. 理解为什么把 `Session` 接进 `Agent` 不需要改 `runTurn()`——翻译层应该放在哪一层，为什么。
2. 理解"仅追加日志"天然的崩溃恢复语义：最后一行损坏 vs 中间一行损坏，为什么要区别对待。
3. 理解一个 turn 异常终止（取消/预算耗尽/错误）时，Session 的开闭配对不变式怎么被正确地收尾，而不是被打破或者绕过。
4. 通过一个真实踩到的坑（收尾事件漏转发进持久化 store），体会"集成测试才能发现的缝隙"这条本课程反复出现的教训。

## 怎么学

1. 读 [study.md](./study.md)——今天的前置知识类比是你大概率写过的 `localStorage` 草稿保存。
2. 读代码：先看 `src/core/agent-handle.ts` 里新的 `drain()`/`translateLoopEvent()`/`appendEvent()`，再看 `src/core/persistence.ts`。
3. 跑测试，按顺序读四个新增测试文件，体会覆盖范围怎么从"单元"逐渐扩大到"集成"：
   - `tests/session.test.ts`（新增的 `danglingActivity`/`restoreFrom`/`closeDanglingActivity` 部分）
   - `tests/session-integration.test.ts`——验证 `Agent.history` 真的是从 `sessionEvents` 派生的
   - `tests/persistence.test.ts`——`JsonlSessionStore` 的崩溃恢复语义，纯粹测持久化层
   - `tests/persistence-integration.test.ts`——`Agent` + 持久化 + 恢复，端到端
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能画出（口头或手绘）`AgentLoopEvent` 到 `SessionEvent` 的翻译表，不看 study.md。
- 你能解释：为什么 `runTurn()`/`agent-loop.test.ts` 今天一行都没有改？如果非要在 `runTurn()` 内部直接写 `Session`，会带来什么问题？
- 你能解释：`load()` 遇到最后一行损坏和中间一行损坏，为什么要区别对待？
- `pnpm test` 全绿（新增 4 个测试文件）。
