# 白话讲解：审批、权限预设与用户问答

> 素材来源：DSH `docs/subsystems/approval.zh.md`、`docs/subsystems/permission-presets.zh.md`、`docs/subsystems/user-questions.zh.md`。今天只交付 `ApprovalStore`/`UserInteractionRequest`/三个权限预设这几个独立机制,不改动 Day5 的 `runTurn`——真正接进循环留到 Day21 milestone,原因见第3节。

## 0. 前置知识：什么是 nonce，为什么审批要绑定"这一组具体参数"

如果你做过登录/支付相关的前端功能，可能见过 "nonce"（number used once，只用一次的数）这个词——比如 OAuth 流程里防重放攻击用的那个随机字符串。核心思想很简单：**一个只能被成功使用一次的凭证**，用过一次之后就永久失效,即使原样再发一次也不会再生效。今天的 `ApprovalRequest.nonce` 就是这个概念——每次批准请求分配一个独一无二的 nonce,`ApprovalStore.consume()` 保证同一个 nonce 最多只能真正生效一次。

**为什么审批不能只是"用户点了一下同意"这么简单**：如果批准只是一个全局的"已同意"标志，攻击者（或者一个有 bug 的重试逻辑）完全可以在用户同意"删除 `a.txt`"之后，用同一次同意去执行"删除 `b.txt`"——因为"同意"这个状态本身没有跟"同意的到底是哪一次、哪组参数"绑在一起。今天的 `ApprovalRequest` 把 nonce、要执行的动作（`action`）、目标（`target`）、参数的哈希（`argsHash`）全部打包成一个不可分割的整体,批准的是"这一组具体的东西",不是"泛泛地同意继续"。

## 1. 三种交互类型：不共用一个含糊的 yes/no

**先讲问题**：如果"需要用户输入点什么"只用一个 `{ prompt: string }` 表示,调用方没法从类型上区分"这次该弹一个自由文本输入框""这次该弹一个选项列表""这次该弹一个'批准/拒绝'按钮"——三种场景对用户来说是完全不同的 UI,对系统来说风险等级也完全不同（信息缺失问题答错了顶多重问一次,风险审批批错了可能是删了个文件）。

```ts
export type UserInteractionRequest =
  | { readonly kind: 'question'; readonly prompt: string }
  | { readonly kind: 'choice'; readonly prompt: string; readonly options: readonly string[] }
  | { readonly kind: 'approval'; readonly request: ApprovalRequest }
```

（[approval.ts:98-101](../../mini-harness/src/core/approval.ts)）跟 Day2 `StreamChunk`、Day8 `SessionEvent` 是同一套"封闭联合类型 + `assertNever` 兜底"手法——以后要加第四种交互类型,所有处理这个联合类型的 `switch` 都会被编译器逼着补上新分支,不会漏掉。

## 2. `ApprovalStore.consume()`：四个校验，各防一种原始大纲点名的故障场景

```ts
consume(nonce: string, args: unknown, now: number = Date.now()): void {
  const entry = this.requests.get(nonce)
  if (!entry) throw new ApprovalNotFoundError(nonce)
  if (entry.consumed) throw new ApprovalAlreadyConsumedError(nonce)
  if (now > entry.request.expiresAt) throw new ApprovalExpiredError(nonce)
  if (contentHash(JSON.stringify(args)) !== entry.request.argsHash) throw new ApprovalArgsMismatchError(nonce)
  entry.consumed = true
}
```

（[approval.ts:79-86](../../mini-harness/src/core/approval.ts)）

| 校验 | 防住原始大纲的哪个场景 | 失败时的错误类型 |
|---|---|---|
| nonce 存在 | 凭空编一个 nonce 想蒙混过关 | `ApprovalNotFoundError` |
| 没被消费过 | **重放**（把同一个批准的凭证再发一次）、**双击批准**（同一个批准动作触发了两次消费请求）——这两种故障场景本质是同一个问题：同一个 nonce 被消费了不止一次 | `ApprovalAlreadyConsumedError` |
| 没过期 | **过期回复**（用户很久之后才点了批准，或者断线重连之后才收到批准结果） | `ApprovalExpiredError` |
| 参数哈希匹配 | **批准后换参数**（批准的是"删除 `a.txt`"，真正要执行的却是"删除 `b.txt`"） | `ApprovalArgsMismatchError` |

