# 白话讲解：PTY、后台任务与资源所有权

> 素材来源：DSH `docs/subsystems/terminal.zh.md`、`docs/subsystems/jobs.zh.md`。今天不做真正的 PTY（原始大纲自己也标注"选做"）——引入 `node-pty` 这类需要编译的原生依赖，跟这个项目至今零原生依赖的定位不符，见本篇末尾"不要机械照搬"那一条。核心是 `JobRuntime`：一种跟"工具调用"完全不同形状的生命周期。

## 0. 前置知识：为什么是"轮询"，不是"服务器推送"

如果你写过前端轮询一个后端任务状态的接口（"提交一个导出任务，每隔几秒查一次进度"），你已经在用今天要学的模式。这里先讲清楚为什么 `job_status` 设计成"你主动问一次，给你当前快照"（轮询），而不是"任务一有新输出就主动推给你"（类似 WebSocket/SSE 推送）。

推送模式对这里不合适的原因：`Agent loop`（Day5）的节奏是"问模型→执行工具→把结果写回历史→再问模型"，模型只有在**主动调用一次工具**（比如 `job_status`）的那个时间点，才有能力"看"到新信息——不存在一个"消息可以随时插进模型脑子里"的通道（Day6 study.md 讲过 `steer` 这种"插话"机制我们都还没做）。所以哪怕后台任务真的支持推送，Agent loop 这一层能消费的方式也只能是"下次调用工具的时候拿到一份当前快照"——推送对这个消费方没有意义，轮询已经是终点了。

## 1. 一个工具调用 vs 一个后台任务：两种生命周期

```
一次普通工具调用（Day4-16 都是这样）：
  Agent loop 调 execute() ──等它 resolve──▶ 拿到结果 ──▶ 写回历史 ──▶ 这次调用彻底结束

一个后台任务（今天新加的）：
  Agent loop 调 start_job() ──立刻拿到 jobId，不等任务跑完──▶ 写回历史
       │
       ├─ 可能是这个 turn 里，也可能是后面某个 turn 里……
       ▼
  Agent loop 调 job_status(jobId) ──立刻拿到"现在是什么状态"的快照──▶ 写回历史
       │（重复 N 次，跨越任意多个 turn）
       ▼
  Agent loop 调 cancel_job(jobId)（可选）或者任务自己跑完
```

`start_job`/`job_status`/`cancel_job` 本身仍然是普通工具（一样走 Day4 那条 `ToolRegistry.execute()` 管线,一样有参数校验、超时、取消），**特殊的是它们背后共享的 `JobRuntime` 状态活得比任何一次工具调用都长**——`start_job` 这次调用结束了，它启动的那个子进程还在跑，直到有人（`cancel_job`）或者它自己（跑完）结束它。

## 2. `spawnManaged()`：给一个用了一整天的深模块加新能力，不改它的窄接口

**先讲问题**：Day16 的 `runProcess(spec, signal): Promise<ProcessRunResult>` 只回答"这次调用最终的结果是什么"——它内部攒的 `stdout`/`stderr` 只有等 `Promise` resolve 那一刻才对外可见。`JobRuntime.poll()` 需要的是完全不同的东西："**现在**（还没跑完）攒到了多少内容"——`runProcess()` 的签名从设计上就没打算回答这个问题。

**改法**：把 `runProcess()` 内部"spawn + 挂监听器 + 杀进程树"这部分逻辑整个搬进一个新函数 `spawnManaged(spec, signal): ManagedProcess`，它立刻返回一个句柄，不等待完成：

```ts
export interface ManagedProcess {
  readonly pid: number | undefined
  stdoutSnapshot(): OutputSnapshot   // 随时可以问，不用等 done
  stderrSnapshot(): OutputSnapshot
  readonly done: Promise<ProcessRunResult>   // 跟旧版 runProcess() 的返回值一模一样
  cancel(): void
}
```

`runProcess()` 现在只剩一行（[process-runner.ts:184-186](../../mini-harness/src/tools/process-runner.ts)）：

```ts
export function runProcess(spec: SpawnSpec, signal: AbortSignal): Promise<ProcessRunResult> {
  return spawnManaged(spec, signal).done
}
```

**为什么 Day16 写的 18 条测试不用改一行**：它们全部只认 `runProcess(spec, signal)` 这一个函数签名、只关心它最终 resolve/reject 成什么——`spawnManaged()` 内部照抄了 Day16 原有的 `BoundedCollector`/`killTree`/`timer`/`onAbort` 全部逻辑,一个字节都没变,只是把"这些状态什么时候变成外部可读的最终结果"和"这些状态本身"拆成了两半。`runProcess()` 拿到的 `done` 跟以前完全一样，跑一遍 `pnpm test` 能验证这一点——这是"深模块，接口不变、内部长出新能力"的一次实际操作，不是一句抽象的口号。

