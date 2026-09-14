# Day 16 答案

> 对照 [README.md](./README.md)「今天要学会什么」、[exercise.md](./exercise.md)「验收自查」和其中的思考题逐条作答。

## 今天要学会什么

**1. 为什么用显式 `argv` 数组，不用一整条 shell 字符串**

如果参数是一整条命令字符串，执行时要交给一个 shell 去解析 `$()`/`|`/`;`/`&&` 这些特殊语法——模型（或者被 prompt injection 影响的模型）只要在参数里塞一段类似 `; rm -rf /` 的文本，shell 就会老实地把它当成"新的一条命令"去执行，这是经典的命令注入，而且没法靠"转义得更仔细"彻底堵死。`spawn(command, args)` 默认不经过 shell，`args` 数组里的每一项原样、逐个传给操作系统的 `execve()`，`;`/`|` 这类字符在这里只是字面字符，不会被解释成命令边界——从根源上排除了这一整类问题，不是靠转义规则去防。

**2. 为什么"有界输出"是"继续读、只是丢弃"，不是"满了就不读了"**

子进程的 `stdout`/`stderr` 是操作系统层面有容量上限的管道：如果没人在另一头读，写满之后子进程的 `write()` 调用会被操作系统阻塞，进程会因此卡死——这才是"输出洪水"真正的危险，不是内存爆掉。`BoundedCollector` 的 `push()` 永远正常触发、永远"消费掉"这一片数据（保证管道那头始终有人在读，子进程不会卡住），只是超过上限之后不再把数据拼进最终字符串里，并标记 `truncated: true`——跟 Day4 `search_text` 的截断策略是同一个原则："永不静默丢弃而不报告"。

**3. `ToolRegistry` 原有超时为什么杀不掉真正的子进程，为什么要杀"进程树"**

Day4 的 `runWithTimeoutAndAbort()` 用 `Promise.race([work, timeoutPromise, abortPromise])`——超时只是让 `timeoutPromise` 先 reject，`work`（也就是 `tool.execute()`）本身没有被取消，只是被晾在一边继续跑。如果 `tool.execute()` 内部真启动了一个操作系统子进程，这次"超时"跟那个子进程毫无关系，子进程会变成一个真正的进程泄漏，永远不会退出。这就是为什么 `run_command` 必须自己用独立的 `setTimeout` 去真正调用 `process.kill()`，不依赖 `ToolRegistry` 那层 race。杀"一个进程"不够是因为子进程可能自己再 fork 出别的进程——只 `kill(child.pid)` 挡不住这些子孙进程变成孤儿继续跑；`spawn(..., { detached: true })` 让子进程成为一个新进程组的组长，`process.kill(-child.pid, 'SIGKILL')`（负 pid）杀的是整个组，子孙进程一起被回收。[process-runner.test.ts](../../mini-harness/tests/process-runner.test.ts) 里"process-tree kill"那条测试用一个会持续写 marker 文件的孙进程验证了这一点：杀掉之后 marker 文件确实不再增长，不是靠猜。

**4. 为什么 `env` 是白名单，不是黑名单**

考虑过三种做法：完整继承宿主进程的 `process.env`（最省事，但宿主进程手里的任何 secret 默认全部可见）；维护一份"危险变量黑名单"过滤（命名约定不可能穷举，漏一个新变量名就等于没防）；默认清空只留 `PATH`，其余必须调用方显式传（选了这个）。默认清空的好处是"申报的范围永远只会跟需要的一样大"，不存在"漏掉一个没想到的危险变量"的风险，因为压根不存在"默认继承"这件事——`PATH` 是唯一例外，因为没有它连基本的可执行文件都找不到，且 `PATH` 本身通常不算敏感信息。

## 验收自查

**`ToolRegistry.execute()` 的 `timeoutMs` 超时之后，正在跑的真实子进程会不会被杀掉**：不会——`ToolRegistry` 的超时机制是 `Promise.race`，赢了只代表外层调用方拿到的 Promise 提前落空，`tool.execute()` 内部真正启动的操作系统进程没有收到任何"该停下了"的通知，会继续独立运行，直到它自己决定退出（如果它本来就不会退出，就会一直泄漏下去）。这正是 `run_command` 必须自己维护一层独立超时管理的原因——`bash-tool.ts` 里注册进 `ToolRegistry` 的 `timeoutMs`（`REGISTRY_TIMEOUT_MS`）只是一道正常情况下不该被触发的安全网,真正杀进程的是 `runProcess()` 内部自己的 `setTimeout`。

**`child.kill()` 和 `process.kill(-child.pid, ...)` 分别能杀掉什么**：`child.kill()`（等价于 `process.kill(child.pid, ...)`）只给 `child.pid` 这一个进程发信号——如果这个进程自己又 fork 了别的进程，那些子孙进程不受影响，会变成孤儿继续跑。`process.kill(-child.pid, ...)`（负的 pid）发给的是**整个进程组**，前提是这个子进程是用 `detached: true` 启动的（成为了新进程组的组长）——它自己和它后续 fork 出来的、还留在同一个组里的所有子孙进程会一起收到信号。如果没有 `detached: true`，子进程根本不是任何进程组的组长，`-child.pid` 对应的进程组不存在，`process.kill` 会直接抛 `ESRCH`（我们的 `killTree` 捕获后静默忽略）——这意味着**连最基本的"杀掉这一个子进程"都会失效**，不只是"杀不到孙进程"这么简单（exercise 任务1亲手复现过这一点：`detached: false` 时"永不退出"、"取消竞态"、"进程树回收"三条测试全部超时挂起,不是只有 fork 那一条失败）。

**为什么 `env` 默认只有 `PATH`**：见上面"今天要学会什么"第4条。

