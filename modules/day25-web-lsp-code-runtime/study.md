# 白话讲解：Web、LSP 与代码运行时能力

> 素材来源：DSH `docs/subsystems/web.zh.md`、`docs/subsystems/lsp.zh.md`、`docs/subsystems/code-runtime.zh.md`。今天三件事表面上不相关（搜网页、查代码符号定义、跑一段脚本），但都在回答同一个问题："让 Agent 碰到项目边界之外的东西（外部网页、语言服务进程、一段临时代码）时，怎么定义'安全'"——三次答案完全不同，这正是今天最值得注意的地方。

## 0. 前置知识：这天为什么选了"真协议"这条路，不是进程内抄近道

原始大纲的 LSP 部分只说"提供语义查询，不存在时降级到文本搜索"，没规定具体怎么实现。摆在面前的是两条路：① 进程内直接调用 TypeScript 自带的 Compiler API（`ts.createProgram()` 之类），零子进程、零新协议，写起来简单；② 真的 spawn `typescript` 自带的 `tsserver`（VSCode 自己也是这么跟 TS 打交道的），走它自己的一套请求/响应协议。选了②——不是因为它更简单（明显更麻烦），是因为这门课到今天为止只真正实现过一种协议（Day22 的换行分隔 JSON），而"协议"这个概念本身值得再练一次、换一种形状：Day22 是"我自己设计的协议"，今天是"接入一个已经存在、有自己既定行为的真实协议"，后者更接近真实工作中"对接第三方系统"的经验。

## 1. 一次语义查询要经过哪些代码

```
调用方：SemanticQueryProvider.findDefinition(root, filePath, identifierName)
      │
      ▼
withFallback(primary, fallback)                    ← semantic-query.ts
      │
      ├─ primary.findDefinition(...)  ← TsserverProvider
      │     │
      │     ├─ locateIdentifier(fileText, identifierName)   ← 在文件里找这个名字在哪一行第几列
      │     │    （跳过明显的整行注释，见第4节的真实教训）
      │     ├─ TsserverClient.open(file)
      │     └─ TsserverClient.definition(file, line, offset)
      │           │
      │           ▼
      │        真实的 tsserver 子进程（node_modules/.bin/tsserver）
      │           │  Content-Length 帧协议，见第2节
      │           ▼
      │        {kind:'semantic', locations} 或 {kind:'no-results'}
      │
      └─ 主查询失败/抛错/查不到 → fallback.findDefinition(...)  ← TextSearchFallbackProvider
            │
            ▼
         Day15 search_text 工具，纯文本匹配
            │
            ▼
         {kind:'text-fallback', matches} 或 {kind:'no-results'}
```

## 2. `tsserver` 的协议：实测确认，不是照抄 LSP 规范

`tsserver` 的协议是**实测确认**的（写这份文档之前，先用一个几十行的脚本直接 spawn 了真实的 `tsserver`、手动发过请求、打印过原始 stdout，看清楚了协议长什么样，再动手写 `TsserverClient`——这也是这门课"引用一串具体调用序列前先跑一遍确认"这条纪律在今天的应用）：

