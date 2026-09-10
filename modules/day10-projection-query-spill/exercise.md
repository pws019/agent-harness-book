# Day 10 实践任务

## 任务 1：读代码

读 `session-projection.ts`/`spill.ts` 全文，对照 `deriveMessages`（Day8）想一想：这三个新函数和 `deriveMessages` 的相似之处是什么（提示：都只挑自己关心的事件类型，跳过其余类型）。

## 任务 2：给 `projectSummary` 加一个字段

现在的 `SessionProjection` 没有"总共执行了几次工具调用"（不分名字，只要总数）。加一个 `toolCallCount: number` 字段，更新实现和至少一条测试。

## 任务 3：`deriveTitle` 的一个边界情况

如果第一条 `user/message` 的 `blocks` 里只有一个空字符串的 `text` 块（`{ type: 'text', text: '' }`），`deriveTitle` 现在会返回什么？写一条测试确认现在的行为，然后想一想：这个行为是不是你期望的？如果不是，应该怎么改（提示：现在的实现里有一行 `if (text.length === 0) return undefined`，但它只看了第一条消息，如果第二条 `user/message` 才有真正非空的文本呢）？

## 任务 4（进阶）：给 Spill 加一个"换回失败"的诚实提示

`spillLargeToolResults` 生成的占位文本里嵌了 spill id，但如果以后有人调 `store.get(id)` 结果是 `undefined`（比如换了一个新的 store 实例，旧数据没了），调用方目前完全没有办法从占位文本本身判断"这是正常的引用格式，只是内容真的丢了"还是"这段文本本身格式就不对"。

写一个 `resolveSpilledContent(content: string, store: SpillStore): string` 函数：如果 `content` 匹配占位文本的格式，尝试从 `store` 换回真实内容；换不回来就返回一句明确的"这段内容已丢失"提示，而不是原样返回占位文本或者抛异常。

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的测试。
- [ ] 我能解释：`projectSummary`、`queryEvents`、`deriveTitle`、`deriveMessages` 这四个函数，哪些字段/事件类型是它们分别关心的，画一张简单的表格或者口头说出来。