## exercise.md 任务1：亲手拆掉进程组保护

把 `detached: process.platform !== 'win32'` 改成 `detached: false` 后重新跑 `tests/process-runner.test.ts`，**三条测试失败，不是一条**：

- "process-tree kill"（fork 子进程）超时挂起——预期之中，孙进程本来就不该被单进程 kill 杀到。
- "a process that never exits gets killed by the timeout" 超时挂起——`killTree('SIGKILL')` 想杀的是"进程组 `-child.pid`"，但 `child.pid` 不是任何进程组的组长（`detached: false` 时子进程默认沿用调用方的进程组），`process.kill(-child.pid, ...)` 直接抛 `ESRCH`，被 `killTree` 的 `catch` 静默吞掉——连"这一个进程"本身都没被杀掉。
- "cancellation races with a long-running process" 同理超时挂起——取消路径调的也是同一个 `killTree`。

**为什么会这样**：`detached: false` 时，`process.kill(-child.pid, sig)` 里的 `-child.pid` 引用的是一个**根本不存在的进程组**（`child.pid` 只是一个普通子进程的 pid，不是任何进程组的组长）。`process.kill` 对一个不存在的目标会抛 `ESRCH`，我们的 `killTree` 把这个异常当成"进程已经自己退出了，属于正常收尾"直接吞掉——所以不是"漏杀了孙进程"这么轻微的问题，是"整个杀进程的动作从一开始就没有生效"，父进程本身也在继续裸奔。这也解释了为什么 study.md §3 的真值表和 §0 的进程组前置知识要放在一起讲：`detached: true` + 负 pid 不是两个独立的技巧，负 pid 这个杀法**必须**建立在"这个子进程确实是一个进程组组长"这个前提上，两者是一套机制，改掉任何一半都会让另一半失效。

## exercise.md 任务2：`stdout`+`stderr` 合计上限——已落地

`SpawnSpec` 新增了可选的 `maxTotalOutputBytes`（[process-runner.ts:25-29](../../mini-harness/src/tools/process-runner.ts#L25-L29)）。实现的关键是把"额度还剩多少"从"每个 `BoundedCollector` 自己内部维护"拆成一个独立的 `OutputBudget` 类（[process-runner.ts:72-83](../../mini-harness/src/tools/process-runner.ts#L72-L83)）：

```ts
class OutputBudget {
  private bytes = 0
  constructor(private readonly maxBytes: number) {}
  spend(byteLength: number): number {
    const room = Math.max(this.maxBytes - this.bytes, 0)
    const allowed = Math.min(room, byteLength)
    this.bytes += allowed
    return allowed
  }
}
```

`BoundedCollector` 不再自己持有 `maxBytes`，改成持有一个 `OutputBudget` 引用，`push()` 里先问 `budget.spend(chunk.byteLength)` 能拿到多少配额，只保留这一部分、超出部分丢弃并标记 `truncated`。真正决定"独立还是共享"的不是 `OutputBudget`/`BoundedCollector` 这两个类本身，是 `spawnManaged()` 里怎么构造它们（[process-runner.ts:133-135](../../mini-harness/src/tools/process-runner.ts#L133-L135)）：没给 `maxTotalOutputBytes` 时，`stdout`/`stderr` 各自拿一个独立的 `new OutputBudget(spec.maxOutputBytes)`（跟原来行为完全一致，Day16 原有 18 条测试一行没改、全部保持通过）；给了 `maxTotalOutputBytes` 之后，两者改成传入**同一个** `OutputBudget` 实例——谁先写、写了多少，直接从共享池子里扣，另一路能用的额度相应变少。这跟 Day12 `TokenMeter` 的思路是同一类："累计"这件事只要被两个地方分别独立计数，就会算不准共享上限，必须让它们真正共享同一份状态,而不是各自维护一份、指望加起来对得上。

`tests/process-runner.test.ts` 新增3条测试验证（只有 stdout 写多、只有 stderr 写多、两边交替写）：交替写的那条断言 `result.stdout.length + result.stderr.length` 恰好等于 `maxTotalOutputBytes`，证明真正生效的是合计,不是"每边各能吃到一份 5000"。

## exercise.md 任务3：现在的参数够不够构成一段"看得懂、能判断"的审批描述

**不够**——`command`/`args`/`cwd`/`env`/`stdin` 描述的是"调用了哪个可执行文件、传了什么参数"，这是**语法层面**的信息，不是"这次调用实际会做什么"的**语义**信息。一个具体反例：

```json
{ "command": "node", "args": ["-e", "require('child_process').execSync('rm -rf /important-data')"] }
```

单看 `command: "node"`、`args: ["-e", "..."]` 这两个字段本身，字面意思是"用 node 执行一段脚本"——对一个不逐字读懂 `-e` 后面那段 JavaScript 代码的用户来说，这看起来跟"用 node 打印一句 hello world"没有任何区别，但实际执行效果是删除一个目录。`node -e`/`python -c`/`bash -c` 这类"解释器 + 内联代码"的调用方式，把"这次调用真正会做什么"这件事从"调用了哪个程序"整个转移到了"参数里那段任意代码的语义"上，而参数本身对审批界面来说只是一段不透明的字符串,没有能力去展示"这段代码实际会读写哪些文件、连不连网络"这类用户真正关心的信息。这意味着 Day19 真要给 `run_command` 做审批，光展示 `command`/`args` 原文是不够的，需要额外的机制（比如先在沙箱里 dry-run 一遍看会碰哪些资源，或者干脆把"解释器 + 任意代码"这类调用整体归入"高风险，需要更严格的审批流程"这一类，不能和 `ls`/`cat` 这种效果可预期的命令一视同仁）。
