# Day 4 答案

> 对照 [README.md](./README.md)「今天要学会什么」和 [exercise.md](./exercise.md)「验收自查」逐条作答。

## 今天要学会什么

**1. 工具是模型和确定性代码世界之间的契约**

`name`/`description`/`parameters` 是模型能看见的"说明书"；`output.schema` 是程序间约定的规范数据形状；`execute()` 是真正干活的函数体，模型看不到；`output.render()` 把内部结构化值翻译成模型能看的文本，必须是纯函数、不能抛异常（因为它既服务实时渲染,也服务回放历史工具调用,不能让"重放时环境变了"影响展示结果）。

**2. 浅工具的代价**

如果把"读文件"拆成 `open`/`seek`/`read`/`close` 四连招，模型要在多次调用间正确传递状态（句柄、偏移量），任何一步算错就读到乱码，错误只在最后一步暴露，还消耗 4 倍上下文换 1 次有效读取。

**3. 深工具设计**

`read_file` 的参数只有 `file_path`/`offset`/`limit` 三个意图层面的参数，一次调用返回带行号的内容——模型不需要关心字节偏移这种实现细节。

**4. 统一的工具执行管线**

`ToolRegistry.execute()` 把每次调用推过同一条管线：参数校验 → 取消检查 →（超时/取消赛跑）→ `tool.execute()` → `output.render()` → `ToolResult`。这些复杂性统一在管线里处理，工具作者只管实现 `execute()`本身。

## 验收自查

**`assertExplicitAdditionalProperties()` 防住了什么问题**：它在**定义期**（调用 `registry.define()` 的那一刻）强制每个 object 节点必须显式声明 `additionalProperties: true` 或 `false`，忘记声明直接抛错，工具都注册不进去。这是"用设计定义掉特殊情况"——不是等到运行时收到一个多余字段才发现没处理，而是从一开始就不允许含糊的 schema 存在,逼工具作者提前想清楚"未知参数到底该不该被接受"。

**取消检查时机那个坑**：调用一个 `async function` 会**立即同步执行它的函数体，直到第一个 `await`**才把控制权交还出去——如果先创建 `tool.execute(rawArgs, exec)` 这个 Promise 再传给 `runWithTimeoutAndAbort` 检查 `signal.aborted`，函数体里第一个 `await` 之前的同步副作用（比如把某个标志位设成 `true`）已经在检查取消之前跑完了。修复是把 `tool.execute(rawArgs, exec)` 换成一个"还没被调用的函数"（`() => tool.execute(rawArgs, exec)`），先检查 `signal.aborted`，确认没有取消，再真正调用它——检查取消的**时机**和调用的**先后顺序**本身就是协议的一部分,不是随便放在哪里都一样。
