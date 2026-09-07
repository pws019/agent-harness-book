# Day 7 实践任务

## 任务 1：跑起来，换个真实目标试试

```bash
cd mini-harness
pnpm cli -- --workspace <你自己某个项目的路径> --goal "look for TODO markers" --query TODO
```

观察输出。如果 `search_text` 命中太多结果被截断了，看看输出里是不是老实报告了"截断"这件事（回顾 Day4 study.md 的输出上限策略）。

## 任务 2：画时序图

为 `tests/scenarios.test.ts` 里的**场景 19**（"多步 tool call 后完成"）画一张时序图，角色包括：`CLI`/测试代码、`Agent`、`runTurn`、`ScriptedAdapter`、`ToolRegistry`。标出：

- 每个 step 的边界在哪。
- `history` 数组在每一步之后增加了哪些元素。
- 哪个环节调用了 `generateWithRetry`（Day3），哪个环节调用了 `ToolRegistry.execute()`（Day4）。

用 mermaid 的 `sequenceDiagram` 语法写出来，存成 `modules/day07-milestone-cli/turn-sequence.md`，也可以手绘拍照。

## 任务 3：补两条场景

`tests/scenarios.test.ts` 目前是 20 条。请再补两条你觉得还没被覆盖、但你认为对"能不能上生产"很关键的场景。一些参考方向（不强制选这些）：

- 工具在执行过程中被取消（不是模型层取消，而是单个工具调用超时/被取消）——目前 Day5 exercise 任务3 提到这是一个已知简化，如果你做了那个练习，正好可以在这里补一条集成测试验证它。
- `search_text` 真的命中超过 50 条结果时，CLI 最终总结里有没有诚实地反映"这是抽样结果，不是全部"。
- 连续两次 `send()` 之间，第一次 turn 的历史有没有正确地被第二次 turn 看到（验证"会话记忆"在多轮对话下是连续的）。

## 任务 4：写你自己的 ADR-002（可选，但强烈建议）

回顾 Day4 exercise 里让你写的"深工具 vs 浅工具"对比。现在有了完整跑起来的系统，重新审视一遍：`read_file`/`list_files`/`search_text` 这三个工具的参数设计，有没有哪个地方，你现在觉得应该改？把你的思考写成一段简短的 ADR（决策+权衡），不需要真的去改代码。

## 验收自查

- [ ] `pnpm test` 全绿（181+ 条，加上你新增的）。
- [ ] 我画出的时序图能让一个没读过代码的人看懂 turn/step/tool call 之间的关系。
- [ ] 我能对照阶段门禁清单，逐条说出"我们是怎么满足这一条的，证据在哪个测试里"。
