# Day 14 实践任务

## 任务 1：跑起来，指向你自己的项目

```bash
cd mini-harness
pnpm cli -- --workspace <你自己某个项目的路径> --goal "look for TODO markers" --query TODO --session-file /tmp/my-investigation.jsonl
pnpm cli -- inspect-session /tmp/my-investigation.jsonl
pnpm cli -- replay-session /tmp/my-investigation.jsonl
```

再跑一次同样的第一条命令（同一个 `--session-file`），观察 `inspect-session` 的 `turns` 字段变化，确认历史确实是累积的。

## 任务 2：亲手复现 Day14 的那个坑

在 `src/core/persistence.ts` 里，把 `JsonlSessionStore.load()` 里 `if (truncated) { this.raw.truncateTo?.(...) }` 这几行临时注释掉，重新跑 `tests/session-milestone.test.ts`。观察第二条测试怎么失败、失败信息是什么样的乱码。跑完记得改回来，确认测试恢复全绿。

## 任务 3：给 `inspect-session` 加一条信息

现在 `inspect-session` 打印的是 `turnCount`/`lastStopReason`/`toolCallCountByName`。加一行：如果最后一个 `turn/end` 的 `reason` 是 `cancelled`，额外打印一句提示——"这份会话上一次是被中断的（可能是进程崩溃），最新一轮调查已经补上了"。需要用到 Day9 的 `closeDanglingActivity` 留下的痕迹（提示：中断产生的 `turn/end` 事件长什么样，跟正常完成的 `turn/end` 怎么区分）。

## 任务 4（毕业问答，写在自己的笔记里）

不需要写代码，用你自己的话回答——如果面试官问你："为什么不能就用一个数组存聊天记录，每次要保存的时候整个覆盖写一个 JSON 文件？"，结合这七天学到的东西，你会怎么回答？至少提到：

1. 进程在"整个覆盖写"这个动作中途被杀会发生什么（对比"仅追加"的行为）。
2. 如果要支持"同时给一个统计面板、一个调查工具看同一份历史"，两种方案分别要付出什么代价。
3. 如果历史很长需要压缩，"覆盖写"方案怎么保证压缩失败时不会把原始数据弄丢。

## 验收自查

- [ ] `pnpm test` 全绿，包括 `tests/session-milestone.test.ts`。
- [ ] 我能不看代码，把 Day14 README 里"半行崩溃后续写更糟"那个坑的成因和修复方式讲一遍。
- [ ] 我写完了任务4的毕业问答，不是空话，每一条都有具体机制支撑。
