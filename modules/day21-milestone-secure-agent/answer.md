# Day 21 答案

> 对照 [README.md](./README.md)「阶段门禁」最后一条问答题和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 阶段门禁问答：为什么审批消费要放在 `edit_file` 之前，这个顺序带来了什么权衡

放在之前的理由：`ApprovalStore.consume()` 一旦成功,意味着"这次批准已经被正式使用",这是审计意义上真正重要的时刻——它标志着"人已经做出了批准这个决定,系统即将据此行动"。如果放在 `edit_file` 之后,会出现一个更麻烦的时间窗口：`edit_file` 已经真的把新内容写到磁盘上了,但如果紧接着 `consume()` 这一步因为某种原因（进程崩溃、极端情况下的异常）没有执行成功,系统的状态会变成"文件已经被改了,但审批记录上这个 nonce 还是'未消费'"——这比"审批消费了但写入失败"更危险,因为后者只是"错失了一次本该成功的操作,可以安全重试",前者却是"一个副作用已经真实发生了,但审计记录反映不出来是谁批准的"。两害相权,选择"审批记录先行,写入操作可能因此白白消耗一次批准机会但绝不会有'有副作用却没审计记录'的情况"，这是牺牲一点"失败后无法重试同一个 nonce"的便利性,换取"审计记录永远不会滞后于真实发生的副作用"这条更重要的不变式。

## 验收自查

**亲手跑过 `pnpm cli -- propose-edit`**：批准、拒绝、`--preset autonomous`、`--preset readonly` 四种路径全部手动跑过一遍（见 Day21 开发过程），确认了：批准之后文件真的被改写；拒绝之后文件一个字节都没变；`autonomous` 完全不弹出确认提示、直接生效；`readonly` 直接拒绝、同样不弹出确认提示。命令行参数解析（`--file`/`--find`/`--replace`/`--preset`/`--verify-command`/`--verify-args`）也确认了不是只在 `parseArgs`/单元测试里正确,是真的从 shell 里传参数进 `process.argv` 之后依然解析正确。

**任务2：把 `consume()` 挪到 `edit_file` 之后会怎样**：亲手验证过——挪到之后,"honest gap"那条测试从"预期抛错"变成"实际不抛错",因为 `edit_file` 因为竞态失败之后,`consume()` 从未被调用,原来的 nonce 依然"未消费",可以用同样的参数重新消费一次。这确实解决了"一次因竞态而失败的写入,不能重试同一个 nonce"这个原始缺口。但正如上面阶段门禁问答分析的,这个修复引入了一个新的、更隐蔽的风险：如果 `edit_file` 内部先完成了真正的副作用（对这个项目来说是 `writeFileAtomic()` 已经把文件换成了新内容）,但在 `execute()` 把结果返回给 `proposeEdit()`、`proposeEdit()` 再去调用 `consume()` 这段路径上出现异常（比如进程被杀）,就会出现"文件已经改了,但审批记录显示这个 nonce 还没被消费"的不一致——审计记录滞后于真实发生的副作用。两种顺序各有各的失败模式,这个项目选择了"consume 在前"，接受"失败后不能重试同一个 nonce"这个较轻的代价,换取"审计记录永远不会滞后于副作用"这条更重要的保证。

**任务3：`PathAwarePermissionPreset` 设计方向**：新增一个独立接口，不改动现有 `PermissionPreset.decide(toolName)` 的签名——

```ts
export interface PathAwarePermissionPreset {
  readonly name: string
  decide(toolName: string, targetPath?: string): PermissionDecision
}

export function createPathAwarePreset(
  base: PermissionPreset,
  sensitivePathPrefixes: readonly string[],
): PathAwarePermissionPreset {
  return {
    name: `${base.name}+path-aware`,
    decide(toolName, targetPath) {
      if (targetPath && sensitivePathPrefixes.some((p) => targetPath.startsWith(p))) {
        return 'require-approval'
      }
      return base.decide(toolName)
    },
  }
}
```

选择"新增接口、包一层现有 preset"而不是"直接改 `PermissionPreset.decide()` 的签名让所有调用方都多传一个参数"，理由：`decide()` 的调用方不是只有 `propose-edit`——`readonly`/`balanced`/`autonomous` 这三个 preset 是 Day19 就定义好的、通用的"工具名 → 决策"映射，很多工具（比如 Day17 的 `start_job`）根本没有"目标路径"这个概念,强行让所有调用方都传一个可能是 `undefined` 的 `targetPath` 参数，是在给每个调用方增加认知负担换取一个只有少数场景才用得上的能力。新增 `PathAwarePermissionPreset` 作为一个可选的、包装现有 preset 的装饰器,只有真正需要路径级别判断的调用方（比如以后升级版的 `propose-edit`）才需要知道这个类型存在，其他调用方完全不受影响——这是"深模块、加新能力不改窄接口"这条原则的又一次演练，跟 Day17 `spawnManaged()` 从 `runProcess()` 里拆出来是同一个思路。

**任务4：毕业问答**

1. **为什么"模型自己说它会先读文件再写"不能替代 `expectedHash`**：模型的"承诺"只是它生成的文本里的一句话,不是任何强制约束——它完全可能因为幻觉、上下文丢失、被 prompt injection 干扰,而在没有真的读过最新内容的情况下就发起一次编辑。`expectedHash` 把"读过最新内容"这件事从"相信模型的自我陈述"变成"代码验证一个真实的、当时的 sha256 是否对得上"——即使模型完全不可信,只要 `edit_file` 内部真的做了这个校验,一次基于过时内容的编辑就必然会被拒绝,不依赖模型"说了算"。

2. **为什么审批不能是一句 yes/no**：一句抽象的"继续吗？"没有绑定任何具体内容,批准的人事实上是在对一个未知的、可能在批准之后被偷换的动作签字——`argsHash` 把"批准"这个动作跟一组具体参数（Day19）在密码学意义上绑定在一起,参数变了,批准就失效,不能被"移花接木"到另一次调用上。这跟 Day15 `expectedHash` 是同一种手法在不同场景下的复用：一个防"文件在读写之间被换掉",一个防"审批在批准和执行之间被换了目标"。

3. **防线分层的具体例子**：`incident-drill.md` 里的表格——一次"自动化脚本被投毒,试图在 CI 配置里加一行数据外传命令"的事件,靠的不是单一一层机制挡住,而是 `permission-presets`（把默认配置成 `balanced` 而不是 `autonomous`,保证写操作一定会经过人工审批这一步）+ `ApprovalRequest.argsSummary`（让人工审批的人真的能看到 diff 内容,而不是盲批）两层叠加才真正生效——如果只有前者没有后者,值班人员会因为看不到具体改了什么而产生"审批疲劳"、习惯性放行；如果只有后者没有前者（比如 preset 配成了 `autonomous`）,压根不会走到"给人看 diff"这一步,信息展示得再好也没用。任何单独一层都不足以挡住这次事件,这正是"分层防御"想说明的道理。
