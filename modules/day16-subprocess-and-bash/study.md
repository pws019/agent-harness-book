# 白话讲解：子进程与 Bash 执行

> 素材来源：DSH `docs/subsystems/shell.zh.md`、`docs/subsystems/subprocess.zh.md`。今天第一次让 Agent 跑真正的操作系统进程，不再是"读/写文件系统里的字节"这种相对可控的操作——命令可能永不退出、可能自己再 fork 出别的进程、可能疯狂往外吐数据。

## 0. 前置知识：进程、进程组、信号——三个后端常识

前端代码运行在浏览器/Node 单个进程里，很少直接跟"再启动一个独立进程"打交道，这里补几个概念。

**子进程是什么**：你的 Node 程序（父进程）可以让操作系统再启动一个完全独立的程序（子进程），比如运行 `ls`、`git`、甚至再启动一个 Node 脚本。父子进程是两个独立的、各自有自己内存空间的程序，只能通过操作系统提供的机制通信（比如子进程的标准输入/输出/错误——`stdin`/`stdout`/`stderr` 这三根"管道"）。

**"杀掉一个进程"实际发生了什么**：操作系统给进程发一个"信号"（signal），进程收到信号后被终止。`SIGTERM` 是"礼貌地"要求退出（进程可以选择先做点清理工作再退出，也可以选择忽略）；`SIGKILL` 是"不由分说立刻终止"，进程没有任何机会响应或忽略——今天的代码全部用 `SIGKILL`，因为我们要的是"确定杀死"，不是"礼貌请求"。

**进程组是什么，为什么需要它**：一个子进程完全可以在运行过程中自己再 `fork` 出别的子进程（比如一个 shell 脚本用 `&` 在后台起了另一个程序）。如果只针对"你直接 spawn 出来的那一个进程"发信号，它自己 fork 出来的子孙进程不会被波及——父进程死了，子孙进程变成"孤儿"，会一直在后台运行，操作系统甚至会把它们过继给系统的 1 号进程，谁都不知道它们还在跑。**进程组**是操作系统提供的一种"打包"机制：把一个进程和它后续 fork 出来的进程都算进同一个组里，你可以对着"整个组"发一个信号，不用一个个去找。

## 1. 为什么用显式 `argv` 数组，不用一整条 shell 字符串

**先讲问题**：如果 `run_command` 的参数设计成"一整条命令字符串"（比如 `"ls -la $(cat secret.txt)"`），执行的时候要交给一个 shell（`/bin/sh`）去解析——shell 会处理 `$()`、`|`、`;`、`&&` 这些特殊语法。这意味着：只要模型（或者模型被 prompt injection 影响后）在参数里塞一个 `; rm -rf /` 这样的字符串，shell 会老老实实把它当成"再执行一条新命令"去解释——这正是经典的"命令注入"漏洞，而且没有办法靠"转义得更仔细"彻底堵死，转义规则本身就复杂到容易被绕过。

Node 的 `child_process.spawn(command, args)` 默认**不经过 shell**——`command` 是可执行文件名，`args` 是一个字符串数组，会原样、逐个作为独立参数传给操作系统的 `execve()` 系统调用。`;`、`|`、`$()` 在 `args` 数组的某个字符串里，只是这个字符串字面意义上的几个字符，没有任何东西会把它们解释成"结束这条命令，开始新的一条"。

```ts
spawn('ls', ['-la', '; rm -rf /'])
// 等价于：把整个字符串 "; rm -rf /" 当成 ls 的一个参数（大概率是"文件不存在"报错），
// 不会被解释成"执行 ls -la，然后再执行 rm -rf /"
```

**设计两次**：`shell: true`（换取"能用管道、通配符"的表达力）是被认真考虑过、然后放弃的方案——那等于把"会不会被注入"这道题整个甩给了调用方拼参数字符串时够不够小心，跟"程序员自己小心"是同一类靠不住的保证方式（Day6 讲过）。`run_command` 选择"参数表达力打折，但注入这一整类问题从设计上不存在"。

## 2. 有界输出：为什么"继续读、只是丢弃"，不是"满了就不读了"

`run_command` 的调用方是谁：Agent loop 在某一步决定要调用这个工具时（跟 Day4 讲过的其它工具走的是同一条 `ToolRegistry.execute()` 管线），最终会调到 [process-runner.ts](../../mini-harness/src/tools/process-runner.ts) 里的 `runProcess()`。

```
runProcess(spec, signal)
   │
   ▼
spawn(spec.command, spec.args, { cwd, env, detached: true, stdio: ['pipe','pipe','pipe'] })
   │
   ├─ child.stdout 'data' 事件 ──▶ BoundedCollector（stdout）
   └─ child.stderr 'data' 事件 ──▶ BoundedCollector（stderr）
```

子进程的 `stdout`/`stderr` 是操作系统层面**有容量上限的管道**：如果没人在另一头读，写满之后，子进程调用 `write()` 会被操作系统**阻塞**，进程就卡在那里动不了——这才是"输出洪水"真正的危险，不是"内存爆掉"，是"子进程自己被卡死，你的 `timeoutMs` 还没到,它已经僵在那儿"。

`BoundedCollector`（[process-runner.ts:39-43](../../mini-harness/src/tools/process-runner.ts)）的做法是：`'data'` 事件永远正常触发、永远把这一片数据"消费掉"（意味着管道那头永远有人在读，子进程不会因为没人读而卡住），只是一旦累计字节数超过上限，后面收到的数据直接丢弃、不再拼进最终字符串里，并且把 `truncated` 标记为 `true`。**跟 Day4 `search_text` 的截断策略是同一个原则的又一次应用**：永不静默丢弃而不报告，只是把"截断"这件事从"文件读多少行"换成了"进程输出保留多少字节"。

