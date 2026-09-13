# 白话讲解：文件系统能力与一致性

## 0. 前置知识

### 0.1 什么是 TOCTOU

TOCTOU 是 "Time-Of-Check to Time-Of-Use" 的缩写：你"检查"一个东西的那一刻，和你真正"使用"它的那一刻，中间隔了一段时间——这段时间里，东西可能已经变了。

类比一下：你和同事都在改同一份 Word 文档。你打开文档看了一眼（"检查"），确认改动位置没问题，然后开始动笔改（"使用"）。但就在你看完、还没保存的这段时间里，同事已经把文档改了并保存了。你保存的时候，会直接把同事的改动整个覆盖掉——因为你保存的是"基于你看到的那个旧版本改出来的新版本"，你的操作系统/程序完全不知道中间发生过别的修改。

对 Agent 来说，`read_file` 就是"检查"，`edit_file` 就是"使用"。如果两次调用之间文件被别的东西（另一个 Agent、用户自己、另一个进程）改了，Agent 却拿着"检查"时看到的旧内容去决定"使用"时要写什么，就会在不知情的情况下把别人的修改覆盖掉。

### 0.2 乐观并发控制：用一个"版本指纹"代替加锁

解决 TOCTOU 常见的思路之一叫**乐观并发控制**（optimistic concurrency control）：不去真的锁住文件不让别人动（那是"悲观"的做法，成本高、还可能死锁），而是让"检查"的一方带走一个能代表"当前版本"的指纹，等它真的要"使用"（写入）的时候，先拿这个指纹跟当前的真实版本核对一遍——对得上，说明这段时间没人动过，正常写入；对不上，直接拒绝，让调用方知道"你手里的版本已经过期了，回去重新检查一遍"。

这跟做前端时可能见过的 HTTP `ETag`/`If-Match` 是同一个思路：服务器返回资源时带一个 `ETag`（内容指纹），你要更新这个资源时把 `ETag` 一起发回去，服务器发现指纹不匹配就返回 409 Conflict，而不是直接用你的内容覆盖别人刚写的版本。

Day15 里，这个"版本指纹"就是文件内容的 sha256 哈希，`read_file` 返回的 `contentHash` 扮演 `ETag` 的角色，`edit_file` 的 `expectedHash` 扮演 `If-Match` 的角色。

## 1. `resolveWithinRoot`：两道关卡，各挡一类攻击

调用方是谁：`read_file`/`list_files`/`search_text`/`edit_file` 这四个工具，在真正碰文件系统之前，全都先把模型给的相对路径交给同一个函数 `resolveWithinRoot(root, requestedPath)` 过一遍。它要回答一个问题：这条路径，不管模型怎么拼，最终会不会指到 workspace 之外？

```
模型给的路径（比如 "../../etc/passwd" 或 "looks-local.txt"）
        │
        ▼
resolveWithinRoot(root, requestedPath)
        │
        ├─ 第一道：字符串层面判断（原来就有的检测）
        │        resolve(root, requestedPath) 折叠掉 "../" 之后，
        │        结果还在不在 root 底下？
        │
        └─ 第二道：真实路径判断（Day15 新增）
                 root 和 target 各自 realpath（顺着 symlink 走到底）之后，
                 结果还在不在彼此的真实路径关系内？
        │
        ▼
   在 root 内 → 返回可以安全打开的绝对路径
   不在 root 内 → 抛 PathEscapeError，工具的 execute() 完全不会跑到打开文件那一步
```

第一道关卡防的是最直接的攻击：模型直接在参数里写 `../../etc/passwd` 这种路径。`resolve()` 会把 `..` 折叠掉，折叠完的结果一旦跑出 root，就直接拒绝——这在 Day4 就有了（[workspace.ts:22](../../mini-harness/src/tools/workspace.ts)）。

第二道关卡防的是一种更隐蔽的情况：路径字符串本身完全没有 `..`，看起来老老实实待在 workspace 里，比如 `looks-local.txt`。但如果 `looks-local.txt` 其实是一个符号链接（symlink），指向 workspace 外面的某个文件，那么"字符串"层面它没有逃逸，"磁盘上真正打开的文件"却逃逸了。这就是为什么需要 `realpath`——它会顺着 symlink 一路走到底，给出这条路径最终真正对应的物理位置。

