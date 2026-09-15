# Day 23・Client model、Conversation 与重连语义

> 阶段：IV. 平台化与编排　|　产出：新增 `src/client/`（`conversation.ts`/`reconnecting-stream.ts`/`fault-injecting-transport.ts`/`http-stream-connector.ts`/`terminal-client.ts`），一个能断线重连、最终收敛到服务端权威状态的终端客户端

## 今天要学会什么

1. 理解为什么"断线重连"不能只是"再发一次请求"——具体来说，游标（cursor）在这里解决的是什么问题，为什么它必须是"确认连续"的那个 seq，不能是"见过的最大 seq"。
2. 理解 `Conversation` 为什么用一个按 `seq` 索引的 `Map` 就能天然解决"重复投递"和"乱序到达"，但"缺口"必须靠一个显式的"确认连续到哪了"的指针单独处理——为什么不能把三者用同一套逻辑解决。
3. 理解 `study.md` §4 讲的那个真实踩到的坑：为什么"这次连接收到了 `terminal`"不等于"数据真的同步完整了"，具体是哪两处代码需要分别修正。
4. 理解为什么故障注入测试要用一份**真实跑出来的** `Agent` 事件日志当权威真相，而不是手写一份假数据。

## 怎么学

1. 读 [study.md](./study.md)——§0 讲清楚"断线重连"跟前端常见的"请求失败重试一次"有什么本质区别。
2. 读代码，顺序建议：`src/client/conversation.ts`（合并逻辑）→ `src/client/reconnecting-stream.ts`（什么时候算完成、什么时候该重连）→ `src/client/fault-injecting-transport.ts`（测试用的故障注入器）→ `src/client/http-stream-connector.ts`/`terminal-client.ts`（真实连 Day22 服务器的那一侧）。
3. 跑 `tests/conversation.test.ts`（合并逻辑的直接测试）和 `tests/client-reconnection.test.ts`（用 8 个不同种子跑故障注入，断言最终状态收敛到权威日志）。
4. 亲手跑一遍真实客户端——先按 Day22 README 的方法起一个服务器，另开一个终端：

```bash
cd mini-harness
cat > /tmp/day23-smoke-client.ts <<'EOF'
import { createHttpServer } from '/Users/YOUR_PATH/mini-harness/src/server/http-server.js'
import { HeuristicInvestigationAdapter } from '/Users/YOUR_PATH/mini-harness/src/heuristic-adapter.js'
import { createReadOnlyFsTools } from '/Users/YOUR_PATH/mini-harness/src/tools/fs-tools.js'
import { ToolRegistry } from '/Users/YOUR_PATH/mini-harness/src/tools/registry.js'
import { connectTerminalClient } from '/Users/YOUR_PATH/mini-harness/src/client/terminal-client.js'

const server = createHttpServer({
  createAgentDeps: () => {
    const tools = new ToolRegistry()
    for (const tool of createReadOnlyFsTools(process.cwd())) tools.define(tool)
    return { adapter: new HeuristicInvestigationAdapter('TODO'), tools, provider: 'demo', model: 'heuristic' }
  },
})
await new Promise<void>((resolve) => server.listen(8936, resolve))
const { sessionId } = await (await fetch('http://127.0.0.1:8936/sessions', { method: 'POST' })).json()
console.log('sessionId', sessionId)

const controller = new AbortController()
const clientPromise = connectTerminalClient(
  { baseUrl: 'http://127.0.0.1:8936', sessionId, onUpdate: (messages) => console.log('[update]', messages.at(-1)?.role) },
  controller.signal,
)
await fetch(`http://127.0.0.1:8936/sessions/${sessionId}/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'search TODO' }),
})
await new Promise((r) => setTimeout(r, 500))
controller.abort()
await clientPromise
server.close()
EOF
npx tsx /tmp/day23-smoke-client.ts
```

（记得把 `/Users/YOUR_PATH/mini-harness` 换成你自己的路径——`tsx` 的一次性脚本没有真实文件位置，相对 import 解析不了，这是 Day22 README 已经踩过、记录下来的坑。）

5. 做 [exercise.md](./exercise.md)。

## 验收标准

- 你能解释：`Conversation.cursor` 为什么是"确认连续"的 seq，不是"见过的最大 seq"——如果用后者去重连会发生什么。
- 你能解释：`study.md` §4 那个真实的坑——"收到 terminal 就能停止重连"这个第一版判断，具体在什么场景下会导致数据缺口永远补不上；为什么修复需要同时改 `reconnecting-stream.ts` 和 `fault-injecting-transport.ts` 两处，改一处不够。
- 你能解释：为什么"重复投递"和"乱序到达"靠 `Map` 的键唯一性/读取时排序就天然解决了，但"缺口"必须靠额外的 `highestContiguousSeq` 指针，不能用同一套机制。
- `pnpm test` 全绿。
