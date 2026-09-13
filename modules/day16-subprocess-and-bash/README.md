# Day 16・子进程与 Bash 执行

> 阶段：III. 受控执行与人机协作　|　产出：新增 `src/tools/process-runner.ts`、`src/tools/bash-tool.ts`（`run_command` 工具）

## 今天要学会什么

1. 理解为什么 `run_command` 用显式 `argv` 数组而不是一整条 shell 字符串——这个决定怎么从根源上排除了命令注入这个问题，而不是靠"转义得够仔细"去防。
2. 理解"有界输出"为什么不是"满了就不再读"，而是"继续读、只是不再保留"——不这样做子进程会因为管道写满而卡死，"输出洪水"反而变成"进程假死"。
3. 理解为什么 `ToolRegistry` 原有的超时机制（Day4）杀不掉一个真正的子进程，`run_command` 必须自己再管一层超时；以及为什么杀"这一个进程"不够，必须杀"这一整棵进程树"。
4. 理解 `env` 为什么设计成白名单（只有 `PATH` + 显式传入的变量），而不是继承宿主进程的完整环境或者维护一份"危险变量黑名单"。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码，顺序建议：`src/tools/process-runner.ts`（真正 spawn/kill/收集输出的地方）→ `src/tools/bash-tool.ts`（`run_command` 工具定义，怎么用 process-runner）。
3. 跑 `tests/process-runner.test.ts`（低层故障注入：输出洪水、永不退出、fork 子进程、env 泄漏、取消竞态）和 `tests/run-command-tool.test.ts`（工具层：参数校验、cwd 边界、经过 `ToolRegistry` 的端到端行为）。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：`ToolRegistry.execute()` 里的 `timeoutMs` 参数超时之后，一个正在跑的真实子进程会不会被杀掉？为什么？
- 你能解释：只调用 `child.kill()` 和调用 `process.kill(-child.pid, ...)` 分别能杀掉什么、杀不掉什么。
- 你能解释：为什么 `run_command` 默认的子进程环境里只有 `PATH`，而不是完整继承宿主进程的 `process.env`。
- `pnpm test` 全绿。