### 真值表：路径是否存在 × 是否经过 symlink × 真实位置在不在 root 内

| 路径本身在字符串层面是否越界（第一道） | 中间是否经过 symlink | symlink 真实指向是否还在 root 内 | 结果 |
|---|---|---|---|
| 是（比如 `../secret.txt`） | 不重要 | 不重要 | 第一道关卡直接拒绝，不会走到 symlink 检测 |
| 否 | 否 | 不适用（没有 symlink） | 放行 |
| 否 | 是 | 是（比如 workspace 内部的 `alias-dir -> real-dir`） | 放行 |
| 否 | 是 | 否（比如 `looks-local.txt -> /outside/secret.txt`） | 第二道关卡拒绝，`PathEscapeError` |

`safeRealpath`（[workspace.ts:46](../../mini-harness/src/tools/workspace.ts)）还要处理一种边界情况：`edit_file` 可能是在**新建**一个文件，这条路径本身在磁盘上还不存在，没法直接对它调用 `realpath`（会报"文件不存在"）。做法是顺着路径往上找到第一个**真实存在**的祖先目录，对这个祖先目录做 `realpath`，再把还不存在的那一段路径原样拼回去——这样"最终会落在哪个真实目录下"依然算得出来，不用等文件真的建出来才能检查。

## 2. `edit_file`：一个深接口，三种意图

### 2.1 调用方是谁，`expectedHash` 从哪来

```
调用方（模型 / Agent loop 里驱动工具调用的那一层）
   │
   │ 1. 先调 read_file，拿到当前内容和 contentHash
   ▼
read_file 的 execute()（fs-tools.ts:93）
   │   contentHash: contentHash(raw)   ← 这个 hash 是"读到的这份内容"的真实指纹
   ▼
返回给模型的文本里带着这个 hash（render() 里拼进 "contentHash: ..." 这段）
   │
   │ 2. 模型把这个 hash 原样抄进下一次 edit_file 调用的 expectedHash 参数
   ▼
edit_file 的 execute()（fs-tools.ts:376-397）
   │   重新读一遍磁盘上现在的内容，算出 previousHash
   │   比较 args.expectedHash 和 previousHash 是否一致
   ▼
一致 → 允许写入；不一致 → 抛 ToolExecutionError，拒绝覆盖
```

对照代码，`ReadFileValue` 长这样（裁剪版）：

```ts
interface ReadFileValue {
  readonly lines: readonly string[]
  readonly contentHash: string   // 当前磁盘内容的 sha256
}
```

`edit_file` 的参数长这样（裁剪版）：

```ts
interface EditFileArgs {
  readonly file_path: string
  readonly content: string        // 编辑之后的完整内容，不是 diff
  readonly expectedHash?: string  // 抄自某次 read_file 的 contentHash
  readonly dryRun?: boolean
}
```

`contentHash` 这个值的血统很短，但每一步都值得点名：**产生**在 `read_file` 的 `execute()` 里（[fs-tools.ts:93](../../mini-harness/src/tools/fs-tools.ts)），对刚读出来的原始文本调用 `contentHash(raw)`；**转发**到模型能看见的渲染文本里（`render()` 把它拼进那一行"contentHash: ..."），模型只能通过读到的文本获得这个值，没有别的途径；**被消费**在 `edit_file` 的 `execute()` 里（[fs-tools.ts:394](../../mini-harness/src/tools/fs-tools.ts)），和它重新读盘算出的 `previousHash` 做字符串比较。中间没有第三方转发或存储它——这也是为什么"模型必须先读再改"：不读就拿不到这个值，拿不到就没法通过"文件已存在"这一支判断（见下面的真值表）。

### 2.2 真值表：文件是否已存在 × 是否传了 `expectedHash`

| 文件是否已存在 | 是否传了 `expectedHash` | `expectedHash` 是否等于当前磁盘的 hash | 结果 |
|---|---|---|---|
| 不存在 | 没传 | 不适用 | 正常创建（[fs-tools.ts:383-388](../../mini-harness/src/tools/fs-tools.ts) 之前那一支） |
| 不存在 | 传了 | 不适用 | 拒绝——"文件还不存在，不要猜一个 hash 出来" |
| 已存在 | 没传 | 不适用 | 拒绝——"文件已经存在，你必须先 read_file 拿到当前 hash 再改" |
| 已存在 | 传了 | 一致 | 允许覆盖 |
| 已存在 | 传了 | 不一致 | 拒绝——"文件在你读完之后又被改过了，回去重新读一遍" |

