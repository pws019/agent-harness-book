# Day 21 实践任务

## 任务 1：跑起来，指向你自己的项目

```bash
cd mini-harness
echo "TODO: fix bug" > /tmp/notes.txt
pnpm cli -- propose-edit --workspace /tmp --file notes.txt --find TODO --replace DONE
```

回答 `y`，确认 `/tmp/notes.txt` 真的被改写。再跑一次同样的命令但回答 `n`，确认文件没有变化。然后分别加上 `--preset autonomous`（应该完全不弹出确认提示，直接生效）和 `--preset readonly`（应该直接拒绝，也不弹出确认提示）跑一遍，观察行为差异。

## 任务 2：亲手验证"审批消费的时机"这个设计决定

`src/propose-edit.ts` 里 `approvalStore.consume(request.nonce, args)` 写在真正调用 `edit_file` **之前**。把这一行挪到 `edit_file` 调用**之后**（紧跟在 `const editValue = ...` 那一行下面）：

```ts
const editResult = await tools.execute('edit_file', args, exec)
const editValue = editResult.value as { readonly newHash: string | null }
approvalStore.consume(request.nonce, args)
```

重新跑：

```bash
pnpm vitest run tests/propose-edit.test.ts
```

确认"honest gap: if the file changes after approval is consumed..."这条测试**失败**了——`edit_file` 因为文件被改写而抛错之后,`store.consume('approval-0', originalArgs)` 反而**成功**了（不再抛 `ApprovalAlreadyConsumedError`），因为这次 nonce 根本没有被消费过。

想一想：这样改是不是"修好了"README 里说的那个缺口？再想一层——如果 `edit_file` 内部先做了别的、真正有副作用但不体现在 `newHash` 里的操作（这个项目里没有,但设想一个更复杂的写工具确实有这种情况）,把 `consume()` 挪到"写操作完全成功之后"是否总是安全？（提示：想一想如果 `edit_file` 已经真的把文件写到了磁盘上,只是返回结果给调用方的过程中网络/进程出了问题,`consume()` 还没来得及执行——这时候"文件已经改了"和"批准还没消费"两个事实同时成立,是不是也是一种新的不一致。）

跑完记得把这一行挪回原来的位置，确认全部测试恢复通过。

## 任务 3：给 `PermissionPreset` 加一个能感知目标路径的版本

`incident-drill.md` 里提到的限制：`PermissionPreset.decide(toolName)` 只看工具名,看不到"这次调用具体要改哪个文件"。设计（不一定要写完整实现,但至少要写出类型签名+核心判断逻辑）一个 `PathAwarePermissionPreset`：

- 除了工具名,还能接收一个"这次调用的目标路径"参数（对 `propose-edit` 来说就是 `filePath`）。
- 配置一份"敏感路径"列表（比如 `.github/`、`*.yml`），命中这份列表的路径,无论全局 preset 是什么,一律强制 `require-approval`,即使全局 preset 是 `autonomous`。
- 想一想：这个新接口要不要保持向后兼容——已经写好的 `readonly`/`balanced`/`autonomous` 三个 preset 要不要跟着改签名？（提示：这是一次"设计两次"的机会,对比"改动现有 `PermissionPreset.decide()` 签名,让所有实现都被迫多接一个参数"和"新增一个单独的、只在需要路径感知的场景下使用的接口,两者共存"这两种方案的权衡。）

## 任务 4（毕业问答，写在自己的笔记里）

不需要写代码，用你自己的话回答——如果面试官问你："给 Agent 加'写文件'这种有副作用的能力，最容易被忽略的坑是什么？"，结合阶段三这七天（Day15-21）学到的东西，你会怎么回答？至少提到：

1. 为什么"模型自己说它会先读文件再写"这种约定不能替代 `expectedHash` 这种由代码强制执行的机制。
2. 为什么审批不能是一句"要不要继续"的 yes/no，必须绑定具体参数。
3. 举一个"防线分层"的具体例子——某个攻击场景需要好几层机制一起起作用才能被完全挡住,单独任何一层都不够（可以直接引用 `incident-drill.md` 里的表格）。

## 验收自查

- [ ] `pnpm test` 全绿，包括 `tests/propose-edit.test.ts`。
- [ ] 我亲手跑过 `pnpm cli -- propose-edit`（批准/拒绝/两种 preset 各跑一遍），不是只看单元测试绿了就当完成。
- [ ] 我能解释：为什么把 `approvalStore.consume()` 挪到 `edit_file` 之后会让"审批消费时机"这条测试反过来通过，以及这个改动本身是否引入了新的不一致风险（任务2第二问）。
- [ ] 我写完了任务3的 `PathAwarePermissionPreset` 设计，明确说了要不要改动现有三个 preset 的签名，给出了理由。
- [ ] 我写完了任务4的毕业问答，每一条都有具体机制支撑，不是空话。
