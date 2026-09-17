# threat-model.md：汇总，不重写

这门课的威胁建模工作已经在三个地方做过，今天不重新写一遍，只做索引：

- **`modules/day18-sandbox-and-least-privilege/study.md`**——原始威胁模型：子进程能力边界、env 白名单、fail-closed policy 的设计动机。
- **`modules/day21-milestone-secure-agent/security-test-index.md`**——25 条安全回归测试索引（路径逃逸、symlink 逃逸、写入一致性/TOCTOU、子进程环境隔离、shell 注入五类）。
- **`modules/day21-milestone-secure-agent/incident-drill.md`**——一次假设的安全事件演练。
- **`modules/day29-load-chaos-security-gate/study.md`** §3——SSRF（延续 Day18 立场，不是新发现）、Workflow 脚本结构上传不出权限提升。

## 今天（Day30）新增的攻击面：仅一处，评估如下

`graduation-demo.ts` 新增了 `Agent.compact()` 这一个公开方法，以及 `applyCompaction()` 新增的 `sink?` 参数。两者都不引入新的信任边界——`compact()` 只操作调用方自己已经持有的 `Agent` 实例的内部历史，不接受任何来自模型/外部输入的参数（`keepRecentSurfaceEvents` 是调用方直接给的数字，不是模型工具调用的参数）,不在这门课"模型可能是恶意的"这条威胁模型的关注范围内。

`graduation-demo.ts` 本身把 Day1-29 的能力串成一条命令,没有放宽任何一层已有的 policy/审批/预算检查——`proposeEdit()` 依然要走 `ApprovalStore`,`JobRuntime.start()` 依然是被审计过的批准触发的,没有新增绕过路径。

## 汇总表：阶段四/五共 30+3 条已索引测试，覆盖哪些威胁类别

| 威胁类别 | 索引位置 |
|---|---|
| 路径逃逸 / symlink 逃逸 | `day21-milestone-secure-agent/security-test-index.md` §1-2 |
| 写入一致性 / TOCTOU | 同上 §3 |
| 子进程环境隔离 / shell 注入 | 同上 §4-5 |
| 网络外传 / fork bomb | `red-team-regression.test.ts` 场景1-5 |
| SSRF | `red-team-regression.test.ts` 场景6（Day29 新增） |
| Workflow 权限提升 | `red-team-regression.test.ts` 场景7（Day29 新增） |
| HTTP 层准入/幂等/积压 | `day22-http-server-and-streaming/study.md` §4/6-7 |
| 委派权限升级 / 预算耗尽 | `day26-subagent-isolation-delegation-budget/` 测试 |
