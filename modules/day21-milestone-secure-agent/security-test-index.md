# 25 条安全回归测试索引

这不是新写的 25 条测试——是把 Day15/16/18/19/20/21 各自独立验证过的安全属性汇总成一份索引，按"防的是哪一类问题"分组，每条都标注真实存在的 file:line（写这份索引之前逐条跑过 `pnpm vitest run <file>` 确认它们真的存在、真的通过）。分组之间不是互相独立的机制——很多防线是好几层叠加的（比如"路径逃逸"在 Day4 的 `resolveWithinRoot` 和 Day15 的 symlink 检测各挡一部分）。

## 1. 路径逃逸（3条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 1 | `tests/tools.test.ts:92` | `read_file` 拒绝一个跑出 workspace 根目录的相对路径 |
| 2 | `tests/tools.test.ts:130` | `list_files` 同上 |
| 3 | `tests/tools.test.ts:330` | `resolveWithinRoot()` 本身拒绝任何最终落在 root 外的 `../` 穿越，这是前两条测试共同依赖的底层机制 |

## 2. Symlink 逃逸（2条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 4 | `tests/fs-tools-integration.test.ts:37` | `read_file` 拒绝跟随一个指向 workspace 外的符号链接 |
| 5 | `tests/fs-tools-integration.test.ts:50` | `edit_file` 拒绝通过一个指向 workspace 外的符号链接目录写入 |

## 3. 写入一致性 / TOCTOU（2条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 6 | `tests/tools.test.ts:235` | `edit_file` 拒绝一个 `expectedHash` 已经跟磁盘当前内容对不上的编辑（读之后、写之前文件被别的进程改了） |
| 7 | `tests/tools.test.ts:256` | `edit_file` 拒绝写入看起来是二进制的内容,不会把非文本数据当文本改坏 |

## 4. 子进程环境隔离（3条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 8 | `tests/run-command-tool.test.ts:76` | 宿主进程的 secret 不会因为 `run_command` 而泄漏进子进程,即使 `PATH` 仍然可用 |
| 9 | `tests/process-runner.test.ts:104` | 同上,在更底层的 `runProcess()` 单独验证一遍（工具层和执行层各测一遍,不是只测一边） |
| 10 | `tests/red-team-regression.test.ts:35` | 即使模型被诱导执行"打印所有环境变量"这类命令,env 白名单也让宿主 secret 对子进程不可见 |

## 5. Shell 注入（1条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 11 | `tests/red-team-regression.test.ts:54` | 参数里的分号+第二条命令只是 argv 数组里一个字符串的字面内容,不会被解释成"再执行一条新命令"（`run_command` 直接 spawn,不经过 shell） |

## 6. 网络外传——诚实记录的缺口 + 部分缓解（2条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 12 | `tests/red-team-regression.test.ts:88` | **证明缺口真实存在**：一个被 `CommandPolicy` 允许运行的可执行文件,本身依然有能力发起网络请求——策略只挡"哪个程序能跑",不挡"跑起来的程序能连哪里" |
| 13 | `tests/red-team-regression.test.ts:107` | **证明部分缓解确实生效**：一个不在白名单里的已知网络工具（比如 `curl`）会被 `CommandPolicy` 直接拒绝,不会跑到"能不能发请求"那一步 |

## 7. 资源耗尽（1条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 14 | `tests/red-team-regression.test.ts:118` | 一个命令连续 fork 出好几个子进程（模拟缩小规模的 fork bomb）,超时之后整棵进程树被回收,不留存活的子孙 |

## 8. Fail-closed（1条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 15 | `tests/command-policy-integration.test.ts:57` | `CommandPolicy` 求值本身抛异常时,`run_command` 拒绝执行,不会因为策略挂了就悄悄放行 |

## 9. 取消真的杀掉了操作系统进程，不只是让 Promise 落空（1条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 16 | `tests/run-command-tool.test.ts:127` | `exec.signal` 被 abort 之后,底层真实的操作系统子进程真的被杀掉了,不是只有 JS 里等待的 Promise reject 了、进程本身还在裸奔 |

## 10. 审批一次性、绑定精确参数（3条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 17 | `tests/approval.test.ts:23` | 同一个 nonce 消费两次（重放/双击批准）,第二次失败 |
| 18 | `tests/approval.test.ts:34` | 用跟批准时不同的参数去消费,失败,且不会顺手烧掉 nonce（留一次用正确参数重试的机会） |
| 19 | `tests/approval.test.ts:78` | 过期之后消费,即使参数和 nonce 都是对的,依然失败 |

## 11. 权限预设显式拒绝（1条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 20 | `tests/permission-presets.test.ts:7` | `readonly` 预设对不在只读集合里的工具直接 `deny`,不是"猜工具名字像不像只读" |

## 12. 凭据不泄漏（2条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 21 | `tests/credentials.test.ts:6` | `CredentialRef` 序列化成 JSON（模拟写进 Session 事件）之后,不包含真实密钥字符串 |
| 22 | `tests/workspace-context-integration.test.ts:45` | 模型自己在 `run_command` 参数里传一个同名 `env` 变量,不能顶替/覆盖 workspace 配置好的真实凭据 |

## 13. 里程碑三集成（Day21 新增，3条）

| # | 测试 | 防的是什么 |
|---|---|---|
| 23 | `tests/propose-edit.test.ts:118` | `readonly` 预设对 `edit_file` 直接拒绝,**从不调用** `requestApproval()`——高风险动作不会因为预设配置错误而意外弹出一个"看起来像正常流程"的确认框, 也不会被写入磁盘 |
| 24 | `tests/propose-edit.test.ts:57` | 用户在审批环节回答"拒绝",文件内容一个字节都不会被改动 |
| 25 | `tests/propose-edit.test.ts:179` | **诚实记录的缺口**：如果文件在"批准"和"真正写入"之间被别的进程改写,`edit_file` 会因为 `expectedHash` 不匹配而失败,但这次批准的 nonce 已经被消费掉,不能用同一个 nonce 重试——要修复需要把"消费 nonce"和"落盘成功"做成一个原子操作,今天没有做（见 `modules/day21-milestone-secure-agent/exercise.md`） |

## 未覆盖 / 明确不在这 25 条里的（避免读者误以为清单是完整的）

- 真正的 OS 级沙箱（容器、网络 namespace）——Day18 一开始就说明这超出项目范围。
- 并发写冲突下 `edit_file` 之外的其他工具（`start_job` 等）的 TOCTOU——Day17 只做了后台任务生命周期,没有专门测"任务运行期间关联文件被别的进程改写"这类场景。
- prompt injection 让模型自己决定不去调用 `edit_file`（拒绝执行本身）——这是模型行为层面的问题,不是这个项目的执行层/审批层能保证的事。
