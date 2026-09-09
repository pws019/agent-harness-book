# Day 7・里程碑一：可测试的单 Agent CLI

> 阶段：I. 最小但正确的内核（收尾）　|　产出：`src/cli.ts`、`src/heuristic-adapter.ts`、20 条场景评测

## 0. 前置知识：Node.js 命令行程序基础

前端平时写的代码跑在浏览器里，`src/cli.ts` 是这门课第一次写"跑在终端里的 Node 程序"，几个小概念先过一下：

- **`process.argv`**：Node 进程启动时，命令行输入的每一段参数会被塞进 `process.argv` 这个数组，比如 `pnpm cli -- --workspace foo --goal bar` 实际执行时 `process.argv` 大概长这样：`['/usr/bin/node', '/path/to/cli.js', '--workspace', 'foo', '--goal', 'bar']`——前两项永远是 node 可执行文件路径和脚本路径，从第三项起才是你真正传的参数。`src/cli.ts` 里的 `parseArgs()` 干的就是把这个扁平字符串数组解析成一个结构化的对象（类似前端解析 URL query string）。
- **退出码（exit code）**：浏览器里的函数出错顶多是抛异常、打印到 console；命令行程序结束时要向操作系统汇报一个数字状态码，`0` 表示成功，非 `0`（通常 `1`）表示失败——这样其他脚本/CI 流程可以通过 `if [ $? -eq 0 ]` 这类判断知道你这个程序到底跑成功了没有，不用去猜"有没有打印错误日志"。
- **`pnpm cli`**：对应 `package.json` 里的一条 `scripts` 命令，帮你省掉每次手写 `node --loader tsx src/cli.ts` 这种长命令；`--` 之后的部分是透传给你的脚本本身的参数，不是 pnpm 自己的参数。

## 今天要做什么

不读新文档，把 Day1-6 搭好的每一层拼成一个真正能跑的 CLI，然后用 20 条场景测试证明它在各种"坏路径"下都有明确、可预期的行为——这是阶段一的毕业考核。

```bash
cd mini-harness
pnpm cli -- --workspace tests/fixtures/workspace --goal "find the needle" --query TARGET_NEEDLE
```

试试指向你自己的某个项目目录，换一个 `--query` 关键词，看看它怎么把 `list_files`/`search_text` 的真实结果组织成一份带证据的结论。

## 这一层是怎么拼起来的

```
CLI (src/cli.ts)
  └─ Agent (Day6：inbox、取消、幂等释放)
       └─ runTurn (Day5：turn/step 骨架、终态判断)
            ├─ generateWithRetry (Day3：重试、错误分类、请求冻结)
            │    └─ LlmAdapter (Day3 接口) ← HeuristicInvestigationAdapter (演示用，不连真实模型)
            │         └─ BlockAssembler (Day2：流式组装)
            └─ ToolRegistry (Day4：校验、超时、取消、渲染)
                 └─ read_file / list_files / search_text (Day4：三个只读深工具)
```

`HeuristicInvestigationAdapter` 不是真实模型——它按固定策略调用 `list_files` → `search_text`，再根据**真实**返回结果组织总结。这是刻意的选择：Day7 的验收标准是"6 天搭的骨架能不能撑起一个真实可跑的 CLI，并且在各种故障下行为可预期"，不是"能不能接入某个具体模型 API"。接入真实模型只需要照着 Day3 的 `LlmAdapter` 接口自己写一个实现，`Agent`/`runTurn` 不需要改一行代码。

## 怎么学

1. 跑一遍 CLI，感受端到端效果。
2. 读 `tests/scenarios.test.ts`——20 条场景，每一条都在验证"这一步出问题之后，系统会不会给出一个明确、唯一的终态"。
3. 做 [exercise.md](./exercise.md)：补两条你觉得还没被覆盖到的场景，并画一张"一次 turn 里多个 step 和 tool call"的时序图。

## 阶段门禁（对照原 30 天大纲）

- [x] 单元测试覆盖组装器、schema、loop 终态和取消竞态（Day2-6，181 条测试）。
- [x] 20 条场景全部产生合法终态；不以"程序未抛异常"作为成功标准。
- [ ] 能画出一次 turn 中多个 step 和 tool call 的时序图——**这个由你在 exercise.md 里完成**。

## 复盘问题（写在你自己的笔记里，不需要提交）

- 哪些复杂性来自 LLM 的概率性（模型可能编造工具名、生成非法 JSON、偶尔返回空内容）？哪些来自普通分布式/异步系统（取消传播、单 writer、幂等释放、竞态）？
- 如果去掉模型（假设 `HeuristicInvestigationAdapter` 就是最终产品），这套 turn/step/取消/工具管线的设计还剩下多少价值？