**"双击批准"和"重放"用的是同一条防线，不是巧合**：从 `ApprovalStore` 的视角看，"用户手滑点了两下同一个批准按钮"和"攻击者把同一份批准请求又发了一次"，产生的调用序列是完全一样的——`consume(nonce, args)` 被调用了两次。系统不需要（也没办法）区分这两次调用的"意图"是善意的手滑还是恶意的重放,只要"同一个 nonce 只能生效一次"这条规则本身立住了,两种场景就都被同一条防线挡住了。

**为什么参数不匹配不会顺带消费掉这个 nonce**：`entry.consumed = true` 这一行排在所有校验**之后**——如果换参数那次调用直接失败退出，前面三个 `if` 都没有碰 `entry.consumed`,这个 nonce 依然是"未消费"状态,后续用回原本批准的那组参数还能重试成功（[approval.test.ts](../../mini-harness/tests/approval.test.ts)"故障注入2"那条测试验证了这一点）。这是有意的选择：一次参数不匹配的失败尝试,更常见的原因是调用链路上某个环节的 bug（比如中间层不小心改了一个字段），而不是有人在恶意窜改——不应该因为一次失败尝试,连累一次本该合法的重试。

## 3. 为什么今天不接进 `runTurn`

`ApprovalStore`/权限预设今天只是独立的、有完整测试覆盖的模块，没有接进 Day5 写的 `runTurn()`——这跟 Day15 `edit_file` 写完不接进 `cli.ts`、Day16 `run_command` 写完也不接进 `cli.ts` 是同一个模式：**先证明机制本身是对的（可以独立测试、能挡住原始大纲点名的每一种故障场景），再决定怎么接进真正的调用方**。真要把审批接进 `runTurn`，意味着要同时想清楚"轮到哪个工具调用需要审批""审批请求怎么送到用户手上、又怎么等用户的回复送回来"这类跟 Day5 那套"问模型→执行工具→写回历史"节奏交织在一起的新问题——把"发明审批机制"和"改造一个已经稳定跑了 14 天的核心循环"拆成两件事分别做，任何一件出了问题都更容易定位到底是哪一半的锅。真正的接入留给 Day21 milestone，那时候会有一个具体的、值得审批的场景（`edit_file` 写文件）作为落地的靶子，不是凭空设计一套接口。

## 4. 权限预设为什么吃"显式集合"，不是猜工具名字

```ts
export function createBalancedPreset(readOnlyTools: ReadonlySet<string>): PermissionPreset {
  return { name: 'balanced', decide: (toolName) => (readOnlyTools.has(toolName) ? 'auto-approve' : 'require-approval') }
}
```

三个 preset 构造函数都要求调用方显式传一份"哪些工具名字算只读"的集合，不是在 preset 内部写死"名字以 `read_`/`list_`/`search_` 开头的就当只读"这种基于命名规律的猜测。原因跟 Day18 `CommandPolicy` 选显式白名单、不选"猜哪些环境变量名字看起来危险"是同一条：命名规律不可能覆盖所有情况——以后随便加一个叫 `inspect_something` 的新只读工具，猜规则的写法会把它误判成"需要审批"，而显式集合只需要在注册工具的地方把它加进这份集合里，不存在"忘了改规则导致误判"这种隐患。

## 一句话总结

今天引入的两个机制——`ApprovalStore` 和权限预设——都是在把"要不要信任这次操作"这个判断,从"一句模糊的同意/不同意"变成"一份跟具体参数、具体时效绑定、可以被程序化验证的凭证"。这跟 Day18 `CommandPolicy` 的策略/执行分离是同一条主线的延续：判断逻辑本身要能独立测试、独立验证，"这次到底该不该放行"不能建立在一个含糊的、没法回放和审计的信号上。
