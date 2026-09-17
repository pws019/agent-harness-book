# eval-plan.md：基于 `EvalHarness`（Day28）的评测方法论

## 场景清单：三类断言，覆盖"结果对不对"的三个不同角度

`src/core/eval-harness.ts`（Day28）的 `ScenarioAssertion` 是三选一判别联合，不是可以随意堆叠的一堆布尔标志：

| 断言类型 | 回答的问题 | 今天的具体用例 |
|---|---|---|
| `final-text-includes` | 最终产出的文本有没有提到该提到的证据 | `graduation-demo.ts` 隐含验证：`evidence.includes(query)` |
| `tool-called` | 有没有真的调用过该调用的工具 | `tests/eval-harness.test.ts` 验证 `list_files`/`search_text` |
| `stop-reason` | 有没有以预期的方式收尾 | `graduation-demo.ts` 验证 `investigationRecord.stopReason.kind === 'completed'` |

## 离线场景集：建议清单（今天没有全部实现，是留给毕业项目的模板）

1. **正常路径**：给定一个包含明确证据的工作区，断言最终文本包含证据、调用过 `search_text`、以 `completed` 收尾。
2. **证据缺失路径**：工作区里没有任何匹配内容，断言仍然以 `completed` 收尾（不是错误），但最终文本诚实说明"没找到"。
3. **权限边界路径**：给一个只读预设,断言涉及写操作的工具调用被拒绝,`stopReason` 不是 `completed`（如果整个 turn 因此提前结束）。
4. **预算耗尽路径**：给一个很小的 `maxSteps`/`maxToolCalls`，断言 `stopReason.kind === 'budget_exhausted'`，不是无限循环。

## 模型抽样评测：`sampleScenario()` 的方法论与诚实边界

`sampleScenario(scenario, n, adapterFactory)`（Day28）跑 n 次、聚合通过率——这条机制本身已经用 `createFlakySampleAdapter()`（一个带种子随机性的合成 adapter）验证过是对的：同一个种子两次运行产出完全相同的 `SampleReport`（`tests/eval-harness.test.ts` 验证过）。

**用到真实 provider 时该怎么用**：
1. 选一个足够小、结果可以人工判断对错的场景（比如"这个 workspace 里有没有 TODO 注释"）。
2. 用真实 provider 的 adapter 替换 `adapterFactory`，跑 `sampleScenario(scenario, 20, realAdapterFactory)`。
3. 通过率明显低于 100%（比如 60%-90%）时，不代表"这个功能坏了"——代表"这个任务在当前 prompt/模型组合下不够稳定",该做的是回去改 prompt/工具描述,不是把断言放宽到总能通过。
4. 通过率是 0% 或 100% 且稳定复现，通常代表断言写错了（要么恒真要么恒假），不是模型真的稳定成功/失败——先怀疑断言,再怀疑模型。

**诚实边界**：这门课至今没有接入任何真实的非确定性 provider（`HeuristicInvestigationAdapter` 完全确定性），`sampleScenario()` 本身可用,但从没有被用来产出过一份有真实信息量的抽样报告——`modules/day28-telemetry-audit-eval/study.md` §5.2 已经记录过这条边界，这里不重复展开。

## Contract test：跟单元测试的区别

这门课里"contract test"指的是`tests/session-milestone.test.ts`/`tests/graduation-demo.test.ts`这类——不是测试单个函数的输入输出，是测试"一整条真实调用链跑完之后，产出的东西满不满足一组约定好的性质"（比如"持久化文件不被截断"、"重建出的 Agent 历史条数对得上"）。`EvalHarness` 是把这类测试从"每次手写一段 `expect(...)`"升级成"声明式列一组断言，跑完自动逐条核对"，两者本质是同一件事的不同表达方式,不是两套独立机制。