## 3. `JobRuntime` 的幂等设计：`cancel()` 抛错，`dispose()` 不抛

```ts
cancel(id: string): void {
  const record = this.getOrThrow(id)      // 不存在的 id：抛 JobNotFoundError
  if (record.status.kind !== 'running') return   // 已经是终态：安静地什么都不做
  record.controller.abort()
}

dispose(id: string): void {
  const record = this.jobs.get(id)
  if (!record) return                      // 不存在的 id：安静地什么都不做，不抛错
  if (record.status.kind === 'running') record.controller.abort()
  this.jobs.delete(id)
}
```

真值表：

| 调用 | id 不存在 | id 存在但已是终态 | id 存在且还在跑 |
|---|---|---|---|
| `cancel()` | 抛 `JobNotFoundError` | no-op（幂等） | 真正杀掉 |
| `dispose()` | no-op | 直接删记录 | 先杀掉再删记录 |

两者对"不存在的 id"给出不同反应，不是不一致，是场景不同：`cancel()` 假设调用方手里的 `jobId` 应该是真实存在过的（凭空传一个瞎编的 id 大概率是调用方自己的 bug，抛错让它显形）；`dispose()` 的语义是"我不再需要管这个 Job 了，帮我确保它不会泄漏"——不管这个 id 之前有没有对应过一个真 Job（可能已经被 dispose 过一次），"确保它不再存在"这个目标本来就已经达成了，不需要为了这件已经成立的事实报错。这跟 Day6 `Agent.dispose()` 幂等是同一条底层原则："释放"这种收尾动作，天然会被调用方多次调用（忘了自己是不是已经清理过、防御性地重复调用），让它对重复调用安全，比要求调用方自己精确记账更可靠。

## 4. Job 在进程重启后处于什么状态——诚实的答案

`JobRuntime` 的状态**只存在内存里**，不往 Day8 的 Session 事件日志追加任何东西。这不是漏掉了,是今天故意划的边界：一旦宿主 Node 进程重启，`JobRuntime` 实例连同它管理的所有 `AbortController`/`ManagedProcess` 句柄一起消失——但它启动的那些真实操作系统子进程，如果是 `run_command` 那种同步等待的调用，子进程早已经随宿主进程一起退出；但如果是 `run_command`/`start_job` 启动的、`detached: true` 的子进程组，理论上**子进程本身可能因为不依赖父进程的存活而继续运行**，只是我们的 `JobRuntime` 已经没有任何句柄能联系到它了。

所以准确的说法是：进程重启后，没有"可恢复的 Job"（我们没有保存任何东西使得重启后能找回一个正在跑的 Job 的完整状态），只有"已失联的 Job"——它可能还在跑，也可能已经退出，我们的新进程完全不知道，也没有办法再读到它的输出（原来的 pipe 早就跟着旧进程一起没了）。

**设计两次：如果真要做"重启后能找回一个 Job"，需要往哪个方向走**——把 `SpawnSpec` 和 `pid` 持久化进 Session 日志（类似 Day9 的持久化思路），重启时 `Agent.restore()` 读到这些记录后，用 `process.kill(pid, 0)`（这个信号 `0` 不会真的杀死进程，只是探测这个 pid 还在不在）判断"当初这个 pid 现在是不是还活着"——如果活着，也只能标记成"进程还在，但输出已经无法追踪"（因为原来的 stdout/stderr 管道随旧进程的文件描述符一起失效了，新进程没有继承它们，没法“重新接上”去读),更现实的处理是直接把它也杀掉、清理干净，而不是假装"恢复"了什么。这条路径今天没有实现——一个单工作区、单会话的教学 Agent 目前没有真实场景需要"跨进程重启还能救回一个后台任务",提前做这套机制只会增加复杂度换不来实际用得上的能力。

## 一句话总结

今天引入的复杂度,本质来自"生命周期比工具调用本身更长的资源"这件事第一次真正出现——`JobRuntime` 存在的意义,是把"怎么安全地跨多次调用追踪一个还在跑的东西"这个问题,从"调用方自己想办法记住 pid、自己想办法安全地杀"这种容易出错的临时方案，收进一个统一、幂等、复用 Day16 已经验证过的杀进程逻辑的模块里——跟 Day4 工具管线"复杂度下沉，不转嫁给调用方"是同一条原则,只是这次下沉的复杂度是"时间维度"上的,不是单次调用内部的。
