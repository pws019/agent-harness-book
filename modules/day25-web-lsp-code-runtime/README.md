# Day 25・Web、LSP 与代码运行时能力

> 阶段：IV. 平台化与编排　|　产出：`src/core/tsserver-client.ts`（真实 tsserver 协议客户端）、`src/core/semantic-query.ts`（语义查询 + 文本降级）、`src/tools/web-search-tool.ts`/`web-fetch-tool.ts`、`src/core/code-runtime.ts`，外加 `src/tools/process-runner.ts` 新导出的 `killProcessTree()`

## 今天要学会什么

1. 理解 `tsserver` 的真实协议长什么样——请求和响应用的是不是同一种帧格式，跟 Day22 自己设计的换行分隔 JSON 协议比，为什么选了不同的分帧方式。
2. 理解为什么 `TsserverClient` 没有直接复用 Day16/17 的 `spawnManaged()`，只把其中"杀整棵进程树"这一小块逻辑单独拆出来复用——具体是什么形状上的不匹配导致了这个决定。
3. 理解 `withFallback()` 为什么在这里选择 fail-open，而不是延续 Day18/20 的 fail-closed 纪律——判断标准是什么，不是"看情况"。
4. 理解 `CodeRuntime` 的沙箱逃逸具体是怎么发生的——哪怕只传了一个看起来完全无害的绑定函数，为什么就够了。
5. 能说出今天代码里真实踩到的两个坑分别是什么（一个关于文本定位，一个关于跨 realm 的 `instanceof`），具体怎么发现的、怎么修的。

## 怎么学

1. 读 [study.md](./study.md)——§0 先讲清楚为什么这天特意选了"真协议"这条更难走的路。
2. 读代码，建议顺序：`src/tools/process-runner.ts`（看新导出的 `killProcessTree()`）→ `src/core/tsserver-client.ts` → `src/core/semantic-query.ts` → `src/tools/web-search-tool.ts`/`web-fetch-tool.ts` → `src/core/code-runtime.ts`。
3. 跑 `tests/tsserver-client.test.ts`、`tests/semantic-query.test.ts`（这两个会真的起 `tsserver` 子进程，比其它天的测试慢一些，属于正常现象）、`tests/web-search-tool.test.ts`、`tests/web-fetch-tool.test.ts`（真实 socket，打本地 fixture 服务器）、`tests/code-runtime.test.ts`（含一条真实复现沙箱逃逸的测试）。
4. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：外部抓取/搜索到的内容始终作为不可信数据进入上下文，具体是靠哪个字段落地的，这个标记能不能在渲染成模型真正看到的文本之后依然保留。
- 你能解释：`web_fetch`/`CodeRuntime` 分别怎么复用 Day18 的 `CommandPolicy` 机制,不是各自发明一套平行的策略。
- 你能解释：`CodeRuntime` 的沙箱逃逸测试具体做了什么，为什么"只传数据、不传函数"就能挡住这个特定的逃逸手法。
- `pnpm test` 全绿（注意 `tsserver` 相关测试需要联网安装依赖已完成、`node_modules/.bin/tsserver` 真实存在——这个项目的 `typescript` 已经是既有工具链依赖，不需要额外安装）。
