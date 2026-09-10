# Day 13・上下文窗口与压缩

> 阶段：II. 可回放的状态与上下文（收尾）　|　产出：`src/core/compaction.ts`，`deriveMessages()` 支持压缩

## 今天要学会什么

1. 理解为什么"压缩历史"绝不能是"删除事件"——只能是"追加一个声明，改变派生视图，不动原始日志"。
2. 理解 `deriveMessages()` 为什么要从单趟扫描改成两趟扫描，这个改动具体解决了什么问题。
3. 通过一个真实踩到的坑（重复压缩产生重叠区间），理解"独立测试都通过，组合起来才暴露问题"这条本阶段反复出现的教训的最后一次印证。

## 怎么学

1. 读 [study.md](./study.md)——这是阶段二最重的一天，建议分两次读：先读完第1、2节把机制建立起来，隔一会再读第3节的踩坑记录。
2. 读代码：`src/core/session.ts` 里新增的 `collectCompactionRanges`/`deriveMessages` 两趟扫描逻辑，再看 `src/core/compaction.ts`。
3. 跑 `tests/compaction.test.ts`，重点看"重复压缩"和"needle in haystack"两条。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：为什么压缩不能删除原始事件，只能追加声明？
- 你能解释：`deriveMessages()` 为什么要先扫一遍收集区间，再扫第二遍正式派生，而不是像之前几天一样单趟处理？
- 你能解释：`planCompaction` 为什么要排除"已经被压缩过的 seq"，不排除会导致什么问题？
- `pnpm test` 全绿。
