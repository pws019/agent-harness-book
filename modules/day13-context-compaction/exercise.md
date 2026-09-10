# Day 13 实践任务

## 任务 1：读代码，跑一遍"重复压缩"的坑

在 `src/core/compaction.ts` 里，把 `planCompaction` 里排除已压缩 seq 的那行过滤（`.filter((event) => !alreadyCompacted(event.seq))`）临时注释掉，重新跑 `tests/compaction.test.ts`，观察哪条测试失败、失败信息是什么。跑完记得改回来。这能帮你直观理解 study.md 第3节讲的那个坑到底长什么样。

## 任务 2：把"拼接原文"换成一个会丢信息的假摘要器

现在的 `planCompaction` 是"确定性裁剪"——原文一个字都不丢，只是拼起来。写一个新的假摘要函数 `lossySummarize(messages: readonly Message[]): string`，模拟"模型摘要可能会丢东西"——比如只保留每条消息的前10个字符。把 `planCompaction` 改成可以传入一个自定义摘要函数（`options.summarize?: (messages) => string`，不传就用默认的"原文拼接"）。

用这个 `lossySummarize` 重新跑一遍 `tests/compaction.test.ts` 里"needle in a haystack"那条测试——如果 needle 比10个字符长，这条测试应该会失败。**这正是 study.md 第4节说的"这条测试的价值会变得完全不同"**：确定性裁剪下它测不出什么，换成有损摘要之后，它就是真正在保护"关键事实不能丢"这条要求。

## 任务 3：修一个已知但故意没修的坑

`compaction.ts` 里 `applyCompaction()` 的文档注释提到："这三次 append 不是原子的"——如果 `compaction/summary` 那次调用抛出异常（比如构造了一个非法的 Message），前面已经写进去的 `compaction/start` 会永远留在日志里等不到 `compaction/end`，`Session` 会卡在"有一个开着的压缩"这个状态,以后任何新的 `compaction/start` 都会被拒绝（"另一个压缩还开着"）。

1. 写一条测试复现这个问题：构造一个会让 `compaction/summary` 抛异常的场景（提示：让 summary message 包含一个非法 JSON 值，比如塞一个函数进去——绕过 TypeScript 类型检查可以用 `as any`），验证之后 `session.danglingActivity()` 或者尝试再开一次压缩确实会失败。
2. 修复 `applyCompaction`：如果中间任何一步抛出异常，想办法不留下一个"半开着"的压缩状态。（提示：这跟"回滚"有关——`Session` 目前没有提供任何撤销最后几条事件的方法，你可能需要先在纯内存里把三条事件都构造好、都验证过，最后才真正调用 `append()`，或者给 `Session` 加一个新的能力。想清楚你倾向哪种方案，为什么。）

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的任务2、任务3测试。
- [ ] 我能解释：为什么"确定性裁剪"版本的 needle-in-haystack 测试测不出真正的信息丢失风险？
- [ ] 我对任务3"怎么让 applyCompaction 更安全"有一个明确的方案，不只是"应该修"这种空话。
