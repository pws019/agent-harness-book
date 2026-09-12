# 白话讲解：投影、查询、标题与 Spill

> 素材来源：DSH `docs/subsystems/session-projection.zh.md`、`session-query.zh.md`、`session-title.zh.md`、`spill.zh.md`。今天没有新的架构决定，是把 Day8 打下的地基（一份仅追加日志）第一次真正拿来"一鱼多吃"。

## 0. 前置知识：同一份数据、多种"视图"，前端你早就在做这件事

如果你写过一个列表页——同一份接口数据，你可能会派生出"完整列表""按分类分组的统计""搜索结果的分页子集"三种不同的视图，但底层数据只请求了一次、存了一份。今天做的三个函数（`projectSummary`/`queryEvents`/`deriveTitle`），就是"同一份 `session.events`，派生出三种完全不同的视图"——跟你在前端"一份 state，多个 selector"是同一个思路，只是这里的 selector 全都是可以独立测试的纯函数。

## 1. `projectSummary`：统计视图

**先说这个函数解决的是什么真实需求**：这不是一个假想场景——`mini-harness/src/cli.ts` 里已经有一个真实命令 `pnpm cli -- inspect-session <path>`（`inspectSession()` 函数），用户想在真正打开、重放整个对话之前，先看一眼"这个 session 大概跑了多少轮、都调用过哪些工具、上次是怎么结束的",不需要把整份日志重放成完整对话。如果为了拿到这几个数字，把日志喂给 `deriveMessages()` 重建出完整的对话文本再去数，等于为了"12 轮、调了8次工具"这几个数字，做了一次远比需要的更贵的计算，还要重新处理所有文本细节（block 组装、消息拼接）——这些细节 `projectSummary` 根本不关心。这就是为什么它要单独作为一个函数存在：**同一份原始事件，按需要派生出"轻"的统计视图，不必每次都走"重"的完整重建**。

```ts
export interface SessionProjection {
  readonly turnCount: number
  readonly toolCallCountByName: Readonly<Record<string, number>>
  readonly lastStopReason: TurnEndReason | undefined
}
```

跟 `deriveMessages` 一样是个 `for...switch` 纯函数，只是关心的事件类型完全不同——`deriveMessages` 只看 `user/message`/`assistant/message`/`tool/result`，`projectSummary` 只看 `turn/start`（计数）、`tool/call`（按名字计数）、`turn/end`（记住最后一次的结束原因）。**同一份 `events`，两个函数各自只挑自己关心的事件类型，互不干扰，也不需要互相知道对方的存在**——这正是"仅追加日志支持多视图共享同一份真相"这条 Day8 就讲过的价值，今天第一次真正兑现：`deriveMessages` 和 `projectSummary` 不可能对同一份历史给出互相矛盾的答案，因为它们读的是同一个只增不减的数组。

## 2. `queryEvents`：为什么按 `seq` 分页，不是数组下标

**先说这个函数解决的是什么真实需求**：一个跑了很久的 session，事件日志可能积累到成千上万条。不管是"调试工具想看某一段时间发生了什么"，还是以后 Day23 要做的"客户端断线重连后，只想要断线之后新增的那部分事件，不想把整份历史再传一遍"，都需要一种"只要日志的一部分,还要能稳定地说清楚'从哪接着往下要'"的能力——这就是分页游标要解决的问题，跟你在前端做过的"下拉加载更多""游标分页 API"是同一类需求。

```ts
export function queryEvents(events: readonly SessionEvent[], options: { afterSeq?: number; limit?: number }): readonly SessionEvent[]
```

`{ afterSeq: 10, limit: 20 }` 意思是"给我 seq 严格大于10的、最多20条"。**为什么不直接用数组下标（比如"从第10个开始，取20个"）？**——因为下标只在"这个数组本身不会变"的前提下才稳定。今天看起来 `events` 数组确实不会变（只增不减），但 Day13 压缩之后，`deriveMessages` 的派生结果里旧消息会被摘要替换掉——如果查询接口靠的是"第几个"，压缩前后同一个下标指向的可能是完全不同的东西。`seq` 是写入时就永久烙在事件上的身份，不管以后派生逻辑怎么演进，`seq=17` 永远指向同一条原始事件。**今天用不上这个差异（因为还没做压缩），但选对了游标的类型，Day13 就不用回头重构分页接口。**

