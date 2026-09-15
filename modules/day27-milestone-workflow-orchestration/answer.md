# Day 27 答案

> 对照 [README.md](./README.md)「今天要学会什么」「阶段门禁」和 [exercise.md](./exercise.md) 里的思考题逐条作答。

## 今天要学会什么

**1. 为什么 `agent()`/`parallel()`/`pipeline()`/`phase()` 调用它不会执行任何东西**

`workflow-dsl.ts` 里这四个函数各自只是 `return { kind: '...', ... }`——纯数据构造，不含任何 `await`、不调用 `SubagentManager`、不碰任何 IO。`WorkflowNode` 是一棵封闭联合类型描述的纯 JSON 树（`isWorkflowNode()` 能完整校验它），真正的执行发生在完全另一个阶段——`WorkflowRunner.interpret()` 递归遍历这棵树,才第一次调用 `SubagentManager.startChild()`。这跟 React 的 `createElement(Component, props)` 是同一个形状：调用它拿到的是一个描述"应该渲染什么"的对象,不是渲染本身——渲染是 React 自己的 reconciler 在别的时刻做的事。`WorkflowRunner` 就是这棵树的 reconciler。

**2. 为什么 `WorkflowNode.agent` 只带 `agentId`，不嵌入真实的 `AgentDeps`**

如果 `agent()` 要接受一个真实的 `AgentDeps`（里面有 `LlmAdapter` 实例、`ToolRegistry` 实例这类活的宿主对象），那么一段跑在 `CodeRuntime`（`node:vm`）沙箱里的脚本要调用 `agent(...)`,就必须先拿到这些宿主对象的引用——而这正是 Day25 `code-runtime.test.ts` 里那次真实验证过的沙箱逃逸路径的必要条件："逃逸需要一个宿主 realm 的函数绑定,纯数据绑定本身不启用它"（见 `tests/code-runtime.test.ts:52`）。让 `WorkflowNode.agent` 只带一个字符串 `agentId`,树本身就永远是`isJsonValue()`意义上的纯数据,脚本沙箱里能拼出的最多是一棵"计划"而不是一份"能力"——真正的 `AgentDeps` 解析被推迟到 `WorkflowRunner.interpret()`（宿主代码,不在沙箱里）通过 `agentId` 去查一份宿主侧维护的注册表（`src/cli.ts` 的 `runWorkflowCommand()` 里就是这样建的）。

**3. `WorkflowRunner.cancel()` 为什么能在有界时间内 resolve，牺牲了什么**

`forceCancel()` 不等 `handle.dispose()` 真正完成——`dispose()` 调用照样发出去（在后台跑，错误被 `.catch()` 吞掉），但 `this.settle({kind:'cancelled'})` 立刻执行,不等 `Promise.all(...)`。换来的是"`WorkflowRunner` 自己的终态记录一定在有界时间内落定",牺牲的是"被取消的子 Agent 底层一定已经完全停止运行"这个更强的保证——如果子 Agent 的 adapter 真的完全不理会 `AbortSignal`（真的卡死）,`Agent.dispose()` 内部 `await this.runLoopPromise` 会永远不 resolve,`WorkflowRunner` 选择不再等它。`exercise.md` 任务2亲手验证过：把这一行改回"等 dispose 完成再定终态"，"卡死子任务"那条测试就会从 79ms 内通过变成 5 秒后超时失败。

**4. 唯一终态怎么保证**

`settle()` 内部第一行是 `if (this.settled) return`——`settled` 是一个普通的实例布尔字段，`run()` 的 `.then()`/`.catch()` 和 `forceCancel()` 都调用同一个 `settle()`,不管谁先到、谁后到,第二次调用永远是 no-op,`resolveTerminal` 只会真正被调用一次。这跟 `Agent.dispose()`（Day6）的幂等纪律、`IdempotencyStore.claim()`（Day22）的"先占坑再执行"是同一类"用一个简单的已完成标志位挡住所有后来者"的模式,只是这里挡的是"终态只能被写一次"，不是"副作用只能被触发一次"。

**5. `maxAgents` 为什么最早一步就检查**

`run()` 的第一件事就是 `countAgentLeaves(tree)` 跟 `options.maxAgents` 比较,超了直接 `settle({kind:'error', ...})` 返回,连 `interpret()` 都不会被调用——`tests/workflow.test.ts:140` 那条测试之后还断言 `manager.runningChildCount` 是 0,证明没有任何一个子 Agent 被启动过。这是 Day19/Day26 一路延续下来的"fail-closed，先检查再行动"纪律,不是"跑到一半发现超限再回滚"——回滚意味着已经启动的子 Agent 要被清理,清理本身又要面对"能不能保证真的清理干净"这个跟上一条同样的诚实缺口,能在最早一步挡住就不用面对这个问题。

**6. `pipeline` 故意没做的事**

`interpret()` 的 `pipeline` 分支是一个普通的 `for...of` 循环,依次 `await this.interpret(step)`——每一步的 `task` 文本来自脚本写死的 `WorkflowNode.task` 字段,不会把上一步的 `StructuredResult` 喂给下一步作为输入。这是刻意的范围收缩：真正做到"上一步结果驱动下一步任务内容"需要一个"模板变量"或者"脚本在执行中途重新求值"的机制,而这门课的 DSL 是执行前就已经建完的静态树（见下方阶段门禁问答）,不支持执行中途根据结果分支/改写后续节点。

## 阶段门禁

**"为什么 workflow DSL 是静态树，不是模型在执行中途动态生成/分支的脚本"**

静态树换来的是"可审计"——`buildWorkflowFromScript()` 在任何一个子 Agent 真正启动之前,就已经把整棵计划树以纯 JSON 的形式完整摊开在那里,可以在执行前被记录、被人工审查、被 `countAgentLeaves()` 这类静态分析工具检查（这正是 `maxAgents` fail-closed 检查能够成立的前提——如果树是边跑边生成的,`maxAgents` 就只能变成"运行时数到第 N 个就拒绝",挡不住"已经启动的这几个"）。放弃的是"模型能根据某一步执行到一半的真实结果,动态决定接下来并行跑几个、跑哪几个子任务"这种更灵活的编排——原大纲提到的第三种编排风格（模型生成 workflow 脚本、执行中途分支）需要在执行过程里重新调用模型、重新解释新生成的代码,这是一整套跟"审计"这个目标存在张力的能力（"生成即执行、无法提前审查"和"先展示计划、批准后再跑"是两种不同的权衡,`propose-edit`——Day21——走的是后者,`WorkflowRunner` 延续了同一个选择）,今天的范围止步于"脚本先把整棵树建好,`WorkflowRunner` 才开始跑"。
