# Day 21・里程碑三：安全执行型 Agent

> 阶段：III. 受控执行与人机协作（收尾）　|　产出：`src/propose-edit.ts`、`cli.ts` 的 `propose-edit` 子命令、25 条安全测试索引、事故演练文档

## 今天要做什么

不引入新概念，把 Day15-20 各自独立验证过的机制真正串成一条能从命令行跑起来的链路：读文件 → 生成新内容（确定性规则，不接真实模型）→ 展示 diff → 走审批（人工确认或 Day19 权限预设）→ 批准才写盘 → 跑一个验证命令。这是阶段三的毕业考核，跟 Day7/Day14 是同一种性质的收尾——不读新文档，考验"能不能把已经分别可靠的部件组装成一条可靠的链路"。

```bash
cd mini-harness
pnpm cli -- propose-edit --workspace <你自己的项目路径> --file notes.txt --find TODO --replace DONE
pnpm cli -- propose-edit --workspace <目录> --file notes.txt --find TODO --replace DONE --preset autonomous
pnpm cli -- propose-edit --workspace <目录> --file notes.txt --find TODO --replace DONE --verify-command node --verify-args "-e process.exit(0)"
```

## 这一层是怎么拼起来的

```
cli.ts runProposeEditCommand()
  ├─ 解析 --workspace/--file/--find/--replace/--preset/--verify-command/--verify-args
  └─ proposeEdit()（src/propose-edit.ts）
       ├─ 读磁盘当前内容（不存在就当成从空内容开始）
       ├─ generateEditProposal()：确定性查找替换，生成 newContent + diff（Day7 HeuristicInvestigationAdapter 同款思路：用写死的规则代替真实模型）
       ├─ 没有实际改动 → 直接返回 no-changes，不生成审批请求
       ├─ ApprovalStore.create()（Day19）：绑定 file_path/content/expectedHash 这组具体参数
       ├─ preset？（Day19 permission-presets）
       │    ├─ auto-approve → 跳过人工确认
       │    ├─ deny → 直接拒绝，requestApproval() 从不被调用
       │    └─ require-approval / 没给 preset → 调用 requestApproval()（CLI 默认实现：真的在终端问一句；测试注入固定返回值）
       ├─ 批准 → ApprovalStore.consume() 烧掉 nonce
       ├─ 用 ToolRegistry 真正执行 edit_file（Day15）
       └─ 给了 --verify-command → 用 ToolRegistry 执行 run_command（Day16，可选接 Day18 CommandPolicy）
```

## 一个诚实记录的缺口：审批消费和真正落盘之间有一个没有原子化的窗口

`ApprovalStore.consume()` 发生在调用 `edit_file` **之前**。如果文件在这两步之间被别的进程改写，`edit_file` 会因为 `expectedHash` 对不上而失败——但这次批准的 nonce 已经被消费掉了，不能用同一个 nonce 重试，只能重新走一遍完整的 `proposeEdit()`（重新读取最新内容、重新申请一次新的审批）。

这跟 Day9/Day13/Day14 反复出现的"孤立测每一边都没问题，串起来跑才暴露"是同一类坑——但这次不是一个 bug，是一个已知、可以接受、写进了 `tests/propose-edit.test.ts` 专门验证并且在 `src/propose-edit.ts` 顶部文档注释里点名承认的设计取舍。要真正修复需要把"消费 nonce"和"落盘成功"合并成一个原子操作（比如 `consume()` 接受一个"真正执行"的回调，只有回调成功才真正标记消费，失败就把 nonce 退回去），今天没有做，留给 exercise.md。

## 怎么学

1. 读代码：`src/propose-edit.ts`，再看 `src/cli.ts` 里 `runProposeEditCommand`/`promptApproval` 部分。
2. 跑 `tests/propose-edit.test.ts`（11条，覆盖批准/拒绝/无变更/两种 preset/验证成功与失败/审批-落盘竞态这个诚实缺口）。
3. 读 [security-test-index.md](./security-test-index.md)——25 条安全回归测试的跨天索引，不是新写的 25 条，是把 Day15-21 已经各自验证过的安全属性汇总起来。
4. 读 [incident-drill.md](./incident-drill.md)——一次假设的安全事件演练，走一遍发现→止血→复盘。
5. 做 [exercise.md](./exercise.md)。

## 阶段门禁（对照原 30 天大纲）

- [x] **默认只读，副作用经过确定性 policy**：`propose-edit` 的写入路径（`edit_file`）永远经过 `ApprovalStore`/`PermissionPreset` 的判断；只读工具（`read_file`/`list_files`/`search_text`，Day4）本身不需要审批。
- [x] **审批绑定精确动作**：`ApprovalRequest.argsHash` 绑定的是 `{file_path, content, expectedHash}` 这组具体参数，不是一句抽象的"继续"——`tests/approval.test.ts:34` 验证换参数就会失败。
- [x] **sandbox 故障关闭**：`FailClosedCommandPolicy`（Day18）在策略求值本身抛异常时拒绝而不是放行，`propose-edit` 的 `--verify-command` 步骤如果接了 `CommandPolicy` 会继承这条保证。
- [x] **每次外部副作用都有 audit 记录**：`ApprovalStore` 的每一次 `create()`/`consume()` 都是一条可追溯的记录（今天是内存实现，持久化留给 exercise.md 思考）；`edit_file` 的返回值里带 `previousHash`/`newHash`，可以确认改动的具体版本变化。
- [ ] **你能不看代码，解释清楚"为什么审批消费要放在 `edit_file` 之前而不是之后，这个顺序选择本身带来了什么权衡"**——这个由你自己在 exercise.md 里写下来。

## 复盘问题（写在你自己的笔记里，不需要提交）

- 阶段三这7天（Day15-21）里，哪些防线是"这个具体威胁模型"决定的（比如 symlink 检测只因为 workspace 是一个真实文件系统），哪些是可以直接套用到任何"给 Agent 写权限"场景的通用模式（比如"引用而不是真实值""审批绑定精确参数"）？
- 如果要把 `propose-edit` 从"CLI 演示"升级成"真的给一个自动化流水线用"，`incident-drill.md` 里提到的"预设无法感知具体调用参数（比如目标路径）"这个限制，应该怎么设计接口去解决？
