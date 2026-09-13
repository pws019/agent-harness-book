# mini-harness

这是《企业级 Agent / Agent Harness：30 天进阶学习计划》里贯穿全程、逐天演进的同一个工程。不要把它当成一次性写完的项目——每一天的代码都建立在前一天的基础上，接口会持续演进。

## 使用方式

```bash
cd mini-harness
pnpm install
pnpm test        # 跑当前进度的全部测试
pnpm typecheck    # 类型检查
```

## 如何对照每天的进度

每天的学习里程碑都会打一个 git tag（`day01` ~ `day15`）。如果你写练习时卡住了，想看"官方参考实现长什么样"，可以：

```bash
git log --oneline --all --tags   # 看看有哪些里程碑
git diff day03..day04            # 看 Day4 相对 Day3 具体改了什么
git checkout day04 -- mini-harness/src   # 只取出 Day4 结束时的代码状态看看（不会切分支）
```

建议的做法是：先看对应 `modules/dayXX/exercise.md` 里的任务描述，自己动手写一版，卡住超过 30-40 分钟再对照 tag 里的参考实现，而不是一上来就抄。

## 目录说明（会随天数增长）

- `src/llm/` —— 消息模型、流式组装、Adapter（Day2、Day3 引入）
- `src/tools/` —— 工具注册表与执行管线（Day4 引入）、workspace 越界检测/hash/diff/原子写这类文件操作辅助与写工具 `edit_file`（Day15 引入）
- `src/core/` —— Agent loop、生命周期与取消（Day5、Day6 引入）、事件日志与消息派生（Day8 引入）、持久化与崩溃恢复（Day9 引入）、投影/查询/标题/Spill（Day10 引入）、系统提示词（Day11 引入）、Token 计量与预算（Day12 引入）、上下文压缩（Day13 引入）、真实文件持久化（Day14 引入）
- `tests/` —— 单元测试、场景测试、故障注入测试

详细记录见 [CHANGELOG.md](./CHANGELOG.md)。
