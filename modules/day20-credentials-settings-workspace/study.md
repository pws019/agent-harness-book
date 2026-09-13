# Day 20・白话讲解：凭据、设置、存储与工作区

## 0. 今天在解决什么问题

前面几天已经给 Agent 装上了写文件（Day15）、跑命令（Day16）、后台任务（Day17）、命令策略（Day18）、审批（Day19）——这些能力迟早会需要"访问一个外部系统"，比如调一个需要 API Key 的服务、连一个需要密码的数据库。今天要解决的是：**这些密钥应该怎么在 Agent 内部流动，才不会被模型自己看到、不会被日志意外记录下来。**

同时顺带解决两个相关问题：配置这种东西经常是分层的（系统默认 → 部署环境 → 项目/工作区 → 用户个人），叠在一起之后怎么知道"最后生效的这个值到底是谁定的"；以及"工作区"这个概念除了"一个目录路径"之外，还应该承担什么职责。

## 1. `CredentialRef`：为什么不能直接传密钥字符串

先看类型定义（`src/core/credentials.ts`）：

```ts
export interface CredentialRef {
  readonly id: string
}

export interface CredentialStore {
  resolve(ref: CredentialRef): string
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>()
  set(id: string, value: string): void { this.values.set(id, value) }
  resolve(ref: CredentialRef): string {
    const value = this.values.get(ref.id)
    if (value === undefined) throw new CredentialNotFoundError(ref.id)
    return value
  }
}
```

`CredentialRef` 只有一个字段：`id`，一个字符串名字，比如 `"openai-api-key"`。它本身**不含真实密钥**——`{ id: 'openai-api-key' }` 序列化成 JSON 之后就是这几个字符，看不出背后对应的是哪个真实的 key。

想一下如果没有这层间接会发生什么：如果一个工具的参数直接允许传"密钥的真实值"字符串（比如 `env: { OPENAI_API_KEY: 'sk-...真实值...' }`），这个字符串会流经好几个地方——工具调用的 `args`（可能被记进 Session 日志，见 Day9-10 的 `SessionEvent`）、工具执行失败时的错误信息（`ToolExecutionError` 的 message 里可能原样带出参数）、如果这个 Agent 支持流式输出，甚至可能被回显进模型自己的下一轮上下文。这几个地方都不是"信任边界"意义上安全的地方——它们的设计目的是"记录/展示发生了什么"，不是"保管密钥"。

`CredentialRef` 的解法是**引用和值分离**：模型、Session 日志、错误信息里流动的永远只是这个不透明的 `id`；真实值只活在 `CredentialStore` 内部的一个 `Map` 里，只有调用 `resolve(ref)` 的那一刻才会被读出来。`tests/credentials.test.ts:6-10` 直接验证了这件事：

```ts
const ref: CredentialRef = { id: 'openai-api-key' }
expect(isJsonValue(ref)).toBe(true)               // 可以安全地放进 Session 事件（Day9 的 JSON 值校验）
expect(JSON.stringify(ref)).not.toContain('sk-')  // 序列化结果里不会出现真实密钥的痕迹
```

`isJsonValue` 是 Day9 `src/core/session.ts` 里定义的函数，用来校验一个值是否是"可以安全塞进 Session 日志的纯 JSON 值"——这里复用它，是为了证明 `CredentialRef` 完全够格进日志，不需要为它单独发明一套"部分脱敏"的序列化规则。

`resolve()` 的失败路径也是显式的——查不到就抛 `CredentialNotFoundError`，而不是返回 `undefined` 或空字符串静默放过（`tests/credentials.test.ts:20-23`）。这是因为一个"查不到的凭据"如果被当成空字符串继续往下传，很可能变成"用一个空的 API Key 去调用外部服务"，这种失败会在更下游、更难定位的地方才炸出来。

## 2. `mergeSettings()`：为什么每个值都要带上"谁给的"

配置分层是个老问题：系统有默认值，部署环境可能覆盖一部分，某个工作区/项目又覆盖一部分，用户个人还可能再改一部分。最终生效的值，是"最后一层覆盖前一层"叠出来的。

如果只关心"最后的值是什么"，`Object.assign({}, ...layers.map(l => l.values))` 就够了。但实践中经常需要回答另一个问题：**这个值到底是从哪一层来的？** 比如调试的时候想知道"这个 `maxTokens: 2000` 是部署环境配的，还是用户自己在本地改过"——纯粹的值合并结果回答不了这个问题，因为合并之后只剩下最终的数字，看不出血统。

`src/core/settings.ts` 的做法是让 `mergeSettings` 返回的不是"裸值"，而是"值 + 来源"：

