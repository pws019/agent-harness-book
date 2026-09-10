# Day 14・里程碑二：可恢复的长会话

> 阶段：II. 可回放的状态与上下文（收尾）　|　产出：`src/cli.ts` 接入持久化 + `inspect-session`/`replay-session`

## 今天要做什么

不读新文档，把 Day8-13 搭好的每一层（事件日志、崩溃恢复、投影、系统提示词、Token 计量、压缩）接进 Day7 的 CLI，然后用一条端到端测试证明"一次真实调查写到磁盘 → 模拟进程被杀 → 用同一个文件重新跑一次"这整条链路真的收敛——这是阶段二的毕业考核，跟 Day7 是同一种性质的收尾。

```bash
cd mini-harness
pnpm cli -- --workspace <你自己的项目路径> --query TODO --session-file /tmp/investigation.jsonl
pnpm cli -- inspect-session /tmp/investigation.jsonl
pnpm cli -- replay-session /tmp/investigation.jsonl
```

再跑一次同样的命令（同一个 `--session-file`），你会看到新的一次调查追加进同一份文件，`inspect-session` 里的 `turns` 会变成 2。

## 这一层是怎么拼起来的

```
CLI (src/cli.ts)
  ├─ --session-file 给了路径？
  │    ├─ 文件不存在 → JsonlSessionStore.create() 建一份新的
  │    └─ 文件已存在 → JsonlSessionStore.open().load()（可能 truncated:true）→ Agent.restore()
  ├─ Agent（Day6 排队/取消 + Day9 事件日志 + Day11 系统提示词 + Day12 token 预算）
  │    └─ deps.sink → 每条事件同步镜像进 JsonlSessionStore.append() → FileRawStore（Day14 新增，真实文件）
  ├─ inspect-session：load() 之后跑 Day10 的 projectSummary()/deriveTitle()，打印概览
  └─ replay-session：load() 之后跑 Day8 的 deriveMessages()，打印完整对话文本
```

## 一个真实踩到的坑：修复"半行崩溃"之后，续写反而把日志弄得更糟

写"模拟进程被杀、然后继续跑"这条集成测试时，第一版直接翻车了：`load()` 正确识别出文件被截断（`truncated: true`），但只是在**内存里**丢弃了那半行垃圾——磁盘上那条没有结尾换行符的损坏行原封不动地留在那。等 `runInvestigation()` 第二次运行、开始往同一个文件里 `appendLine()` 新事件时，新的 JSON 被直接拼在了那条没有换行符的垃圾后面，两条本该独立的行粘成了一整行读不出来的乱码——原本只是"半行损坏"，一续写反而变成了整份日志读不出来。

**修复**：给 `RawStore` 加了一个可选的 `truncateTo(count)`，`JsonlSessionStore.load()` 一旦发现 `truncated: true`，会立刻调它把那条损坏的尾巴从物理文件上真正切掉，让文件在一个干净的边界上结束，后面的 `appendLine()` 才能安全地另起一行。这个坑跟 Day9（`closeDanglingActivity` 没转发进 sink）、Day13（重复压缩产生重叠区间）是同一类教训——**"加载一份可能损坏的日志"和"继续往这份日志里写新内容"分别测都没问题，只有真的把两件事串起来做一遍集成测试才会暴露**。细节看 `mini-harness/CHANGELOG.md` 里 Day14 那一段和 `src/core/persistence.ts` 里 `RawStore.truncateTo` 的文档注释。

## 另一个真实坑：单元测试全绿，手动跑 CLI 却直接报错

上面那个坑是被自动化测试抓到的；这一个是自动化测试**测不出来**的——`inspect-session`/`replay-session` 两个子命令写完、`tests/session-milestone.test.ts` 也全绿之后，手动执行 `pnpm cli -- inspect-session <path>` 却直接报"missing required --query"，一个跟这条命令毫无关系的错误。

**原因**：`pnpm run <script> -- <args>` 里的 `--`，有的 pnpm 版本/配置会把它原样转发给底层命令（不是每次都被"吃掉"），导致 `process.argv` 里第一个元素其实是字符串 `'--'`，不是真正的子命令名 `inspect-session`。`main()` 里判断子命令用的是 `argv[0] === 'inspect-session'`，这时候 `argv[0]` 是 `'--'`，判断失败，直接落到了默认的"发起一次调查"分支，报出一个文不对题的错误。

**为什么测试没测出来**：`tests/session-milestone.test.ts` 直接调用 `runInvestigation(parseArgs([...]))`，完全绕开了 `main()` 和 `process.argv` 这一层——它测的是"给定解析好的参数,调查逻辑对不对",根本没有机会验证"命令行参数真的能被正确解析成这些参数"这件事本身。这是本课程反复出现的另一种"测试盲区"：**单元测试测的是函数签名内部,命令行解析这类"胶水层"代码，只有真的从 shell 里敲一遍命令才能验证**——这也是为什么每天的验收标准里,凡是涉及 CLI 的部分,都建议你亲手跑一遍，不能只看 `pnpm test` 是不是全绿。

**修复**：`main()` 开头先剥掉开头那一个（如果有的话）字面量 `'--'`，再判断子命令。

## 怎么学

1. 读代码：`src/cli.ts` 里新增的 `--session-file`/`inspect-session`/`replay-session` 部分，再看 `src/core/persistence.ts` 里 `FileRawStore` 和新加的 `truncateTo`。
2. 跑 `tests/session-milestone.test.ts`，这是这周的毕业考核测试，端到端跑一次真实调查、模拟崩溃、验证恢复。
3. 做 [exercise.md](./exercise.md)。
4. 回头看一眼 [modules/day08-13-phase2-overview/](../day08-13-phase2-overview/)——仿照 Day0 的写法，给阶段二也画一张全貌地图。

## 阶段门禁（对照原 30 天大纲）

- [x] 日志是唯一真源，`Agent.history` 全程从 `sessionEvents` 派生（Day9）。
- [x] 崩溃恢复、未来版本拒绝、日志损坏均有稳定分类（Day9 `SessionLoadError` 的三种拒绝场景 + Day14 的物理修复）。
- [x] 端到端测试证明"写到磁盘 → 模拟崩溃 → 恢复 → 继续跑"整条链路收敛（`tests/session-milestone.test.ts`）。
- [ ] **你能不看代码，解释清楚"为什么'聊天记录数组 + 每次覆盖 JSON 文件'不足以支撑生产系统"**——这个由你自己在 exercise.md 里写下来。

## 复盘问题（写在你自己的笔记里，不需要提交）

- 阶段二这7天（Day8-14）里，哪些复杂性是"事件溯源"这个模式本身带来的，哪些是"要支持崩溃恢复"这个具体需求带来的？如果只要日志、不要崩溃恢复，能省掉哪些代码？
- Day9（sink 转发漏了)、Day13（压缩区间重叠）、Day14（半行崩溃后续写更糟）——这三个坑有什么共同的模式？如果让你现在重新设计一遍，有没有办法从架构上直接让这类"组合起来才暴露"的坑更难发生？
