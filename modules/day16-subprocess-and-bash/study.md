# 白话讲解：子进程与 Bash 执行

> 素材来源：DSH `docs/subsystems/shell.zh.md`、`docs/subsystems/subprocess.zh.md`。今天第一次让 Agent 跑真正的操作系统进程，不再是"读/写文件系统里的字节"这种相对可控的操作——命令可能永不退出、可能自己再 fork 出别的进程、可能疯狂往外吐数据。

## 0. 前置知识：进程、进程组、信号、管道——几个后端常识

前端代码运行在浏览器/Node 单个进程里，很少直接跟"再启动一个独立进程"打交道，这里补几个概念。

**子进程是什么**：你的 Node 程序（父进程）可以让操作系统再启动一个完全独立的程序（子进程），比如运行 `ls`、`git`、甚至再启动一个 Node 脚本。父子进程是两个独立的、各自有自己内存空间的程序，只能通过操作系统提供的机制通信（比如子进程的标准输入/输出/错误——`stdin`/`stdout`/`stderr` 这三根"管道"）。

**"杀掉一个进程"实际发生了什么**：操作系统给进程发一个"信号"（signal），进程收到信号后被终止。`SIGTERM` 是"礼貌地"要求退出（进程可以选择先做点清理工作再退出，也可以选择忽略）；`SIGKILL` 是"不由分说立刻终止"，进程没有任何机会响应或忽略——今天的代码全部用 `SIGKILL`，因为我们要的是"确定杀死"，不是"礼貌请求"。

**进程组是什么，为什么需要它**：一个子进程完全可以在运行过程中自己再 `fork` 出别的子进程（比如一个 shell 脚本用 `&` 在后台起了另一个程序）。如果只针对"你直接 spawn 出来的那一个进程"发信号，它自己 fork 出来的子孙进程不会被波及——父进程死了，子孙进程变成"孤儿"，会一直在后台运行，操作系统甚至会把它们过继给系统的 1 号进程，谁都不知道它们还在跑。**进程组**是操作系统提供的一种"打包"机制：把一个进程和它后续 fork 出来的进程都算进同一个组里，你可以对着"整个组"发一个信号，不用一个个去找。

**管道为什么会让子进程卡住，Node 怎么在背后把它排空**：子进程的 `stdout`/`stderr` 底层是一根操作系统管道（pipe），管道有一个有限大小的**内核缓冲区**（Linux 上通常是 64KB 左右）。子进程调用 `write()` 往这根管道里写数据，缓冲区还有空间就立刻返回；缓冲区满了、又没人在另一头把数据取走腾出空间，操作系统会让子进程这次 `write()` 调用**直接挂起**——子进程就卡死在这一行,动不了,直到缓冲区被读空为止。这是"子进程输出太多导致假死"这个故障场景的真正机制，不是"Node 这边内存爆了"。

Node 把管道读端包成了一个 `Readable` 对象（也就是 `child.stdout`/`child.stderr`），这个对象有两种工作模式：**paused（暂停）模式**是默认状态,这时候 Node 不会主动去读底层的文件描述符,数据会一直堆积在操作系统的管道缓冲区里,不会被取走；一旦代码调用了 `.on('data', callback)`,这个 stream 会自动切换成 **flowing（流动）模式**——Node 内部开始持续地从底层文件描述符读数据,每读到一块就触发一次 `'data'` 事件,把这块数据（一个 `Buffer`）扔给 callback。关键在于：**"把数据从管道里取走"这个动作,是 Node 在挂上 `.on('data', ...)` 监听器那一刻就自动开始做的,跟 callback 函数体里实际写了什么完全无关**——哪怕 callback 是个空函数,光是切换进 flowing 模式,就已经足够持续排空管道缓冲区,子进程也就不会因为缓冲区写满而卡在 `write()` 上。第4节的 `BoundedCollector` 会用到这个机制。

## 1. 今天要加的是什么能力，为什么这一天的风险级别跳了一大截

Day4 给了 Agent 三个只读工具（读文件/列目录/搜文本），Day15 给了它写文件的能力（`edit_file`）——但写文件始终是"改动一份内容明确、大小有限的数据"，能出的错有限，`expectedHash` 一道检查基本就能兜住。今天的 `run_command` 不一样：它让 Agent 能启动**任意一个可执行程序**，这个程序运行时想干什么、要跑多久、会不会自己再启动别的程序，全都不可预测——今天新增的两个文件（`bash-tool.ts`/`process-runner.ts`）本质上都是在回答同一个问题："一旦允许 Agent 跑真实进程，有哪些新的失控方式，分别怎么提前挡住"，第3-6节要讲的四个设计决定就是这四种失控方式各自的答案。

## 2. 一次 `run_command` 调用要经过哪些代码

