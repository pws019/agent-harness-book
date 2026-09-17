# ADR-002：fail-closed 与 fail-open 的判定标准

**状态**：已采纳（Day18 建立 fail-closed 纪律，Day25 提出对立的 fail-open 反例）

## 背景

`CommandPolicy`（Day18）、`ApprovalStore`（Day19）建立了一条贯穿始终的纪律："判断本身出错时,拒绝而不是放行"（`FailClosedCommandPolicy`）。但 Day25 语义查询（`withFallback()`）刻意反过来——`TsserverProvider` 查询失败时降级到文本搜索,不拒绝、不报错,诚实地给一个"不够精确但不是无"的结果。两者表面矛盾,需要一个明确的判定标准,不能靠"看情况"。

## 决定

判定标准是：**这一步失败会不会导致一个不可逆的副作用**。会（写文件、执行命令、消费一次性审批）——fail-closed，出错就拒绝。不会（只是查询精度打折）——可以 fail-open，降级但不阻塞。

## 后果

**好处**：`command-policy.ts`/`approval.ts` 的 fail-closed 和 `semantic-query.ts` 的 fail-open 不再是两条互相矛盾的规则,是同一个标准在两种不同场景下的自然结果——学习者不会把"fail-closed 是绝对正确的"这个错误结论泛化到所有场景。

**代价**：判定标准依赖对"这一步是不是不可逆副作用"的准确判断——这本身需要设计者对系统的副作用边界有清楚的认知,不是一个可以机械套用的公式。`release-checklist.md` 第9/12条记录的"sandbox 不是真沙箱"这条缺口,本质上是"没有能力可靠地区分不可逆副作用和可逆查询"的一个具体后果——`node:vm` 里跑的代码理论上可能有不可逆副作用（逃逸后碰到宿主对象）,这也是为什么 `CodeRuntime` 依然要求接入 `CommandPolicy` 这层而不是单独信任 `vm` 自己。
