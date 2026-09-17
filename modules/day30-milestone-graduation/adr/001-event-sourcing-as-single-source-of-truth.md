# ADR-001：事件溯源作为唯一真源

**状态**：已采纳（Day8，贯穿全程）

## 背景

一个 Agent 的对话历史、持久化状态、审计轨迹、遥测数据,如果各自维护一份独立的数据结构,几乎必然会互相漂移——某一层更新了、另一层忘了同步，这类 bug 很难在写代码的当下发现,只会在两份数据被拿出来比较的那一刻才炸出来。

## 决定

`Session`（Day8）是仅追加、单调 `seq` 的事件日志,是唯一真源。`Agent.history`（Day8）、`projectSummary()`（Day10）、`deriveMessages()`（Day8）、`deriveTelemetry()`（Day28）全部是从这份日志现算出来的派生视图,没有一个是独立维护的缓存。

## 后果

**好处**：`tests/persistence-integration.test.ts`/`tests/graduation-demo.test.ts` 这类测试能够验证"全量 replay 与增量 projection 一致"（不变式清单第17条）——如果历史是分开维护的,这条不变式根本无法被简单地测出来。今天的 `Agent.compact()` 之所以能安全地把 Day13 压缩接进 `Agent`，也是因为压缩只是往同一份日志里追加几条新事件,不需要同步更新任何别的地方。

**代价**：每一个新的"视图"（遥测、审计关联、成本估算）都要重新写一遍"怎么从事件日志算出来",不能直接读一个现成的字段。Day28 `deriveTelemetry()` 的配对逻辑（`step/start`↔`assistant/message`）就是这个代价的具体体现——延迟不是被"记录"下来的,是被"算"出来的。
