# Day 1・识别系统边界，设计两次

> 阶段：I. 最小但正确的内核　|　产出：`product-scope.md`、`docs/adr/001-agent-vs-workflow.md`　|　无代码

## 今天要学会什么

1. 分清「业务 Agent」「Agent Runtime」「Agent Harness」「Agent 平台」这四层，不再把它们混着用。
2. 明白 DSH（deepseek-ai/deepseek-harness）的"一切皆插件"是**平台扩展策略**，不是你搭一个最小可用 Agent 的必要条件——今天不用管插件系统。
3. 学会用「目标、环境、能力、状态、策略、完成条件」六个维度去描述一个 Agent 系统。
4. 学会判断一个任务到底该用固定工作流，还是该上 Agent loop。

## 怎么学

1. 读 [study.md](./study.md)——这是把 DSH 官方文档嚼碎后的白话讲解，配了类比和原文引用，读这个就够，不需要再去啃英文/中文原始文档。
2. 做 [exercise.md](./exercise.md) 里的练习：选定毕业项目、写两套设计方案、写 ADR、列任务清单。
3. 如果你想验证 study.md 里的引用是否准确，可以自行去看官方原文：
   - [README.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md)
   - [docs/architecture.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.zh.md)
   - [docs/glossary.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/glossary.zh.md)

   但这不是必须的——本模块的目标就是让你不用去读这些也能建立正确的心智模型。

## 验收标准

- 你能不看文档，口头说清楚 Agent / Agent Runtime / Agent Harness / Agent 平台这四层分别对应什么，举一个厨房类比不打磕巴。
- `product-scope.md` 里的每个任务都有"可观察的完成条件"，不能是"回答看起来不错"这种模糊描述。
- 你能指出：在你选的毕业项目里，哪些判断必须交给模型，哪些必须由确定性代码兜底。
