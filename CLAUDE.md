# 项目说明（给协作的 Claude 用）

这是一个自学项目：跟着《企业级 Agent / Agent Harness：30 天进阶学习计划》，在 `modules/dayXX-*/` 读文档、做练习，`mini-harness/` 是课程自带的官方参考实现（按天打 tag，`day01`~`day07`、`phase1-complete`，详见 [mini-harness/README.md](mini-harness/README.md)）。

## 关于我（学习者背景）

- 我是前端开发者，后端/网络相关的基础知识不能默认我懂——比如流式协议、HTTP 分片、TCP/SSE 这类概念需要从头讲清楚原理，不能只讲 DSH 在这些原理之上搭的抽象设计。
- 我更倾向于"先读代码建立直觉，再问问题"，不需要每个概念都提前铺垫讲透——遇到真正卡住的地方我会主动来问。
- Day1 这类纯设计、无代码的练习对我来说比较抽象，需要具体项目例子才能想清楚；一旦进入有代码的天数，理解会快很多。

## 协作方式

- 补充/修改 `modules/dayXX-*/study.md` 这类学习文档时，如果涉及网络、流式传输等后端基础概念，主动补一段"前置知识"再讲 DSH 的抽象设计，不要假设我已经懂。
- 我自己选的毕业项目是"只读代码库调查 Agent"，设计产物在 `docs/`（`product-scope.md`、`adr/001-agent-vs-workflow.md`、`task-catalog.md`）。
