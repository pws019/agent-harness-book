# Day 13 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. 为什么"压缩历史"绝不能是"删除事件"**

Day8 建立的核心原则是"仅追加日志是唯一真源"，删除历史事件意味着这份日志不再能诚实回答"这段对话到底发生过什么"——以后想审计、想回放、想排查"模型为什么这么回答"，缺的那段历史永远找不回来。解法是原始事件一条都不删，只在派生"给模型看的历史"这一步，用一条摘要替换掉一段原始事件（`compaction/start`/`compaction/summary`/`compaction/end` 三个新事件，只追加不改写）。日志本身始终完整，变短的只是喂给模型的那个视图。

**2. `deriveMessages()` 为什么要从单趟扫描改成两趟扫描**

压缩事件永远追加在日志末尾，但它要替换的是日志前面的一段内容。如果还是"从头到尾扫一遍、边扫边决定要不要塞消息"，扫到前面那些本该被压缩掉的消息时，压缩声明还没出现在后面——单趟扫描的信息不够。解法：先完整扫一遍收集"哪些 `(fromSeq, toSeq)` 区间最终被声明压缩了、摘要是什么"（`collectCompactionRanges()`），再走第二趟正式派生，每碰到一条 surface 事件先查它的 `seq` 是否落在已收集的区间里。

**3. 重复压缩产生重叠区间的坑**

第一版 `planCompaction` 只看"所有 surface 事件"，不知道哪些已经被压缩过——第二次调用时把已经被第一次压缩覆盖过的事件又当成候选，算出的新区间 `fromSeq` 恰好跟第一次一样（都是"最早那条事件"）。`deriveMessages` 判断"这段区间的摘要有没有插过"用的是 `emittedRangeStarts.has(range.fromSeq)`，两个区间共用同一个 `fromSeq`，第二个摘要被误判成"已经插过了"直接消失。修复：`planCompaction` 先调用 `collectCompactionRanges()` 排除已经被压缩覆盖的 seq，只在还没被压缩过的 surface 事件里挑。这是"两个各自看起来正确的函数拼在一起才暴露问题"这条本阶段反复出现的教训的最后一次印证——独立测试 `planCompaction`（只压缩一次）和独立测试 `deriveMessages`（只处理一个区间）都不会暴露，只有"连续压缩两次、再派生一次"这种跨函数调用的场景才会。

## 验收自查

**为什么"确定性裁剪"版本的 needle-in-haystack 测试测不出真正的信息丢失风险**：DSH 原文用这类测试验证**模型摘要**（真的调一次模型总结长历史）有没有把关键事实弄丢——模型摘要是有损的，可能把不重要和重要的内容一起丢掉。我们的 `planCompaction` 只做了"确定性裁剪"这一半（直接把原文文本拼起来当摘要，不调用任何模型），天然不会丢任何文字信息——所以这条测试对我们来说更像"验证接线正确"（压缩机制本身有没有把消息搞丢），而不是"验证摘要质量"。一旦换成真正做有损压缩的摘要函数，这条测试的意义会完全不同——它会在摘要函数把关键信息弄丢的那一刻立刻报红。测试本身没变，但换实现之后价值完全不同，这也是"先写测试锁定预期行为"值得在功能还很简单时就做的原因。

**任务3"怎么让 `applyCompaction` 更安全"的方案**：`applyCompaction()` 内部要连续 `append()` 三条事件（`compaction/start`→`compaction/summary`→`compaction/end`），这三次调用不是原子的——`Session` 三条校验规则里，唯二依赖状态机的是 `compaction/start`/`compaction/end`（只看"有没有已开着的压缩"），**唯一可能因为"数据本身不合法"而失败的是 `compaction/summary`**（`isJsonValue` 校验 `Message`）。如果这一步抛异常，前面已经写进去的 `compaction/start` 永远等不到收尾，`Session` 会卡在"有个压缩开着"，以后任何新压缩都会被拒绝。

考虑过两种修法：①在 `applyCompaction` 里先校验、再落地；②教 `Session`/`danglingActivity()` 认识"半开的压缩"这种新的挂起状态，像处理挂起的 turn/step 那样自动补救。选了①，已经实现（[compaction.ts](../../mini-harness/src/core/compaction.ts)）：

```ts
export function applyCompaction(session: Session, plan: CompactionPlan): void {
  if (!isJsonValue(plan.summary)) {
    throw new SessionAppendError('compaction summary 不是无损 JSON，拒绝开始一次注定完成不了的压缩')
  }
  session.append('compaction/start', { fromSeq: plan.fromSeq, toSeq: plan.toSeq })
  session.append('compaction/summary', { message: plan.summary })
  session.append('compaction/end', {})
}
```

`isJsonValue` 是 `session.ts` 已经导出的纯函数，`Session.append()` 内部本来就会用它校验——只是把这次检查**提前到任何一次 `append()` 被调用之前**做一遍。既然三次 append 里唯一的风险点已经被单独挑出来、提前挡住，这条路径上"半开压缩"这个状态就永远不会被制造出来，不需要给 `Session` 添加撤销/回滚能力。

**为什么不选②**：②更通用（不管是谁、通过什么路径导致压缩卡住都能兜住,呼应 Day6"显式建模,不能靠调用方自己小心"），但 `session.append('compaction/start', ...)` 目前**只有 `applyCompaction` 这一个调用方**——不像 Day9 那个 sink 转发的坑（当时确实有两条独立路径都会走到 `append()`，"调用方自己小心"才真正靠不住）。只有一个入口时，把校验放在这个唯一入口最前面，防护力跟教 `Session` 通用兜底是等价的，复杂度却低得多——属于"以后如果出现第二个调用方,才值得认真考虑"的备选,今天不做。[compaction.test.ts](../../mini-harness/tests/compaction.test.ts) 里补了一条测试：构造一个塞了函数进去的非法 `summary`（绕过 TS 类型检查），验证 `applyCompaction` 会在写任何东西之前就抛错，且之后紧接着用合法的 plan 还能正常压缩成功（证明没有留下"另一个压缩还开着"的残留状态）。
