# Day 16 实践任务

## 任务 1：亲手拆掉进程组保护，看着进程树回收失败

在 `src/tools/process-runner.ts` 里，把 `spawn()` 调用的 `detached: process.platform !== 'win32'` 临时改成 `detached: false`。重新跑：

```bash
pnpm vitest run tests/process-runner.test.ts
```

观察哪几条测试失败（不只是"fork 子进程"那一条——想一想为什么"永不退出"和"取消竞态"那两条也可能受影响）。读一下失败信息，理解 `process.kill(-child.pid, ...)` 在 `detached: false` 时到底出了什么问题。跑完记得改回来，确认全绿。

## 任务 2：给 `run_command` 加一个"stdout+stderr 合计"的输出上限

现在 `stdout` 和 `stderr` 各自独立用同一个 `maxOutputBytes` 做上限——一个命令理论上可以让两者加起来占用两倍的内存（比如疯狂网 stdout 写到上限，同时疯狂往 stderr 写到上限）。

给 `SpawnSpec` 加一个可选的 `maxTotalOutputBytes`，`runProcess()` 内部让 `stdout`/`stderr` 两个 `BoundedCollector` 共享同一份"剩余额度"，而不是各自独立的上限（提示：额度可以是一个在两个 collector 之间共享的可变引用，或者把 `BoundedCollector` 改造成认识"全局剩余额度"这个概念）。补至少两条测试：只有 stdout 写多、只有 stderr 写多、两边交替写，验证合计确实被限制住了。

## 任务 3：一道思考题（不用写代码）

Day19 会正式讲"审批"——某些危险操作执行前要先把"接下来要做什么"的描述展示给用户确认。如果 `run_command` 要接入审批机制，现在这个工具的参数（`command`/`args`/`cwd`/`env`/`stdin`）加起来，够不够构成一段对用户来说"看得懂、能判断要不要批准"的描述？想一想至少一种"参数字面量看起来人畜无害，但实际执行效果对用户来说完全出乎意料"的场景（提示：`command` 本身是一个可执行文件的名字/路径，而不是"这个命令实际会做什么"的语义描述——`node -e "<一段任意代码>"` 就是一个例子，`args` 里的这段代码本身可以做任何事）。

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的任务2测试。
- [ ] 我能解释：为什么 `detached: false` 会让 `process.kill(-child.pid, ...)` 失效，而不只是"杀不到孙进程"这么简单。
- [ ] 我写完了任务3的思考题，给出了一个具体场景，不是空泛地说"看不出来"。