## 3. `deriveTitle`：标题要记住"从哪来"，不是只给一个字符串

**先说这个函数解决的是什么真实需求**：这个你其实天天在用——打开 ChatGPT 或者 Claude.ai，左侧栏是一列历史对话，每条不是显示"session-a3f92c1e"这种原始 ID，而是显示一句"帮我看看 auth 模块的调用链"这样的短标题，方便你一眼认出是哪次对话。`deriveTitle` 就是产出这一行短标题的函数——同一份 `session.events`，又一种派生视图。跟 `projectSummary` 一样，它也不是纸上谈兵：`cli.ts` 的 `inspectSession()` 就真的调了它（[cli.ts:129](../../mini-harness/src/cli.ts#L129)），打印出"title: "帮我看看 auth 模块的调用链" (from seq 3)"这样一行。

```ts
export interface SessionTitle {
  readonly title: string
  readonly sourceSeq: number
}
```

摘第一条 `user/message` 的文本当标题，超长就截断加省略号——这部分很直白。容易被忽略的是 `sourceSeq` 这个字段：如果标题函数只返回一个字符串,以后没法回答"这个标题当初是从哪句话摘出来的"（比如用户改了第一句话，标题要不要跟着变？靠什么判断"这还是不是同一个来源"？）。带上 `sourceSeq`，"标题的来源"本身也变成了一条可以核对、可以追溯的记录，而不是一个凭空出现的字符串。

## 4. Spill：跟 Day4 `search_text` 截断是同一个问题，换了一种解法

回忆 Day4：`search_text` 命中太多结果，用"截断 + 报告总数"的策略处理——**内容本身被砍掉一部分**，只是诚实地告诉你砍了多少。今天 Spill 解决的是同一类问题（工具结果太大），但换了一种手法：**内容整个不动，只是搬到别处存起来，主日志里换成一个"去哪能换回完整内容"的引用**。

```ts
export function spillLargeToolResults(
  events: readonly SessionEvent[],
  store: SpillStore,
  maxContentLength: number,
): readonly SessionEvent[]
```

两种策略怎么选，取决于"这份内容有没有可能整个都有用"：`search_text` 的截断策略假设"前50条命中通常足够，不需要整个结果集"；Spill 假设"这条工具结果可能整份都有价值（比如读了一个大文件），只是不该无条件塞进每次发给模型的请求里，需要的时候再取"。**"需要的时候"具体是谁、什么时候会去取回来**：比如模型后续一步突然需要引用这份内容里的某个细节，或者用户在 UI 上点开"查看完整结果"——这时候拿着日志里留的引用去 `SpillStore` 换回完整内容，而不是每次组装请求都无条件带着这份大内容。

**今天故意没做的事**：`spillLargeToolResults` 是一个独立的"日志变换"函数，不是 `Agent`/`Session` 内置的能力——`Agent` 写事件的时候不会自动检查内容长度、自动 spill。这是 YAGNI：目前还没有一个真实场景需要"写入的同时就自动 spill"，先证明"引用和内容分离"这个机制本身是对的（可以单独测试、单独验证"换得回来"），比直接嵌进 `Agent.appendEvent()` 里更安全。如果哪天真的需要实时生效，再考虑往那层接。

## 一句话总结

今天没有引入任何新的架构决定，纯粹是"同一份 Day8 打下的日志，能派生出多少种有用的东西"——统计视图、稳定分页、可追溯标题、按需换回的大内容。这几个函数之所以能轻松地、独立地加进来，是因为 `Session` 从设计第一天起就只做一件事（仅追加 + 保证不变式），"怎么消费这份日志"完全留给了外部的纯函数,不需要 `Session` 自己知道有多少种消费方式存在。
