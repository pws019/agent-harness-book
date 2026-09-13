# Day 20 实践任务

## 任务 1：亲手验证"合并顺序反过来会怎样"

`src/tools/bash-tool.ts` 里 `envCredentials` 的注入代码故意写在 `{ PATH, ...args.env }` **之后**，让 workspace 配置的凭据能覆盖模型自己传的同名变量。把这个顺序颠倒过来，改成"先注入 `envCredentials`，再展开 `args.env`"：

```ts
const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
if (workspace?.envCredentials) {
  for (const [key, ref] of Object.entries(workspace.envCredentials)) {
    env[key] = workspace.credentials.resolve(ref)
  }
}
Object.assign(env, args.env ?? {})
```

重新跑：

```bash
pnpm vitest run tests/workspace-context-integration.test.ts
```

确认 `tests/workspace-context-integration.test.ts:45-65`（"the model cannot override a workspace-configured credential..."）这条测试失败——`result.content` 里会变成 `model-supplied-fake-value`，而不是预期的 `sk-real-secret-value`。想一想：另外两条测试（"a credential configured on the workspace shows up..."、"with no workspace configured..."）为什么不受这次改动影响。跑完记得把顺序改回来，确认全绿。

## 任务 2：给 `CredentialStore` 加一个基于环境变量的实现

现在只有 `InMemoryCredentialStore` 一种实现，测试里手动 `set()` 好凭据。真实场景下，凭据更可能来自宿主进程的环境变量（比如运维在部署时把真实密钥设进 `process.env`，而不是硬编码进代码或测试）。实现一个 `EnvCredentialStore implements CredentialStore`：

- `resolve(ref: CredentialRef): string`：把 `ref.id` 转换成一个环境变量名（比如约定 `ref.id` 直接就是环境变量名，或者你可以设计一个自己的映射规则——说清楚你选哪种，为什么），然后从 `process.env` 里读。
- 读不到（`process.env[key]` 是 `undefined`）时的行为要跟 `InMemoryCredentialStore` 保持接口约定一致——抛 `CredentialNotFoundError`，不能返回 `undefined` 或空字符串。

补至少两条测试：一条验证能从 `process.env` 正确读到值，一条验证读不到时抛错（提示：测试里可以用 `vi.stubEnv()` 或者直接读写 `process.env` 后 `afterEach` 里还原，注意别真的污染其他测试用到的环境变量）。

## 任务 3：一道思考题（不用写代码）

`mergeSettings()` 现在的语义是"某一层没有某个 key，就不会覆盖前一层"——这是靠 `Object.entries()` 只遍历真正存在的 key 天然做到的（study.md 第2节的真值表）。但真实的分层配置系统经常还需要另一种能力：**用户想显式地把 workspace 层给某个 key 设的值改回"跟随更上层的默认值"**，而不是"用户这层设置成某个具体值"。

比如 workspace 配置了 `maxTokens: 500`，用户想恢复成 deployment 层的 `2000`，但又不知道 deployment 层具体设的是多少（也不该硬编码那个数字进用户配置里，因为 deployment 层的值以后可能会变）。想一想：

- 直接把用户层的 `maxTokens` 设成 `undefined` 能不能达到这个效果？结合 study.md 第2节真值表里"key 存在但值是 `undefined`"这一行，说说会发生什么。
- 如果要支持"显式恢复成上一层的值"这种语义，你会怎么设计？（提示：需要一个能跟"真实的合法配置值"区分开的哨兵值/标记，`mergeSettings` 遇到这个标记时的行为要跟遇到普通值时不一样——可以类比 Day19 里"三种交互类型显式区分成一个封闭联合类型"的思路，而不是用某个容易和合法值混淆的魔法值比如 `null`）

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的任务2测试。
- [ ] 我能解释：为什么把 `envCredentials` 的合并顺序换到 `args.env` 之前会让模型能顶替掉 workspace 配置的凭据，具体是哪条测试、哪一行断言先失败的。
- [ ] 我写完了任务3的思考题，给出了具体的设计方向（哨兵值/标记该长什么样），不是"用 `undefined` 应该就行"这种没有验证过真值表含义的回答。
