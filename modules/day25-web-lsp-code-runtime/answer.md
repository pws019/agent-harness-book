# Day 25 答案

> 对照 [README.md](./README.md)「今天要学会什么」、[exercise.md](./exercise.md)「验收自查」和其中的思考题逐条作答。

## 今天要学会什么

**1. `tsserver` 真实协议长什么样**

请求是一行 JSON（`{seq, type:'request', command, arguments}`）+ 换行符，不需要 header；响应/事件是 `Content-Length: N\r\n\r\n` + 精确 N 字节 JSON，跟 LSP 规范用的同一种 header framing（两者互不抄袭，是撞上了同一个解法）。跟 Day22 自己设计的换行分隔 JSON 不同——Day22 的 `StreamEnvelope` 保证每条 envelope 是一整行、不含裸换行，可以简单按 `\n` 切；`tsserver` 的消息体不做这个保证，选了更保守的"先声明精确字节数"方案。

**2. 为什么不直接复用 `spawnManaged()`**

`spawnManaged()`（Day16/17）是"喂一次性 stdin、收集完整输出、等进程退出"的形状；`tsserver` 是"长期存活、按需写请求、按需读响应、永不主动退出"的形状——两者根本不兼容。真正通用的只有"杀整棵进程树"这一小块逻辑，被单独拆成了 `killProcessTree()`（`process-runner.ts`），`TsserverClient` 用裸的 `child_process.spawn()` 自己管理交互，只复用这一个函数做清理。

**3. 为什么 `withFallback()` 选 fail-open**

判断标准不是"哪个更安全"这句口号,是"这一步失败之后继续往下走的代价是什么"。`run_command`/`edit_file` 的策略判断如果失败了还继续执行,代价是一次不可逆的、真实的副作用真的发生了；语义查询失败了降级成文本搜索,代价只是"这次结果不够精确",调用方看到的是一份可信度更低但依然有信息量的结果。先问"这一步是不是在把关一个不可逆的副作用",再决定 fail-open 还是 fail-closed。

**4. 沙箱逃逸怎么发生的**

传进沙箱的任何宿主函数（哪怕看起来完全无害）,它的 `.constructor` 指向的是宿主 realm 的 `Function` 构造器,不是沙箱自己那份独立的。沙箱脚本可以用 `helper.constructor.constructor("恶意代码")()` 这条链路,借着宿主 `Function` 构造器造一个新函数——这个新函数天生运行在宿主 realm 里,能碰到真实的 `process` 等全局对象。`tests/code-runtime.test.ts` 里专门验证过："只传纯数据、不传任何函数"的话,同样的手法会失败,因为沙箱自己 `{}`.constructor 链条上碰到的都是沙箱自己 realm 的内建对象。

**5. 今天真实踩到的两个坑**：见下面「验收自查」详细展开。

## 验收自查

**任务1：`tsserver` 为什么会诚实报告"查无此符号"**：亲手验证过——`locateIdentifier()` 第一版找"这个名字第一次作为完整单词出现的位置"，没有跳过注释行。`session.ts` 顶部的 JSDoc 注释里第一次提到"Session"这个词，比真正的 `export class Session` 声明早得多；定位到这行注释之后，`tsserver` 在这个位置查定义——这个位置对应的是注释文字，不是任何真实的 TypeScript 符号，`tsserver` 没有查错，是真的没有符号可查，`no-results` 是完全诚实、正确的回应。这不是 `tsserver` 的 bug，是调用方（`locateIdentifier` 的第一版）给了它一个错误的坐标。

**任务2：`instanceof Error` 为什么在这里失效**：亲手验证过——`vm.createContext()` 建的是一个独立的 V8 realm，独立 realm 有自己完整的一套内建对象，包括自己的 `Error` 构造器。`runInContext()` 超时时，Node 内部抛出的这个错误对象，虽然 `error.constructor.name` 打印出来是 `"Error"`（名字一样），但它不是宿主这边 `Error` 全局变量所指向的那个构造函数——宿主的 `instanceof Error` 检查的是"这个对象的原型链上有没有宿主的 `Error.prototype`"，另一个 realm 里"看起来一样"的 `Error.prototype` 是一个完全不同的对象，检查自然返回 `false`。这是"两个东西长得一样、名字一样，但不是同一个东西"这类坑在 JavaScript realm 场景下的具体体现——`error.code`（一个纯字符串）不依赖任何原型链身份，所以不受这个问题影响。

**任务3：在必须传函数进沙箱的前提下,降低逃逸风险的缓解思路**：一条具体方向——不直接把宿主函数原样传进沙箱作为绑定，而是传一个**在沙箱侧只能被"调用"、拿不到其 `.constructor`/原型链的代理**。具体做法：在宿主侧维护真正的函数实现，往沙箱里只传一个数字/字符串 ID + 一个统一的 `__call(id, ...args)` 调度函数，脚本侧调用能力时走 `__call('readFile', path)` 这种形式，而不是直接拿到 `readFile` 这个真实的宿主函数对象。这样脚本能触达的、指向宿主 realm 的对象只剩下 `__call` 这一个函数本身——它依然是逃逸通道（`__call.constructor.constructor(...)` 同样的手法照样能用），**没有真正消除风险，只是把"暴露的宿主函数数量"从"每个能力一个"压缩成了"固定一个"**，理论上更容易审计、更容易在这一个函数上加额外的运行时检查（比如冻结 `__call` 本身，或者干脆把 `__call` 也用同样的"只给数据不给函数"套娃一层）。老实说这条缓解思路挡不住"传的宿主函数本身就是攻击者需要的唯一入口"这个根本问题——任何跟宿主 realm 有关联的对象都携带着同样的原型链风险，真正的解决办法还是 study.md 说的：需要跑不可信代码时用操作系统级别的隔离，`vm` 这一层怎么包都不构成真正的安全边界。
