# Day 8 实践任务

## 任务 1：读代码 + 跑测试

1. 读 `mini-harness/src/core/session.ts` 全文，对照 study.md 第4节那张表，在 `tests/session.test.ts` 里找到每一行对应的测试用例。
2. 跑 `pnpm test -- session`，确认全绿。
3. 故意注释掉 `checkInvariant()` 里 `case 'tool/result'` 那个分支的校验，重新跑测试，看哪几条失败——这能帮你直观理解这条校验具体防住了什么输入（跑完记得改回来）。

## 任务 2：补一条新的不变式

`Session` 目前**没有**校验"`turn` 编号必须严格递增"——你可以用一个更早的 `turn` 数字重新开一个新 turn（只要上一个已经关闭），`append()` 不会拒绝。

1. 在 `checkInvariant()` 里加一条校验：`turn/start` 的 `turn` 必须严格大于上一次见过的 `turn` 编号（用一个新的私有字段记录"目前见过的最大 turn"）。
2. 写至少两条测试：一条验证正常递增能通过，一条验证"用一个比之前小或相等的 turn 重新开 turn"会被拒绝。
3. 想一想：这条校验放在 `Session` 内部，还是应该交给"调用 `append('turn/start', ...)` 的那一层"（未来的 `Agent`）自己保证？两种做法各自的权衡是什么？

## 任务 3：补一个 `deriveMessages` 场景

`tests/session.test.ts` 里 `deriveMessages` 的测试目前没覆盖"一个 turn 中途被取消，只跑了一半"这种情况——比如：`turn/start` → `step/start` → `user/message` → 直接 `turn/end({kind:'cancelled'})`，中间没有任何 `assistant/message`。

**注意**：这个序列**没法**通过顺序调用 `session.append()` 产生出来——`step/start` 之后 `step` 还开着，直接 `turn/end` 会被 `checkInvariant()` 拒绝（"while step 1 is still open"），你会先撞上 `SessionAppendError`，走不到 `deriveMessages()` 那一步。这是有意的：真正要测的不是"`Session` 会不会走到这个状态"（它永远不会自己走到——这正是 Day9 `closeDanglingActivity` 存在的原因，它会先补 `step/end` 再写 `turn/end`），而是"`deriveMessages()` 自己完全不做校验，只信任传给它的输入"这个设计事实。所以任务是：**不经过 `session.append()`，直接手写一个 `SessionEvent[]` 数组字面量**（自己填 `seq`/`time`），包含这个"不完整"的序列，直接调用 `deriveMessages(events)`。

写一条测试验证：给定这样一份手写的事件数组，`deriveMessages()` 应该只返回那条 `user/message` 对应的消息，不会因为缺少配对的 `assistant/message`、也不会因为这份数据"不可能被 `Session` 自己合法生成"而抛异常或者返回奇怪的结果。

## 任务 4（进阶，为 Day9 预习，不强制）

试着把 `Agent`（`agent-handle.ts`）内部的 `history: Message[]` 字段，改成一个私有 `Session` 实例 + 一个 `get history()` 的派生 getter（`deriveMessages(this.session.events)`）。你会发现这个改动没那么容易顺畅完成——`runTurn()` 目前的签名是直接接收并 `.push()` 一个可变的 `Message[]` 数组，一旦 `history` 变成"每次读都重新计算"的 getter，`runTurn()` 就没法再对它 `.push()` 了。

不需要真的改完（这是 Day9 的工作），但花 15-20 分钟想一想：`runTurn()` 的签名大概需要变成什么样，才能既往 `Session` 里写事件，又不需要一次性推翻 Day5-7 写好的所有测试？把你的思路写下来，Day9 我们会正式做这件事。

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的任务2、任务3测试。
- [ ] 我能解释：为什么 `deriveMessages()` 不需要自己再校验一遍"这条日志合不合法"？
- [ ] 我对任务4的"`runTurn` 签名要怎么改"有一个初步想法（不需要写代码，口头/笔记形式即可）。