四种"拒绝"里，中间那条（"已存在但没传 hash"）单独存在的意义容易被忽略：如果没有这一条，模型完全可以跳过 `read_file`，直接靠猜内容调 `edit_file` 把一个自己根本没看过的文件覆盖掉——这跟"最后写入者获胜"是一回事，只是把"两个并发写者"换成了"一个从没读过就写的调用方"。强制要求"已存在的文件必须先证明你读过它"，把这条路直接堵死。

### 2.3 为什么是一个工具、三种意图，而不是拆成三个工具

`edit_file` 同时处理"新建文件"（`expectedHash` 缺省）、"覆盖已有文件"（`expectedHash` 匹配）、"只看预览不落盘"（`dryRun: true`）——没有拆成 `create_file`/`overwrite_file`/`preview_edit` 三个工具。原因是这三种意图共享同一套边界检查（路径合法性、二进制检测、大小限制）和同一套"要不要真的写盘"的收尾逻辑，拆开只会让三个浅工具各自重复一遍这些检查，还要在文档里额外解释"这三个工具用哪个"。用两个参数（`expectedHash` 有没有传、`dryRun` 是不是 true）表达三种意图，调用方（模型）只需要理解一套参数含义，复杂度收在这一个函数内部，不会转嫁给"选工具"这一步。

### 2.4 `isConcurrencySafe: () => false` 现在其实没人读

`edit_file` 的定义里显式写了 `isConcurrencySafe: () => false`（[fs-tools.ts:361](../../mini-harness/src/tools/fs-tools.ts)）。这个字段从 Day4 `ToolDefinition` 接口定义出来就存在，但翻遍 `src/`，`registry.ts`/`agent-loop.ts` 目前都没有任何地方真的读取它去做"要不要并发调度"的决策——`grep -rn isConcurrencySafe src/` 除了三个工具各自的定义，没有第二个消费者。这是一个诚实的"目前没有调用方"的情况：这个字段是为未来某天（模型一次性发起多个工具调用、需要决定哪些可以并行跑）预留的接口，`edit_file` 只是第一个认认真真按语义把它标成 `false` 的工具（三个只读工具此前都标的是 `true`）。等哪天调度器真的开始读这个字段，`edit_file` 不需要回头改。

## 3. 二进制检测和大小限制：把"读不出正确结果"变成"明确拒绝"

`read_file`/`edit_file` 在真正处理内容之前，都会先做两件事：

1. 检查字节数有没有超过 `MAX_FILE_BYTES`（2MB）——超过就直接拒绝，不做"读一部分就好"这种静默截断。截断读一个文本文件的后果是模型看到一份不完整还不自知的内容，比明确报错更危险。
2. 检查内容像不像二进制——`looksBinary()`（[file-io.ts:34](../../mini-harness/src/tools/file-io.ts) 调用处）采样前 8000 字节找有没有 NUL 字节，这是 git 判断一个文件是不是文本文件用的同一条经验规则。命中就拒绝，不尝试把图片、可执行文件这类二进制内容硬当 UTF-8 文本解码——解码出来的是一堆乱码字符，模型如果基于这堆乱码做判断，产出的结论毫无意义,而且这种"看起来是文本、其实是垃圾"的输出比一个明确的报错更难排查。

这两条防护都定义在同一个"打开文件、决定能不能继续往下走"的入口处，`read_file` 和 `edit_file`（编辑已有文件时）都会经过，不需要各自重复实现。

## 一句话总结

Day15 做的事情可以概括成一句话：把"这条路径到底通向哪里"和"这份内容到底是不是我以为的那个版本"这两个此前靠"模型别乱来"支撑的假设，换成了磁盘真实路径比对和内容哈希比对这两个不依赖模型自觉性的机制——路径逃逸和覆盖并发修改都不再是"希望不要发生"的问题，而是"发生了就会被明确拒绝"的问题。
