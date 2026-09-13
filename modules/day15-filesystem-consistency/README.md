# Day 15・文件系统能力与一致性

> 阶段：III. 受控执行与人机协作（开篇）　|　产出：`src/tools/workspace.ts` 补上 symlink 逃逸检测，新增 `src/tools/file-io.ts`，`src/tools/fs-tools.ts` 新增写工具 `edit_file`

## 今天要学会什么

1. 理解 `resolveWithinRoot` 之前只做的"字符串层面 `../` 检测"和今天补上的"symlink 真实路径检测"分别挡住什么、为什么两层都要。
2. 理解什么是 TOCTOU（读的时候是一个状态，写的时候变成另一个状态），以及 `edit_file` 靠 `expectedHash` 怎么把这类并发覆盖变成一次明确失败，而不是"最后写入者获胜"。
3. 理解为什么 `edit_file` 是一个"深接口"——同一个工具、同一组参数覆盖新建/覆盖/预览三种意图，而不是拆成三个各管一段的浅工具。
4. 能说出二进制文件检测、超大文件拒绝这两条边界防护分别防的是什么后果。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码：先看 `src/tools/workspace.ts` 里 `resolveWithinRoot` 和新加的 `safeRealpath`，再看 `src/tools/file-io.ts`（hash、二进制检测、原子写、朴素 diff 都在这里），最后看 `src/tools/fs-tools.ts` 里的 `edit_file`。
3. 跑 `tests/fs-tools-integration.test.ts`，重点看 symlink 逃逸和"跨工具集成"那条 hash 传递测试。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：一个字符串上看起来老老实实待在 workspace 里的路径，为什么磁盘上打开的文件可能其实在 workspace 外面？
- 你能解释：`edit_file` 在"文件已存在但没传 `expectedHash`"和"`expectedHash` 传了但跟磁盘不一致"这两种情况下，分别为什么要拒绝，而不是二选一地放行？
- 你能解释：为什么 `edit_file` 不需要一个专门的"创建文件"工具和一个专门的"覆盖文件"工具分开做？
- `pnpm test` 全绿。
