# 白话讲解：沙箱与最小权限

> 素材来源：DSH `docs/subsystems/sandbox.zh.md`、项目安全说明 `SAFETY.md`。今天不实现真正的 OS 级沙箱（容器/虚拟机级别的隔离）——原始大纲自己也承认"DSH 当前 sandbox seam 主要约束文件系统效果，不自动覆盖网络或进程可见性"，MiniHarness 在这一点上不比 DSH 更差，只是同样诚实地没有解决它。今天真做的是：策略/强制执行分离、fail-closed、一份书面威胁模型、把 Day15-17 的防线按红队场景重新验证一遍。

## 0. 前置知识：威胁模型是一种思考方法，不是一份"我们做了什么"的清单

如果你只是列一份"我们做了 A、B、C 三件安全相关的事"，这份清单永远只能回答"我们想到的问题"，回答不了"我们没想到的问题"——而攻击者恰恰是从"你没想到的地方"下手的。威胁模型强制你换一个顺序思考：**先假设有一个想搞破坏的人（攻击者），再问他能从哪里下手（入口点）、他想要什么（资产）、得手了会造成什么后果（影响）**——从这个顺序反推出来的"缓解措施"列表，天然会比"我们随便想到什么就防什么"更系统。这是安全工程里的标准做法，不是这门课自创的，六个部分（资产/信任边界/攻击者/入口点/影响/缓解措施）是通用模板，换到任何系统都能套用。

## 1. 策略判断和强制执行,为什么必须分开

**先讲问题**：如果"要不要允许执行这个命令"的判断逻辑,直接写在 `run_command` 的 `execute()` 函数体里、跟 spawn 逻辑混在一起,以后想换一套判断规则（比如从"固定白名单"换成"读配置文件动态判断"），就得去改 `bash-tool.ts` 这个已经承担了参数校验、路径解析、spawn 调用一堆职责的文件——判断逻辑和执行逻辑绞在一起,谁都不好单独测、单独换。

**调用关系**：

```
run_command 的 execute()（调用方）
   │
   │ ① 决定要不要跑：policy.isAllowed(args.command)
   ▼
CommandPolicy（纯判断，今天要写的东西）
   │
   │ 返回 true/false，不碰文件系统、不 spawn 任何东西
   ▼
execute() 拿到判断结果
   │
   ├─ false → 直接 throw ToolExecutionError，什么都不会真的执行（② 强制执行发生在这里）
   └─ true  → 继续走 Day16 原有的 resolveWithinRoot → spawnManaged 流程
```

```ts
export interface CommandPolicy {
  isAllowed(command: string): boolean
}

export class AllowlistCommandPolicy implements CommandPolicy {
  isAllowed(command: string): boolean {
    return this.allowed.has(command)
  }
}
```

`CommandPolicy` 只回答"允不允许"这一个问题，是一个纯函数式的判断（[command-policy.ts:12-24](../../mini-harness/src/tools/command-policy.ts)）——它自己不 throw、不 spawn、不碰任何 I/O。真正"强制执行"这个判断结果的地方，在 `bash-tool.ts`/`job-tools.ts` 的 `execute()` 里：判断说不允许，直接拒绝，没有第二条路能绕过去（不存在"策略说不允许，但这次有特殊理由所以还是放行了"这种分支）。这样分开之后，`CommandPolicy` 可以完全独立测试（不需要真的 spawn 一个进程），以后想换一套判断规则也只需要换一个 `CommandPolicy` 实现,`bash-tool.ts` 的 `execute()` 一行不用改。

## 2. fail-closed：策略出错时，拒绝还是放行

```ts
export class FailClosedCommandPolicy implements CommandPolicy {
  isAllowed(command: string): boolean {
    try {
      return this.inner.isAllowed(command)
    } catch {
      return false
    }
  }
}
```

真值表：

| 被包装的策略求值结果 | `FailClosedCommandPolicy.isAllowed()` 返回 |
|---|---|
| 正常返回 `true` | `true` |
| 正常返回 `false` | `false` |
| 求值过程中抛异常（配置损坏、策略实现有 bug） | `false`——不是抛出异常，也不是默认放行 |

**为什么不是"求值出错就默认放行"（fail-open）**：如果选 fail-open，任何让策略求值出错的方式（配置文件被写坏、策略实现本身有 bug、依赖的某个服务超时）都会变成一条"绕过所有限制"的捷径——攻击者不需要真的破解策略逻辑,只需要想办法让它抛异常就行,这比正面破解一条判断规则容易得多。选 fail-closed，"策略不可用"和"sandbox 不可用"是同一种情况：**能力失效时选择更保守的一边**,这跟根 README"企业级 Agent 核心不变式清单"第9条"sandbox 不可用时高风险操作故障关闭"是同一条原则,只是今天用一个具体的 `CommandPolicy` 包装类把它变成了可以直接跑测试验证的代码,不是一句写在文档里、没人真的检查过的口号。

## 3. 威胁模型文档：诚实记录"解决了的"和"没解决的"，是两种完全不同的写法

看 [threat-model.md](./threat-model.md) 的缓解措施表格——每一行都标了状态,要么"✅ 已验证"（有对应的测试文件、能指出具体在哪个文件里生效），要么"❌ 接受的缺口"（明确写清楚为什么没做、真要做需要什么）。**这两种状态的表述方式故意不一样**：已验证的写"落地位置"+能追溯到具体代码；接受的缺口写"为什么没做"+"真要做需要什么"，不写"已经通过某种方式缓解"这种模棱两可的话。如果一份威胁模型把"我们没解决的问题"也包装成"已经通过 XX 方式缓解"，这份文档就从"帮你发现问题"变成了"帮你掩盖问题"——网络外传那一条就是一个具体例子：`CommandPolicy` 能挡住"不许跑 `curl`"，但完全挡不住"被允许跑的 `node` 脚本自己发起网络请求"，`red-team-regression.test.ts` 里"红队场景4"那两条测试一条证明"缺口真实存在"、一条证明"部分缓解确实生效"，两条都写，不能只留一条显得"问题已经解决"。

## 4. 为什么不做真正的 OS 级沙箱

真正的进程沙箱（容器、虚拟机、网络 namespace、seccomp 过滤系统调用）能提供比"argv 数组+env 白名单+进程树 kill"强得多的隔离——但引入 Docker/gVisor 这类依赖，对一个到目前为止零外部运行时依赖、跑在开发者本机的教学项目来说，代价（环境搭建复杂度、跨平台兼容性）远大于收益。原始大纲自己也点破了这一点："DSH 当前 sandbox seam 主要约束文件系统效果，不自动覆盖网络或进程可见性"——连 DSH 真实项目自己都没有做到完整的 OS 级隔离,MiniHarness 没有必要假装自己能做到,老老实实在威胁模型里写清楚这是"接受的缺口"，比打肿脸充胖子写一套"看起来很安全但其实没有真正隔离"的机制更负责任。

## 一句话总结

今天没有引入新的执行机制，是给 Day15-17 已经写好的能力补上一层"谁说了算、说了算的东西自己出错了怎么办"的治理——`CommandPolicy` 的策略/执行分离和 fail-closed，本质都是把"要不要信任这次调用"这个判断从"混在业务逻辑里、没人能单独验证"变成"独立、可测试、出错时往安全的方向倒"的机制；威胁模型文档的价值不在于列出了多少条防线，在于诚实地把"验证过的"和"没做的"分开写，后者往往比前者更重要——它是下一个真正需要更强隔离的人（可能是未来的你）第一个要看的东西。
