# Day 22・HTTP Server、API Gateway 与流式协议

> 阶段：IV. 平台化与编排　|　产出：新增 `src/server/`（`wire-protocol.ts`/`idempotency-store.ts`/`session-registry.ts`/`http-server.ts`），把 `Agent` 第一次接进一个真实的 `node:http` 服务器

## 今天要学会什么

1. 理解为什么"流"必须靠 `Transfer-Encoding: chunked`，不能靠 `Content-Length`——以及 `res.write()` 返回 `false`、它的 callback 才真正触发，具体对应的是什么真实机制，不是抽象概念。
2. 理解流协议为什么要把 `baseline`/`increment`/`terminal`/`transport-error` 显式区分成四种消息，尤其是 `terminal`（应用层：任务做完了）和 `transport-error`（传输层：连接本身断了）为什么不能合并成一种"流结束了"。
3. 理解幂等 key 为什么必须在真正触发副作用**之前**"占位"（`claim()`），而不是执行完之后再检查有没有重复——以及为什么两个并发请求不会都拿到"是第一次见到这个 key"的判断。
4. 理解为什么"给每条连接一个积压字节上限"这条规则要拆成一个不碰真实 socket 的纯函数（`createBacklogWriter`）单独测试，而不是直接在真实 IO 上靠撑爆操作系统缓冲区来验证。
5. 理解 bearer token 鉴权和真正的多用户授权模型有什么区别，这个项目今天做到了哪一步、哪一步没做。

## 怎么学

1. 读 [study.md](./study.md)——§0 是给没有后端/网络背景的人补的前置知识（TCP/HTTP/chunked/backpressure），从这里开始读，不要跳过。
2. 读代码，顺序建议：`src/server/wire-protocol.ts`（线格式）→ `src/server/idempotency-store.ts`/`src/server/backlog-writer.ts`（两个独立的小机制）→ `src/server/session-registry.ts`（谁拥有 `Agent`）→ `src/server/http-server.ts`（把前面几个串成真实路由）。
3. 跑 `tests/wire-protocol` 相关测试（`tests/backlog-writer.test.ts`、`tests/idempotency-store.test.ts`）和端到端的 `tests/http-server.test.ts`（真实临时端口、真实 socket，不 mock IO）。
4. 亲手跑一遍（这是这门课第一次真的起一个能被 `curl` 访问的服务）。`npx tsx -e "..."` 这种一次性内联脚本的相对 import 路径解析不了（`tsx` 的 eval 模式没有一个真实的文件位置可以当基准），所以写一个真的文件：

```bash
cd mini-harness
cat > /tmp/day22-smoke-server.ts <<'EOF'
import { createHttpServer } from '/Users/whitesmith/Study/agent-harness-book/mini-harness/src/server/http-server.js'
import { HeuristicInvestigationAdapter } from '/Users/whitesmith/Study/agent-harness-book/mini-harness/src/heuristic-adapter.js'
import { createReadOnlyFsTools } from '/Users/whitesmith/Study/agent-harness-book/mini-harness/src/tools/fs-tools.js'
import { ToolRegistry } from '/Users/whitesmith/Study/agent-harness-book/mini-harness/src/tools/registry.js'

const server = createHttpServer({
  createAgentDeps: () => {
    const tools = new ToolRegistry()
    for (const tool of createReadOnlyFsTools(process.cwd())) tools.define(tool)
    return { adapter: new HeuristicInvestigationAdapter('TODO'), tools, provider: 'demo', model: 'heuristic' }
  },
})
server.listen(8934, () => console.log('listening on 8934'))
EOF
npx tsx /tmp/day22-smoke-server.ts
```

（真实项目里这份脚本应该放进 `mini-harness/` 目录本身、用相对路径 import——这里写绝对路径只是因为要放进 `/tmp` 演示，不想让你把一个一次性脚本提交进仓库。）

另开一个终端：

```bash
SID=$(curl -s -X POST http://127.0.0.1:8934/sessions | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).sessionId))')
curl -sN "http://127.0.0.1:8934/sessions/$SID/events" &
curl -s -X POST "http://127.0.0.1:8934/sessions/$SID/messages" -H 'content-type: application/json' -d '{"text":"search TODO"}'
```

你会看到 `events` 那个连接实时打印出一条条 `baseline`/`increment`/`terminal`——这正是"流"这件事从零到有的真实样子。

5. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：重复提交同一个 `Idempotency-Key` 为什么不会启动两个 `Agent.send()`——具体是哪一行代码在防止这件事,不是泛泛地说"有幂等机制"。
- 你能解释：慢客户端为什么会让服务端内存无限增长，以及"给每条连接一个硬性积压字节上限"这个方案，为什么测试代码不需要真的撑爆操作系统的 socket 缓冲区就能确定性地验证它生效。
- 你能解释：`terminal` 和 `transport-error` 分别对应什么场景，客户端收到这两种消息应该分别怎么反应。
- `pnpm test` 全绿。
