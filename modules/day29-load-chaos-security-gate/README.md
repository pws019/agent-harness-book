# Day 29・压力、混沌、安全与上线门禁

> 阶段：V. 生产验证与毕业设计　|　产出：`tests/load-and-chaos.test.ts`、`src/server/http-server.ts` 的一处真实 bug 修复、`tests/red-team-regression.test.ts` 新增两个红队场景、`release-checklist.md`

## 今天要学会什么

1. 理解 `http-server.ts` 今天修的那个 bug——为什么"客户端先等消息彻底发完、再打开事件流"这个看起来无害的操作顺序，会让连接永远收不到 `terminal`；具体是哪个假设（"未来会有新事件触发收尾"）不成立了。
2. 理解这个 bug 跟 Day23 `fault-injecting-transport.ts` 那次"重连已经追上却不发 terminal"的坑，为什么是同一类问题——两次分别在测试专用代码和真实服务端代码里各自重演了一次。
3. 理解为什么 `AuditingApprovalStore` 的 `AuditSink` 抛错该被简单地吞掉，而 `Agent`/`session.ts` 的 `SessionSink` 抛错不该套用同一个方案——亲手跑一遍会发现 `SessionSink` 今天完全没有保护时,实际后果比"优雅地吞掉"或"干净地报错"都更糟,具体是什么现象、为什么更糟。
4. 理解今天的 SSRF 测试为什么不是"新发现的 bug"，而是延续 Day18 就有的"policy 默认关闭"设计姿态——具体是哪条已有的诚实缺口记录。
5. 理解 Workflow 脚本为什么"结构上"够不着权限提升，不只是"运行时会被拒绝"——这个更强的保证具体来自哪个类型设计决定。
6. 能解释 `release-checklist.md` 里标"部分通过"的 7 条不变式，各自的边界具体在哪，不是笼统地说"基本做到了"。

## 怎么学

1. 读 [study.md](./study.md)。
2. 跑 `tests/load-and-chaos.test.ts`（4条，真实并发/真实长 stream/真实模型错误/真实抛错 sink）、`tests/red-team-regression.test.ts`（新增3条，共10条）。
3. 读 [release-checklist.md](./release-checklist.md)——18条核心不变式逐条自查，7条"部分通过"各自的边界都写清楚了理由。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：`http-server.ts` 那个 bug 具体是"哪一步的哪个假设"不成立——不是笼统地说"有并发问题"，要能指出"订阅之后不会再有新的 `turn/end` 事件"这个条件为什么会发生。
- 你能解释：给 `AuditingApprovalStore` 的 `sink.record()` 包 `try/catch`是对的，给 `Agent` 的 `sink.append()` 也包一层同样的 `try/catch` 却不是对的——两者的关键区别是什么（提示：这个 sink 背后是不是唯一的持久化通道）。
- 你能解释：为什么"脚本手写一个带 `preset` 字段的对象字面量"这种攻击尝试，对 `WorkflowRunner` 完全不起作用——不是因为有一处专门的检查挡住了它，是因为压根没有代码路径会读到这个字段。
- `pnpm test` 全绿。
