# Day 18・沙箱与最小权限

> 阶段：III. 受控执行与人机协作　|　产出：[threat-model.md](./threat-model.md)、`src/tools/command-policy.ts`（`CommandPolicy`/`AllowlistCommandPolicy`/`FailClosedCommandPolicy`），跨天红队回归测试

## 今天要学会什么

1. 理解"策略判断"和"底层强制执行"为什么必须是两个分开的东西——`CommandPolicy` 只回答一个纯逻辑问题，真正拒绝一次调用发生在工具的 `execute()` 里。
2. 理解 fail-closed：策略求值本身出错时应该拒绝还是放行，为什么"悄悄放行"是更危险的默认值。
3. 能写出一份威胁模型文档的六个部分（资产/信任边界/攻击者/入口点/影响/缓解措施），并且能诚实地把"没有解决的缺口"跟"已经验证的缓解"分开写,不混在一起。
4. 理解为什么 MiniHarness 不做真正的 OS 级沙箱（容器/网络隔离），这个边界画在哪、原始大纲自己是怎么承认同样局限的。

## 怎么学

1. 读 [threat-model.md](./threat-model.md)——这是今天的主要产出，不是代码。
2. 读 [study.md](./study.md)。
3. 读代码：`src/tools/command-policy.ts`，再看它怎么接进 `bash-tool.ts`/`job-tools.ts` 的 `execute()`。
4. 跑 `tests/command-policy.test.ts`、`tests/command-policy-integration.test.ts`、`tests/red-team-regression.test.ts`——最后这个文件把 Day15/16/17 已经验证过的防线按"红队场景"重新汇总了一遍。
5. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释："模型答应不做"为什么不算一条安全控制,今天引入的哪几条机制是"不依赖模型自觉"的强制边界。
- 你能解释：`FailClosedCommandPolicy` 防的是什么场景,如果反过来做成"求值出错就默认放行"，会带来什么后果。
- 你能指出：威胁模型文档里哪一条是"已经验证解决了的"，哪一条是"明确承认没解决的缺口",两者的表述方式有什么不同。
- `pnpm test` 全绿。
