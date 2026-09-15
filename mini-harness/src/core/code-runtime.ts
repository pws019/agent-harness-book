import { createContext, Script } from 'node:vm'

export class CodeRuntimeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`script did not finish within ${timeoutMs}ms`)
    this.name = 'CodeRuntimeTimeoutError'
  }
}

export interface RunOptions {
  readonly timeoutMs?: number
}

/**
 * `node:vm` + 一份显式冻结的绑定白名单——跟 Day18 `CommandPolicy` 同一种"显式列出
 * 能用什么，不是拉黑不能用什么"的纪律：不给 `require`、不给 `process`、不给任何
 * 环境对象，脚本能碰到的东西完全由调用方传进 `bindings` 决定。
 *
 * **诚实记录的缺口**：Node 官方文档自己说得很清楚——`vm` 模块**不是**一个安全边界，
 * 精心构造的脚本依然可能逃出 context、碰到宿主进程的真实对象（这不是这个项目独有
 * 的限制，是 `node:vm` 这个 API 本身的已知局限）。`CodeRuntime` 提供的是"默认不给
 * 危险能力"这一层最基本的纪律，不是"就算跑恶意代码也绝对安全"——真要跑不可信代码，
 * 需要操作系统级别的隔离（容器、独立进程 + seccomp，等等），跟 Day18 威胁模型讲
 * "没有真 OS 沙箱"是同一个诚实的边界。这也是为什么 `CodeRuntime` 要求调用方接入
 * 跟 `run_command` 同一套 `CommandPolicy`/`PermissionPreset` 机制——多一层判断,
 * 不是靠 `vm` 自己就万事大吉。
 */
export class CodeRuntime {
  run(source: string, bindings: Readonly<Record<string, unknown>>, options: RunOptions = {}): unknown {
    const sandbox = Object.freeze({ ...bindings })
    const context = createContext(sandbox)
    const script = new Script(source)
    try {
      return script.runInContext(context, { timeout: options.timeoutMs ?? 2_000 })
    } catch (error) {
      // 故意不用 `error instanceof Error` 来判断——实测发现（不是设计之初就知道的）：
      // `runInContext()` 超时抛出的这个错误，`instanceof Error`（对宿主的 `Error`
      // 全局对象）check 是 `false`，尽管 `error.constructor.name` 打印出来就是
      // "Error"。这本身就是跨 realm 场景下 `instanceof` 不可靠的一个真实例子——
      // `vm.createContext()` 建的是一个独立的 realm，独立 realm 有自己的一套内建
      // 对象（包括 `Error`），宿主这边的 `instanceof Error` 认的是宿主自己的
      // `Error` 构造器，认不出另一个 realm 里"看起来一样"的错误对象。`error.code`
      // 是 Node 自己给的稳定字符串标识符，不受这个问题影响，比 `instanceof`
      // 或者拿 `error.message` 的文本去匹配都更可靠。
      if ((error as { readonly code?: string } | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        throw new CodeRuntimeTimeoutError(options.timeoutMs ?? 2_000)
      }
      throw error
    }
  }
}
