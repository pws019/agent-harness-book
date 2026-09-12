# Day 10 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. 同一份仅追加日志，可以派生出多种互不干扰的视图**

`deriveMessages`（Day8）和 `projectSummary`（今天）读的是同一份 `events`，各自只挑自己关心的事件类型，互不干扰、不需要互相知道对方存在——两者不可能对同一份历史给出互相矛盾的答案，因为读的是同一个只增不减的数组。这不是理论，`cli.ts` 的 `inspectSession()` 命令就真的同时调用了 `projectSummary`/`deriveTitle` 来打印概览，不需要走 `deriveMessages()` 那条"重建完整对话"的贵路径。

**2. 为什么分页要用 `seq` 游标而不是数组下标**

数组下标只在"这个数组本身不会变"的前提下才稳定。今天看起来 `events` 数组确实只增不减，但 Day13 压缩之后，`deriveMessages` 的派生结果里旧消息会被摘要替换掉——如果查询接口靠下标，压缩前后同一个下标指向的东西会变。`seq` 是写入时永久烙在事件上的身份，不管派生逻辑怎么演进都不变。今天用不上这个差异，但选对了游标类型，Day13 不用回头重构分页接口。

**3. Spill 和 Day4 `search_text` 截断解决的是同一类问题，适用场景不同**

两者都是"结果太大，不能无条件塞给模型"，但选择不同手法：`search_text` 假设"前50条命中通常足够"，直接截断内容本身、诚实报告总数；Spill 假设"这条工具结果可能整份都有价值（比如读了一个大文件）"，内容整个不动、搬到别处存起来，主日志里换成一个可以按需换回来的引用。判断该用哪种,看"这份内容有没有可能整个都有用"。

## 验收自查

**`projectSummary`、`queryEvents`、`deriveTitle`、`deriveMessages` 各自关心哪些字段/事件类型**：

| 函数 | 关心的事件类型 | 不关心的 |
|---|---|---|
| `deriveMessages` | `user/message`/`assistant/message`/`tool/result`（surface 事件） | `turn/*`/`step/*`/`tool/call` 边界标记 |
| `projectSummary` | `turn/start`（计数）、`tool/call`（按名字+总数计数）、`turn/end`（记最后结束原因） | 消息内容本身、`user/message`/`assistant/message` |
| `queryEvents` | 不看事件类型，只按 `seq` 过滤/分页，对所有事件类型一视同仁 | （无差别对待，不解读 payload） |
| `deriveTitle` | 第一条 `user/message` 的文本 | 除第一条之外的所有事件 |

四个函数对同一份 `events` 各取所需、互不干扰，这正是"仅追加日志支持多视图共享同一份真相"这条 Day8 讲过的价值第一次真正兑现。