## 3. `ToolRegistry` 的超时杀不掉真正的子进程——这是一个真实的设计陷阱

回忆 Day4 的 `runWithTimeoutAndAbort()`：

```ts
const timeoutPromise = new Promise<never>((_, reject) => {
  timer = setTimeout(() => reject(new ToolTimeoutError(...)), timeoutMs)
})
return await Promise.race([work, timeoutPromise, abortPromise])
```

`Promise.race` 只是"谁先 settle 就用谁的结果"——`timeoutPromise` 先 reject，`ToolRegistry.execute()` 就会带着一个 `ToolTimeoutError` 结束，**但 `work`（也就是 `tool.execute()` 那个 Promise）本身并没有被取消，它只是被"晾在一边"，继续在后台跑**。如果 `tool.execute()` 内部真的启动了一个操作系统子进程，`Promise.race` 的这次"超时"跟那个子进程之间没有任何联系——外层调用方以为"超时了、工具调用结束了"，那个子进程其实还在某个地方安静地跑着，永远不会退出，变成一个真正的、操作系统级别的进程泄漏。

**这是 `run_command` 必须自己再管一层超时的根本原因**：`runProcess()` 内部有自己独立的 `setTimeout`，超时时**真正调用 `process.kill()`** 去杀掉子进程,不依赖 `ToolRegistry` 那层race。`bash-tool.ts` 里注册进 `ToolRegistry` 的 `timeoutMs` 被设置成比调用方能请求的最大值还要再宽松一截（[bash-tool.ts:6-12](../../mini-harness/src/tools/bash-tool.ts)）,正常情况下它永远不会真正触发——它只是防"`runProcess()` 自己的内部逻辑出了 bug、真的一直不 resolve"这种情况的最后一道安全网,不是杀真实进程的机制。

**杀"一个进程"不够，要杀"一整棵进程树"**：即使 `runProcess()` 自己去杀子进程，如果只调用 `child.kill()`（默认只给 `child.pid` 这一个进程发信号），那个子进程如果自己又 fork 了别的进程（`study.md` §0 讲过的"进程组"要解决的问题），fork 出来的孙进程不会被波及,会变成孤儿继续跑。`runProcess()` 的做法是 `spawn(..., { detached: true })`（POSIX 上，让子进程成为一个新进程组的组长）,杀的时候用 `process.kill(-child.pid, 'SIGKILL')`（负的 pid 表示"杀整个组"，见 [process-runner.ts:97-104](../../mini-harness/src/tools/process-runner.ts)）。

### 真值表：谁负责杀进程、什么时候

| 结束方式 | 谁触发 `killTree` | `runProcess()` 返回的标记 |
|---|---|---|
| 命令自己正常跑完退出 | 没人触发，`'close'` 事件自然到达 | `timedOut: false`，`aborted: false` |
| 到达 `timeoutMs` | `runProcess()` 内部自己的 `setTimeout` | `timedOut: true` |
| 调用方取消（`exec.signal` 触发 `abort`） | `runProcess()` 自己挂的 `signal.addEventListener('abort', ...)` | `aborted: true` |
| `ToolRegistry` 外层的 `timeoutMs` 兜底触发 | **谁都没有**——这层只会让 `ToolRegistry.execute()` 的 Promise 落空，不会调用任何 kill 逻辑 | 调用方看到的是 `ToolTimeoutError`，但如果走到了这一行,说明 `runProcess()` 内部逻辑真的挂了，这本身就是一个需要排查的 bug 信号 |

最后一行是刻意留白的——它不是"正常会发生的路径"，是"如果发生了，说明上面三行都没生效"的报警信号，这也是为什么外层 `timeoutMs` 要设置得比正常情况宽松很多：它不该被日常触发。

## 4. `env`：白名单，不是黑名单

```ts
const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...(args.env ?? {}) }
```

**设计两次**：考虑过三种做法——① 完整继承宿主进程的 `process.env`（最省事，但宿主进程手里可能有任何 secret：API key、数据库密码，子进程默认全能看到，对应 study.md 大纲里"环境变量泄露"这条故障场景）；② 维护一份"危险变量黑名单"过滤掉（比如过滤所有名字包含 `KEY`/`TOKEN`/`SECRET` 的变量——但这种命名约定不可能穷举，漏掉一个新加的变量名就等于没防）；③ **默认清空，只留 `PATH`，其余必须调用方显式传**（选了这个）。

选③的理由：这不是"挑出几个危险的挡住"，是"默认什么都没有，需要什么必须自己申报"——申报的范围永远只会跟需要的一样大，不存在"漏掉一个没想到的危险变量"这种风险,因为压根不存在"默认继承"这件事。`PATH` 是唯一的例外，因为没有它连 `ls`/`node` 这类最基本的可执行文件都找不到,而 `PATH` 本身通常只是一串目录路径,不被视为敏感信息。

## 一句话总结

今天的三个决定——argv 数组不用 shell 字符串、有界输出继续读只是丢弃、进程树而不是单进程的 kill——都是同一条思路的不同应用：**子进程是一个"一旦启动就不再完全受你控制"的东西，能做的不是祈祷它规规矩矩，而是从启动的那一刻起就把"它可能失控成什么样"都提前想清楚、提前挡住**。`ToolRegistry` 原有的超时机制在 Day4 那批只读工具面前够用，是因为那些工具从不会产生"一个脱离了 Promise 生命周期、自己在操作系统里独立运行"的副作用——子进程第一次真正打破了这个假设，这也是为什么 Day16 要专门给它补一层自己的生命周期管理，而不是继续信任 Day4 那套机制。