在深入某一个具体设计决定之前，先看清楚整条链路——后面每一节点名的函数/类型，都能在这张图上找到自己的位置：

```
Agent loop 决定调用 run_command
      │
      ▼
ToolRegistry.execute('run_command', args, ctx)   ← Day4 就有的统一入口，参数校验/超时/取消都在这里
      │
      ▼
bash-tool.ts createRunCommandTool().execute()    ← 今天新增：校验 cwd 边界、拼出 SpawnSpec
      │
      ▼
process-runner.ts runProcess(spec, signal)       ← 今天新增：真正 spawn，管生老病死
      │
      ▼
node:child_process spawn(command, args, {...})   ← 操作系统真正的子进程
      │
      ├─ stdout/stderr 的 'data' 事件 ──▶ BoundedCollector（第3节）
      └─ 超时 / 外部取消 ──▶ killTree()（第4-5节）
```

**这几个新符号分别是什么、定义在哪、后面哪一节会细讲**：

| 符号 | 定义在哪 | 是什么 | 哪一节细讲 |
|---|---|---|---|
| `RunCommandArgs`/`RunCommandValue` | `bash-tool.ts` | `run_command` 工具对模型暴露的参数/返回值形状（`command`/`args`/`cwd`/`env`/`stdin`/`timeoutMs`） | 第3、6节 |
| `SpawnSpec` | [process-runner.ts:17-25](../../mini-harness/src/tools/process-runner.ts#L17-L25) | `bash-tool.ts` 校验完参数之后，喂给 `runProcess()` 的完整规格——比 `RunCommandArgs` 更"确定"，没有可选字段留白（比如 `timeoutMs` 这里一定是个具体数字，不再是"可能没给、用默认值"） | 第3、6节 |
| `ProcessRunResult` | [process-runner.ts:27-35](../../mini-harness/src/tools/process-runner.ts#L27-L35) | 一次调用跑完之后的最终结果——退出码、`stdout`/`stderr`、是不是超时/被取消 | 第5节 |
| `runProcess(spec, signal)` | [process-runner.ts:184-186](../../mini-harness/src/tools/process-runner.ts#L184-L186) | 今天唯一的入口函数：spawn 一个子进程，返回一个"跑完才 resolve"的 Promise | 全篇 |
| `BoundedCollector` | [process-runner.ts:64-77](../../mini-harness/src/tools/process-runner.ts#L64-L77) | 挂在 `stdout`/`stderr` 上的收集器，负责"有界输出"这条规则 | 第3节 |
| `killTree()` | [process-runner.ts:121-128](../../mini-harness/src/tools/process-runner.ts#L121-L128) | 超时/取消触发时真正杀进程（树）的地方 | 第4、5节 |

后面每一节都是在细看这张图上的某一块——不会再出现"凭空冒出一个函数"的情况。

## 3. 为什么用显式 `argv` 数组，不用一整条 shell 字符串

**先讲问题**：如果 `run_command` 的参数设计成"一整条命令字符串"（比如 `"ls -la $(cat secret.txt)"`），执行的时候要交给一个 shell（`/bin/sh`）去解析——shell 会处理 `$()`、`|`、`;`、`&&` 这些特殊语法。这意味着：只要模型（或者模型被 prompt injection 影响后）在参数里塞一个 `; rm -rf /` 这样的字符串，shell 会老老实实把它当成"再执行一条新命令"去解释——这正是经典的"命令注入"漏洞，而且没有办法靠"转义得更仔细"彻底堵死，转义规则本身就复杂到容易被绕过。

Node 的 `child_process.spawn(command, args)` 默认**不经过 shell**——`command` 是可执行文件名，`args` 是一个字符串数组，会原样、逐个作为独立参数传给操作系统的 `execve()` 系统调用。`;`、`|`、`$()` 在 `args` 数组的某个字符串里，只是这个字符串字面意义上的几个字符，没有任何东西会把它们解释成"结束这条命令，开始新的一条"。这也是为什么 `RunCommandArgs`（上一节表格里的第一个符号）把 `args` 设计成 `readonly string[]`，而不是一个 `command: string` 让调用方自己拼好整条命令。

```ts
spawn('ls', ['-la', '; rm -rf /'])
// 等价于：把整个字符串 "; rm -rf /" 当成 ls 的一个参数（大概率是"文件不存在"报错），
// 不会被解释成"执行 ls -la，然后再执行 rm -rf /"
```

**设计两次**：`shell: true`（换取"能用管道、通配符"的表达力）是被认真考虑过、然后放弃的方案——那等于把"会不会被注入"这道题整个甩给了调用方拼参数字符串时够不够小心，跟"程序员自己小心"是同一类靠不住的保证方式（Day6 讲过）。`run_command` 选择"参数表达力打折，但注入这一整类问题从设计上不存在"。

## 4. 有界输出：为什么"继续读、只是丢弃"，不是"满了就不读了"

子进程的 `stdout`/`stderr` 是操作系统层面**有容量上限的管道**：如果没人在另一头读，写满之后，子进程调用 `write()` 会被操作系统**阻塞**，进程就卡在那里动不了——这才是"输出洪水"真正的危险，不是"内存爆掉"，是"子进程自己被卡死，你的 `timeoutMs` 还没到,它已经僵在那儿"（机制细节见 §0 最后一条"管道为什么会让子进程卡住"）。

`BoundedCollector`（[process-runner.ts:64-77](../../mini-harness/src/tools/process-runner.ts#L64-L77)，挂载方式见 [process-runner.ts:115-116](../../mini-harness/src/tools/process-runner.ts#L115-L116) 的 `child.stdout?.on('data', ...)`）的做法是：`'data'` 事件永远正常触发、永远把这一片数据"消费掉"（意味着管道那头永远有人在读，子进程不会因为没人读而卡住），只是一旦累计字节数超过上限，后面收到的数据直接丢弃、不再拼进最终字符串里，并且把 `truncated` 标记为 `true`。**跟 Day4 `search_text` 的截断策略是同一个原则的又一次应用**：永不静默丢弃而不报告，只是把"截断"这件事从"文件读多少行"换成了"进程输出保留多少字节"。

**为什么不能在超限之后干脆把 `'data'` 监听器摘掉、或者让 stream 暂停**：`§0` 讲过，"排空管道"这件事发生在 Node 把 stream 切进 flowing 模式的那一刻，跟 callback 里具体做了什么无关——但反过来也成立：如果为了"省事"在超过 `maxBytes` 之后调用 `child.stdout.pause()` 或者把监听器摘掉，等于主动把 stream 切回 paused 模式，Node 不再从底层文件描述符读数据，管道缓冲区立刻开始重新堆积，子进程立刻又会卡在下一次 `write()` 上——这正是"截断"和"卡死"这两件事很容易被搞混的地方：`BoundedCollector.push()`（[process-runner.ts:71-81](../../mini-harness/src/tools/process-runner.ts#L71-L81)）在超限之后依然会被每次 `'data'` 事件调用，只是内部提前 `return`（[process-runner.ts:72](../../mini-harness/src/tools/process-runner.ts#L72)）、不再把数据拼进 `chunks` 数组——"丢弃"发生在收集器内部,不是靠"不再触发事件"来实现的，flowing 模式必须从头到尾保持开启。

## 5. `ToolRegistry` 的超时杀不掉真正的子进程——这是一个真实的设计陷阱

回忆 Day4 的 `runWithTimeoutAndAbort()`：

```ts
const timeoutPromise = new Promise<never>((_, reject) => {
  timer = setTimeout(() => reject(new ToolTimeoutError(...)), timeoutMs)
})
return await Promise.race([work, timeoutPromise, abortPromise])
```

`Promise.race` 只是"谁先 settle 就用谁的结果"——`timeoutPromise` 先 reject，`ToolRegistry.execute()` 就会带着一个 `ToolTimeoutError` 结束，**但 `work`（也就是 `tool.execute()` 那个 Promise）本身并没有被取消，它只是被"晾在一边"，继续在后台跑**。如果 `tool.execute()` 内部真的启动了一个操作系统子进程，`Promise.race` 的这次"超时"跟那个子进程之间没有任何联系——外层调用方以为"超时了、工具调用结束了"，那个子进程其实还在某个地方安静地跑着，永远不会退出，变成一个真正的、操作系统级别的进程泄漏。

**这是 `run_command` 必须自己再管一层超时的根本原因**：`runProcess()` 内部有自己独立的 `setTimeout`（[process-runner.ts:130-133](../../mini-harness/src/tools/process-runner.ts#L130-L133)），超时时**真正调用 `killTree()`** 去杀掉子进程,不依赖 `ToolRegistry` 那层race。`bash-tool.ts` 里注册进 `ToolRegistry` 的 `timeoutMs`（`REGISTRY_TIMEOUT_MS`，[bash-tool.ts:8-14](../../mini-harness/src/tools/bash-tool.ts#L8-L14)）被设置成比调用方能请求的最大值还要再宽松一截,正常情况下它永远不会真正触发——它只是防"`runProcess()` 自己的内部逻辑出了 bug、真的一直不 resolve"这种情况的最后一道安全网,不是杀真实进程的机制。

**杀"一个进程"不够，要杀"一整棵进程树"**：即使 `runProcess()` 自己去杀子进程，如果只调用 `child.kill()`（默认只给 `child.pid` 这一个进程发信号），那个子进程如果自己又 fork 了别的进程（`study.md` §0 讲过的"进程组"要解决的问题），fork 出来的孙进程不会被波及,会变成孤儿继续跑。`runProcess()` 的做法是 `spawn(..., { detached: true })`（POSIX 上，让子进程成为一个新进程组的组长，见 [process-runner.ts:105](../../mini-harness/src/tools/process-runner.ts#L105)）,杀的时候 `killTree()` 用 `process.kill(-child.pid, 'SIGKILL')`（负的 pid 表示"杀整个组"，见 [process-runner.ts:121-128](../../mini-harness/src/tools/process-runner.ts#L121-L128)）。

### 真值表：谁负责杀进程、什么时候

| 结束方式 | 谁触发 `killTree` | `runProcess()` 返回的标记 |
|---|---|---|
| 命令自己正常跑完退出 | 没人触发，`'close'` 事件自然到达（[process-runner.ts:154](../../mini-harness/src/tools/process-runner.ts#L154)） | `timedOut: false`，`aborted: false` |
| 到达 `timeoutMs` | `runProcess()` 内部自己的 `setTimeout`（[process-runner.ts:130-133](../../mini-harness/src/tools/process-runner.ts#L130-L133)） | `timedOut: true` |
| 调用方取消（`exec.signal` 触发 `abort`） | `runProcess()` 自己挂的 `signal.addEventListener('abort', ...)`（[process-runner.ts:135-139](../../mini-harness/src/tools/process-runner.ts#L135-L139)） | `aborted: true` |
| `ToolRegistry` 外层的 `timeoutMs` 兜底触发 | **谁都没有**——这层只会让 `ToolRegistry.execute()` 的 Promise 落空，不会调用任何 kill 逻辑 | 调用方看到的是 `ToolTimeoutError`，但如果走到了这一行,说明 `runProcess()` 内部逻辑真的挂了，这本身就是一个需要排查的 bug 信号 |

最后一行是刻意留白的——它不是"正常会发生的路径"，是"如果发生了，说明上面三行都没生效"的报警信号，这也是为什么外层 `timeoutMs` 要设置得比正常情况宽松很多：它不该被日常触发。

## 6. `env`：白名单，不是黑名单

```ts
const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...(args.env ?? {}) }
```

这行代码在整条链路里的位置：`bash-tool.ts` 的 `execute()` 拼出 `SpawnSpec.env`（第2节表格里的那个符号）的地方，拼好之后随着整个 `SpawnSpec` 一起交给 `runProcess()`。

**设计两次**：考虑过三种做法——① 完整继承宿主进程的 `process.env`（最省事，但宿主进程手里可能有任何 secret：API key、数据库密码，子进程默认全能看到，对应 study.md 大纲里"环境变量泄露"这条故障场景）；② 维护一份"危险变量黑名单"过滤掉（比如过滤所有名字包含 `KEY`/`TOKEN`/`SECRET` 的变量——但这种命名约定不可能穷举，漏掉一个新加的变量名就等于没防）；③ **默认清空，只留 `PATH`，其余必须调用方显式传**（选了这个）。

选③的理由：这不是"挑出几个危险的挡住"，是"默认什么都没有，需要什么必须自己申报"——申报的范围永远只会跟需要的一样大，不存在"漏掉一个没想到的危险变量"这种风险,因为压根不存在"默认继承"这件事。`PATH` 是唯一的例外，因为没有它连 `ls`/`node` 这类最基本的可执行文件都找不到,而 `PATH` 本身通常只是一串目录路径,不被视为敏感信息。

## 一句话总结

今天的四个决定——argv 数组不用 shell 字符串、有界输出继续读只是丢弃、进程树而不是单进程的 kill、env 默认清空只留白名单——都是同一条思路的不同应用：**子进程是一个"一旦启动就不再完全受你控制"的东西，能做的不是祈祷它规规矩矩，而是从启动的那一刻起就把"它可能失控成什么样"都提前想清楚、提前挡住**。`ToolRegistry` 原有的超时机制在 Day4 那批只读工具面前够用，是因为那些工具从不会产生"一个脱离了 Promise 生命周期、自己在操作系统里独立运行"的副作用——子进程第一次真正打破了这个假设，这也是为什么 Day16 要专门给它补一层自己的生命周期管理，而不是继续信任 Day4 那套机制。

> 提示：这份文档写于 Day16。Day17 后来把 `runProcess()` 内部的 spawn/kill 逻辑拆成了一个更底层的 `spawnManaged()`（`runProcess()` 退化成对它的一层等待包装），本节引用的所有行号已按 Day17 重构之后的实际代码校对过；`spawnManaged()`/`ManagedProcess` 这两个符号今天还不需要认识，Day17 的 study.md 会专门讲。