- **请求**：一行 JSON（`{seq, type:'request', command, arguments}`）+ `\n`，写进 stdin，不需要任何 header。
- **响应/事件**：`Content-Length: N\r\n\r\n` + 精确 N 字节 JSON——这是 LSP 规范用的同一种 header framing，但 `tsserver` 的协议其实比 LSP 规范还早，两者不是谁抄谁，只是撞上了同一个解法：消息体本身可能包含任意字符（包括裸露的换行符），"先声明精确字节数、再按字节数切"才是唯一可靠的分帧方式。这跟 Day22 `wire-protocol.ts` 选的换行分隔 JSON 刻意不同——Day22 的每条 envelope 保证是一整行 JSON（`JSON.stringify()` 输出不含裸换行），可以简单按 `\n` 切分；`tsserver` 的协议设计者显然不想依赖"消息体绝不含换行"这个假设，选了更保守的 Content-Length 方案。**同一类问题（怎么在字节流上切出一条条消息），两个不同场景给出了两种不同但都合理的答案**——协议设计没有唯一正确解，取决于"消息体的形状能不能被信任"这个具体约束。
- 服务器会主动推送 **event** 消息（比如 `projectLoadingStart`，索引项目进度）——`TsserverClient.handleMessage()`（[tsserver-client.ts:85-91](../../mini-harness/src/core/tsserver-client.ts#L85-L91)）只把 `type === 'response'` 且 `request_seq` 匹配的消息喂给等待中的请求，其它一律跳过。

## 3. 为什么不复用 Day16/17 的 `spawnManaged()`——只复用真正通用的那一小块

第一反应可能是"子进程管理不是 Day16/17 已经做好了吗，直接拿来用"——但 `spawnManaged()`（Day16/17）的整个抽象形状是"喂一次性的 stdin、收集完整 stdout、等进程退出"，`tsserver` 是完全不同的形状："长期存活、按需写请求、按需读响应，永远不主动退出"。硬套 `spawnManaged()` 的接口（`ManagedProcess` 只暴露 `stdoutSnapshot()`/`stderrSnapshot()`，没有"实时收到新数据就回调""随时写新内容进 stdin"这类接口）不会让代码更简单，只会让 `tsserver-client.ts` 的代码看起来像在拧螺丝但用的是扳手。

真正通用、值得复用的只有一小块：杀掉整棵进程树的逻辑。这部分从 `spawnManaged()` 内部拆成了一个独立的导出函数 `killProcessTree()`（[process-runner.ts](../../mini-harness/src/tools/process-runner.ts)），`spawnManaged()` 自己的 `killTree` 现在只是对它的一层转发，Day16 原有的全部测试一行没改、继续通过。`TsserverClient` 用裸的 `child_process.spawn()`（自己控制 stdin/stdout 的读写时机），但复用这一个函数做真正的清理（`dispose()` 调用 `killProcessTree()`）。**这是"深模块，只把真正通用的部分抽出来复用，不强行套用不合身的大接口"的一次具体示范**——跟 Day17 把 `spawnManaged()` 整个从 `runProcess()` 拆出来是同一种纪律，只是这次拆得更小、更精确。

## 4. 一个真实踩到的坑：`locateIdentifier` 第一版找到了注释里的名字

`TsserverProvider.findDefinition()` 需要把"一个标识符的名字"翻译成"文件里第几行第几列"，因为 `tsserver` 的 `definition` 命令要的是坐标，不是名字。第一版实现用一个简单的正则找"这个名字第一次作为完整单词出现的位置"——写完测试跑起来，查 `session.ts` 里的 `Session` 这个类名，`tsserver` 老实报告"查无此符号"（`no-results`），不是 bug，是**真的查到了一个不存在符号的位置**：`session.ts` 顶部的 JSDoc 注释里第一次提到"Session"这个词（"简化版的 turn 结束原因，只给 Session 记录用"），比真正的 `export class Session` 声明早得多——第一版的"找第一次出现"直接定位到了这行注释里，`tsserver` 在注释位置查定义,当然什么都查不到。

**修复**（[semantic-query.ts:36-41](../../mini-harness/src/core/semantic-query.ts#L36-L41) `looksLikeCommentLine()`）：跳过明显以 `//`/`/*`/`*` 开头的整行，再继续找第一次出现的位置。这不是完整的语法分析——跳不过行内尾随注释、字符串字面量里出现的同名文本——但对这个代码库自己的 JSDoc 风格（大量整行注释）已经足够可靠。这条坑本身也是"文本层面的启发式定位"这类简化方案的一个真实缩影：**能用，但边界情况需要一条一条被真的跑出来才会发现**，不是靠"想清楚"就能提前穷举的。

## 5. `withFallback`：这门课第一次明确写出来的合法 fail-open

Day18 `CommandPolicy` 的 fail-closed（策略求值本身出错就拒绝）、Day20 `FailClosedCommandPolicy` 反复强调的是同一条纪律："出错就拒绝，不能悄悄放行"。`withFallback()`（[semantic-query.ts:102-113](../../mini-harness/src/core/semantic-query.ts#L102-L113)）故意唱反调——语义查询查不到/连不上，不是拒绝整个操作，是老实降级成一个更弱、但依然有用的能力（文本搜索）：

```ts
async findDefinition(root, filePath, identifierName) {
  try {
    const result = await primary.findDefinition(root, filePath, identifierName)
    if (result.kind !== 'no-results') return result
  } catch {
    // 语义服务本身连不上/超时——降级，不向上抛错。
  }
  return fallback.findDefinition(root, filePath, identifierName)
}
```

**为什么这里 fail-open 是对的,而 `run_command`/`edit_file` 的 fail-closed 是对的,两者不矛盾**：判断该 fail-closed 还是 fail-open 的标准从来不是"出错了就该怎样"这一句话能回答的,是"这一步失败之后,继续往下走的代价是什么"。`run_command` 的策略判断如果失败了还继续执行,代价是一个本该被拒绝的危险命令真的跑了——不可逆、有真实副作用。语义查询失败了还继续（降级成文本搜索）,代价只是"这次给出的结果不够精确",调用方（未来的模型）看到的是一份可信度更低但依然有信息量的结果,不是一次被绕过的安全检查。**先问"这一步是不是在把关一个不可逆的副作用",再决定 fail-open 还是 fail-closed**，不能把"fail-closed 更安全"当成到处适用的口号。

## 6. Web 工具：搜索不接真实网络，抓取接真实 socket 但只打本地 fixture

`createWebSearchTool()`（[web-search-tool.ts:41](../../mini-harness/src/tools/web-search-tool.ts#L41)）背后的 `FixtureSearchIndex` 是一份写死的索引，不接任何真实搜索 API——跟 Day7 `HeuristicInvestigationAdapter` 同一个理由：真实网络搜索的结果会变，测试没法可复现，还得管一个 API key。`createWebFetchTool()`（[web-fetch-tool.ts:39](../../mini-harness/src/tools/web-fetch-tool.ts#L39)）不一样——它是真的打 `fetch()`，测试里指向一个本地起的、完全受控的 `node:http` fixture 服务器（不是 mock，是真实 socket、真实 HTTP 响应），跟 Day16 `run_command`"真实 IO，不 mock"是同一个纪律,只是把"本地进程"换成了"本地 HTTP 服务器"。两个工具都把结果标成 `provenance: 'untrusted-external'`——这是 README 验收标准点名的那条："外部内容始终作为不可信数据进入上下文"，靠这个字段落地,不是靠调用方自己记得要小心。`WebFetchToolOptions.policy` 直接复用 Day18 `CommandPolicy`（把目标主机名当"command"检查),不是各自发明一套平行的策略。

## 7. `CodeRuntime`：一次亲手验证过的、真实的沙箱逃逸

`CodeRuntime`（[code-runtime.ts:28](../../mini-harness/src/core/code-runtime.ts#L28)）用 `node:vm` + 一份显式冻结的绑定白名单——不给 `require`、不给 `process`。Node 官方文档自己说得很清楚：`vm` 模块不是安全边界。这门课不满足于"引用一句官方文档的警告"，而是真的写了一个逃逸出来：

```ts
const helper = () => 42          // 一个看起来完全无害的绑定函数
runtime.run('helper.constructor.constructor("return process.pid")()', { helper })
// → 真的拿到了宿主进程的真实 pid
```

**这个逃逸为什么会成立**：`helper` 是在宿主进程的 realm 里创建的普通函数——它的 `.constructor` 指向宿主 realm 的 `Function` 构造器，不是沙箱 context 自己那一份独立的 `Function`。沙箱脚本调用这个宿主 `Function` 构造器（`helper.constructor.constructor`）,用一段字符串当函数体（`"return process.pid"`）,构造出来的新函数天生运行在宿主 realm 里——对这个新函数来说，`process` 是一个真实存在的全局变量，不是沙箱里那个 `undefined`。`tests/code-runtime.test.ts` 里专门有一条测试验证："只传纯数据、不传任何函数绑定"的话，同样的逃逸手法会失败（沙箱自己 `{}`.constructor 链条上碰到的都是沙箱自己 realm 的内建对象，够不到宿主的 `Function`）——**任何传进沙箱的宿主函数,都是一条潜在的逃逸通道**,这条边界不是"小心不要传危险函数"就能靠自觉守住的，是这个隔离机制本身的结构性局限。

真要跑不可信代码，需要操作系统级别的隔离（容器、独立进程 + seccomp）——这门课零原生依赖的定位下没有做，跟 Day18 威胁模型"没有真 OS 沙箱"是同一个诚实的边界，`CodeRuntime` 提供的是"默认不给危险能力"这一层最基本的纪律，不是"绝对安全"的保证。

（第二个意外收获：调试 `CodeRuntime` 超时检测时发现,`vm.Script.runInContext()` 超时抛出的错误对象 `instanceof Error`（对宿主的 `Error` 检查）是 `false`——同一个跨 realm 问题的另一个表现：独立 realm 有自己的一套内建对象，宿主的 `instanceof` 认不出另一个 realm 里"构造器名字也叫 Error，但不是同一个 Error 类"的对象。[code-runtime.ts:33-45](../../mini-harness/src/core/code-runtime.ts#L33-L45) 因此改成检查 `error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'`——Node 给的稳定字符串标识符，不受这个问题影响。）

## 一句话总结

今天三件事共享同一条主线：**"边界之外的东西"没有一种统一的安全策略，取决于失败的代价是什么**——`web_search`/`web_fetch` 的答案是"打标记，让调用方知道这是不可信数据"；语义查询的答案是"查不到就诚实降级，不是拒绝服务"；`CodeRuntime` 的答案是"给最基本的默认限制,同时诚实承认这不是真安全边界"。三个答案都不是"更安全"或"更不安全"，是针对各自场景的失败代价算出来的不同结论——这也是为什么这份文档几乎每一节都在验证一个具体的坑或者一次具体的逃逸,而不是停留在"应该这样设计"的抽象描述。