```ts
export type SettingsLayerName = 'default' | 'deployment' | 'workspace' | 'user'

export interface SettingsLayer {
  readonly source: SettingsLayerName
  readonly values: Readonly<Record<string, unknown>>
}

export interface ResolvedSetting {
  readonly value: unknown
  readonly source: SettingsLayerName
}

export function mergeSettings(layers: readonly SettingsLayer[]): Readonly<Record<string, ResolvedSetting>> {
  const result: Record<string, ResolvedSetting> = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      result[key] = { value, source: layer.source }
    }
  }
  return result
}
```

调用方式（`tests/settings.test.ts:6-15`）：

```ts
const merged = mergeSettings([
  { source: 'default', values: { theme: 'light', maxTokens: 1000 } },
  { source: 'deployment', values: { maxTokens: 2000 } },
  { source: 'workspace', values: { theme: 'dark' } },
  { source: 'user', values: {} },
])

merged.theme     // { value: 'dark', source: 'workspace' } —— user 这层没设置 theme，workspace 的选择保留
merged.maxTokens // { value: 2000, source: 'deployment' }  —— workspace/user 都没碰 maxTokens
```

实现只有一层嵌套循环：按 `layers` 数组的顺序（约定为"从最不具体到最具体"，即 `[default, deployment, workspace, user]`）依次遍历每一层的 `values`，后面的层如果有同名 key 就直接覆盖 `result[key]`，同时把 `source` 也换成当前这一层的名字。**没有专门为"跳过某层"写 if 分支**——一个 `for...of Object.entries(layer.values)` 天然只会遍历这一层真正存在的 key；某一层的 `values` 里根本不存在的 key，这层的循环体压根不会执行到它，`result` 里这个 key 保留的自然还是上一层写入的 `{value, source}`。

这里有一个值得专门确认的问题：**"某一层没设置某个 key"和"某一层把这个 key 设置成了 `false`/`0` 这种 falsy 值"，会不会被 `mergeSettings` 混为一谈？** 用真值表说清楚这四种组合：

| 当前层的 `values` 里这个 key 的状态 | `Object.entries` 会不会产出这一条 | 这一层会不会覆盖 `result[key]` |
|---|---|---|
| key 不存在（真正的"没设置"） | 不会 | 不会——保留上一层的值 |
| key 存在，值是 `false` | 会 | 会——`false` 覆盖上一层 |
| key 存在，值是 `0` | 会 | 会——`0` 覆盖上一层 |
| key 存在，值是 `undefined`（显式赋值成 undefined） | 会（`Object.entries` 照样列出这个 key） | 会——`undefined` 覆盖上一层 |

`tests/settings.test.ts:30-39` 直接验证了中间两行：

```ts
const merged = mergeSettings([
  { source: 'default', values: { debug: true, retries: 3 } },
  { source: 'user', values: { debug: false, retries: 0 } },
])
expect(merged.debug).toEqual({ value: false, source: 'user' })   // false 真的覆盖了 true
expect(merged.retries).toEqual({ value: 0, source: 'user' })     // 0 真的覆盖了 3
```

这个区分不是靠专门写的特殊判断逻辑换来的，而是 `Object.entries()` 本身的语义天然保证的：它只列出对象自身真正拥有的 key，"key 不存在"和"key 存在但值是 falsy"从一开始就是两种不同的情况，`mergeSettings` 只是没有画蛇添足地用类似 `if (layer.values[key])` 这种会把 falsy 值误判成"没设置"的写法。如果哪天有人"优化"成这种写法，`retries: 0` 会被错误地当作"这层没配置"而漏掉——这正是这条规则要提醒警惕的坑。

`tests/settings.test.ts:25-27` 还验证了另一个边界：`mergeSettings([])` 返回 `{}` 而不是抛错——空的层列表就是"什么配置都没有"，是一个合法的空结果，不是异常状态。

## 3. Workspace：为什么是"身份边界"，而不只是一个 cwd 字符串

到目前为止，`createRunCommandTool(root: string)`、`createEditFileTool(root: string)` 这些工厂函数里的 `root` 只是一个字符串路径，工具用它来算"这次操作不能跑出这个目录"（`resolveWithinRoot`，Day15 引入）。这个模型是够用的，但只覆盖了"文件系统边界"这一件事。

一个真实的工作区（比如"这个项目的沙箱环境"）往往还需要回答别的问题：这个工作区可以用哪些凭据？它的配置（比如允许跑多久的命令、允许连哪些命令白名单）是什么？`src/core/workspace-context.ts` 把这些东西装进一个类型里：

