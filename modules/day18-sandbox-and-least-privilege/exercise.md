# Day 18 实践任务

## 任务 1：亲手把 fail-closed 改成 fail-open，看红队测试失败

在 `src/tools/command-policy.ts` 里，把 `FailClosedCommandPolicy.isAllowed()` 的 `catch { return false }` 临时改成 `catch { return true }`（fail-open）。重新跑：

```bash
pnpm vitest run tests/red-team-regression.test.ts
```

确认"fail-closed 是这几条防线共同的兜底原则"那条测试失败，读一下失败信息。想一想：如果这条测试不存在，这个改动会不会被别的测试发现？（提示：`tests/command-policy.test.ts` 里也有一条专门测 `FailClosedCommandPolicy` 的用例，这两条测试分别测的是什么层次的东西，为什么两个都需要）。跑完记得改回来，确认全绿。

## 任务 2：给 `CommandPolicy` 加一个"拒绝原因"

现在 `isAllowed()` 只返回 `boolean`，调用方（`bash-tool.ts`/`job-tools.ts`）只能给一句写死的"not allowed by the current command policy"，不管是"这个命令压根不在白名单里"还是"策略配置本身损坏了走了 fail-closed"，报错信息看起来一模一样——对排查问题的人来说,这两种情况需要采取的行动完全不同（前者是正常拒绝，后者需要有人去修策略配置）。

给 `CommandPolicy` 加一个新方法（或者把 `isAllowed` 改造成返回一个结构化结果，比如 `{ allowed: boolean; reason?: string }`），让 `AllowlistCommandPolicy` 和 `FailClosedCommandPolicy` 分别给出有意义的原因。更新 `bash-tool.ts`/`job-tools.ts` 用上这个原因,补至少两条测试验证两种拒绝原因确实不同。

## 任务 3：一道思考题（不用写代码）

威胁模型文档把"网络外传"标成了"接受的缺口"，明确说不引入容器/网络 namespace 这类重量级方案。但"完全不做任何缓解"和"引入完整的 OS 级网络隔离"之间，还有没有一些**代价不高、但确实能挡住一部分场景**的中间方案？想至少一个，说清楚它能挡住哪种攻击、挡不住哪种（提示：可以从"哪些常见的网络工具/协议库名字是可以枚举的"这个角度想,也可以想"如果连不上任何域名会发生什么"这类环境层面的手段，不一定非要改代码）。

## 验收自查

- [ ] `pnpm test` 全绿，包括你新增的任务2测试。
- [ ] 我能解释：`tests/command-policy.test.ts` 和 `tests/red-team-regression.test.ts` 里关于 fail-closed 的测试分别验证的是什么层次，为什么两个都需要,不是重复。
- [ ] 我写完了任务3的思考题，给出了一个具体的中间方案，并且诚实说明了它挡不住什么。
