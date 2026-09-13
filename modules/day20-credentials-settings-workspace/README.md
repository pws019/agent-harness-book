# Day 20・凭据、设置、存储与工作区

> 阶段：III. 受控执行与人机协作　|　产出：`src/core/credentials.ts`（`CredentialRef`/`CredentialStore`）、`src/core/settings.ts`（`mergeSettings`）、`src/core/workspace-context.ts`（`WorkspaceContext`），`run_command` 接入凭据示范

## 今天要学会什么

1. 理解为什么配置里只能存 `CredentialRef` 这个不透明引用，不能存真实密钥——以及"什么时候真正解析成真实值"这个时机为什么很重要。
2. 理解 `mergeSettings()` 为什么要给每个合并出来的值都保留"这是哪一层给的"，而不是简单 `Object.assign` 拼一遍就完事。
3. 理解 Workspace 为什么应该是"身份与能力边界"（root + 凭据 + 设置），不只是一个 cwd 字符串——以及为什么今天没有把这个类型强推进所有已有工具的签名。
4. 能说清楚 `run_command` 接入 `WorkspaceContext.envCredentials` 之后，模型能做什么、不能做什么（尤其是"能不能用同名变量顶替掉 workspace 配置的凭据"这一点）。

## 怎么学

1. 读 [study.md](./study.md)。
2. 读代码：`src/core/credentials.ts` → `src/core/settings.ts` → `src/core/workspace-context.ts`，再看 `bash-tool.ts` 里怎么把 `envCredentials` 解析进子进程环境。
3. 跑 `tests/credentials.test.ts`、`tests/settings.test.ts`、`tests/workspace-context-integration.test.ts`。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：如果 `run_command` 的参数里直接允许模型传"密钥的真实值"（而不是引用），审计日志、错误信息、Session 事件里分别可能在哪里意外泄漏出去。
- 你能解释：`mergeSettings()` 的返回值里,为什么"用户这一层没设置某个 key"和"用户这一层把某个 key 设置成了 falsy 值（比如 `false`/`0`）"必须被区分开,而不是简单地判断"这一层有没有值"。
- 你能解释：为什么模型自己传的 `env.OPENAI_API_KEY` 不能覆盖 `WorkspaceContext.envCredentials` 里配置的同名变量,这个合并顺序背后的安全考虑是什么。
- `pnpm test` 全绿。