```ts
export interface WorkspaceContext {
  readonly root: string
  readonly credentials: CredentialStore
  readonly envCredentials?: Readonly<Record<string, CredentialRef>>
}
```

`root` 还是原来的路径边界；`credentials` 是这个工作区能访问的凭据存储；`envCredentials` 是"这个工作区默认要往子进程环境里注入哪些凭据，注入成哪个变量名"——比如 `{ OPENAI_API_KEY: { id: 'openai-api-key' } }` 表示"这个工作区跑命令时，环境变量 `OPENAI_API_KEY` 应该被设成 `openai-api-key` 这个凭据解析出来的真实值"。

**今天没有做的事**：把 `WorkspaceContext` 强行穿进 Day4（`search_text`）、Day15（`edit_file`）、Day16（`run_command`）已有的每一个 `createXTool(root: string)` 签名,把它们统一改成 `createXTool(workspace: WorkspaceContext)`。这是一次纯粹的机械重构——改动面覆盖好几个文件，但每个改动点的逻辑都是"以前用 `root`，现在用 `workspace.root`",概念上不会教会你任何新东西。这里选择只在一个地方做一次真正有信息量的示范：`run_command` 接一个可选的 `workspace` 参数，用它的 `envCredentials` 往子进程环境里注入凭据。如果将来某天真的需要工作区级别的凭据/设置覆盖到 `edit_file`、`search_text` 这些工具,重构方式是完全一样的,只是今天没有为了"覆盖率好看"而提前把所有工具都改一遍。

## 4. `run_command` + `envCredentials`：解析时机与覆盖顺序

看 `src/tools/bash-tool.ts` 里实际接入的代码（`src/tools/bash-tool.ts:124-137`）：

```ts
// 白名单环境：只有 PATH（找可执行文件必需）+ 调用方显式传入的变量。
const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...(args.env ?? {}) }

// workspace 预先配置好的凭据：解析真实值的时机就在这里、这一刻——
// 模型的 args 里从来没出现过真实密钥，只是 workspace 自己决定这次调用该带上哪些凭据。
// 放在 args.env 之后合并，故意让它能覆盖模型自己传的同名变量。
if (workspace?.envCredentials) {
  for (const [key, ref] of Object.entries(workspace.envCredentials)) {
    env[key] = workspace.credentials.resolve(ref)
  }
}
```

这段代码里有两个顺序决定，都是刻意的：

**第一，`resolve()` 调用的时机**——不是在 `WorkspaceContext` 构造的时候提前把凭据都解析好塞进一个 `Record<string, string>`，而是延后到 `run_command` 真正要 spawn 子进程的这一刻才调用 `resolve()`。这样做的好处是：如果这次调用最终因为策略拒绝（Day18 的 `CommandPolicy`）或者路径校验失败而提前 `throw`，真实密钥字符串从来没有被计算出来过,不会出现在任何一个中间变量里等着被意外打印。

**第二，合并顺序**——`workspace.envCredentials` 的注入代码写在 `{ PATH, ...args.env }` **之后**，意味着如果模型自己在 `args.env` 里传了一个同名的 `OPENAI_API_KEY`，会先被写进 `env`，然后立刻被 workspace 配置的真实凭据覆盖掉。`tests/workspace-context-integration.test.ts:45-65` 验证了这一点：

```ts
const result = await registry.execute('run_command', {
  command: NODE,
  args: ['-e', 'process.stdout.write(process.env.OPENAI_API_KEY ?? "(missing)")'],
  env: { OPENAI_API_KEY: 'model-supplied-fake-value' }, // 模型自己想传一个同名变量
}, ctx())
expect(result.content).toContain('sk-real-secret-value')      // workspace 配置的凭据赢了
expect(result.content).not.toContain('model-supplied-fake-value')
```

为什么必须是 workspace 赢，而不是"先到先得"或者"模型传的更具体所以模型赢"：`args.env` 完全由模型的工具调用参数决定,如果模型（无论是被 prompt injection 操纵,还是单纯生成了错误的参数）传一个同名变量,不应该有能力顶替掉工作区管理者预先配置好、本该注入的那个真实凭据——这是一条从 Day16 环境变量白名单（`env` 参数本身就是显式声明,不继承宿主进程）延伸出来的同一种"调用方的输入不能扩大自己的权限"原则,只是这次的调用方从"宿主进程环境"换成了"模型自己传的参数"。

反过来,如果没有传 `workspace`（`tests/workspace-context-integration.test.ts:67-78`）,`run_command` 的行为跟 Day16/18 完全一样——没有任何凭据被注入,`workspace` 参数是纯粹可选的增量能力,不影响任何已有调用方。
