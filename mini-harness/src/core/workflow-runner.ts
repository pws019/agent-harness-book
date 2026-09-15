import type { AgentDeps } from './agent-handle.js'
import { CodeRuntime, type RunOptions } from './code-runtime.js'
import type { StructuredResult } from './structured-result.js'
import type { SubagentHandle, SubagentManager } from './subagent.js'
import { agent, parallel, phase, pipeline } from './workflow-dsl.js'
import { assertNeverWorkflowNode, countAgentLeaves, isWorkflowNode, type WorkflowNode } from './workflow-types.js'

export class WorkflowScriptError extends Error {
  constructor(reason: string) {
    super(`workflow script did not produce a valid WorkflowNode: ${reason}`)
    this.name = 'WorkflowScriptError'
  }
}

/**
 * 把 Day27 四个 DSL 构建函数（`agent`/`parallel`/`pipeline`/`phase`）当作唯一的
 * 全局绑定，喂给 Day25 `CodeRuntime` 跑一段脚本——这是 `CodeRuntime` 写完以来
 * 第一个真正的调用方（之前只在 `code-runtime.test.ts` 里被直接测试过）。脚本里
 * 最后一条语句的求值结果就是这棵计划树（`Script.runInContext()` 返回完成值，
 * 跟在 Node REPL 里粘贴一段代码、最后一行自动打印出来是同一个机制）——例如
 * `pipeline(agent('a', 'do x'), agent('b', 'do y'))` 作为脚本的最后一句。
 * 返回值先过 `isWorkflowNode()` 校验，脚本写错（比如最后一句不是合法的树）会在
 * 这里就被拒绝，不会等到 `WorkflowRunner.run()` 才炸出更晦涩的错误。
 */
export function buildWorkflowFromScript(source: string, options?: RunOptions): WorkflowNode {
  const runtime = new CodeRuntime()
  const result = runtime.run(source, { agent, parallel, pipeline, phase }, options)
  if (!isWorkflowNode(result)) {
    throw new WorkflowScriptError(`script's completion value was ${JSON.stringify(result)}, expected a WorkflowNode built from agent()/parallel()/pipeline()/phase()`)
  }
  return result
}

export type WorkflowResultNode =
  | { readonly kind: 'agent'; readonly agentId: string; readonly result: StructuredResult }
  | { readonly kind: 'parallel'; readonly children: readonly WorkflowResultNode[] }
  | { readonly kind: 'pipeline'; readonly steps: readonly WorkflowResultNode[] }
  | { readonly kind: 'phase'; readonly name: string; readonly result: WorkflowResultNode }

/** 唯一终态——三选一，`run()`/`cancel()` 无论谁先到，最终只会产出**恰好一条**
 * 这样的记录，不会出现"既完成了又被取消了"这种矛盾状态。 */
export type WorkflowTerminalState =
  | { readonly kind: 'completed'; readonly result: WorkflowResultNode }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string }

export interface WorkflowRunOptions {
  /** 这棵树里 `agent` 叶子的总数不能超过这个数——在真正启动任何一个子 Agent 之前
   * 就检查完，不是跑到一半才发现超了。 */
  readonly maxAgents: number
  /** 给了就是"有界清理时间"：这个时限一到，不管子任务配不配合，强制收尾成
   * `cancelled`。这是 Day17 `spawnManaged()` "信号 → 宽限期 → 强杀"升级模式的
   * 泛化版本，只是这里的"信号"是取消一整棵还在跑的子 Agent 树，不是杀一个进程。 */
  readonly forceCancelAfterMs?: number
}

/**
 * 把一棵 `WorkflowNode` 树解释成真正的执行——`agent` 叶子走 Day26
 * `SubagentManager.startChild()`；`parallel` 并发跑所有子节点；`pipeline` 依次
 * 跑（不做"上一步结果喂给下一步"这种更复杂的数据流,今天的范围止步于"按顺序执行"，
 * 见 study.md 的诚实记录）；`phase` 只是一个带名字的审计检查点，解释完内层节点
 * 之后原样透传结果，不附加任何额外的运行时语义。
 */
export class WorkflowRunner {
  private readonly startedChildren: SubagentHandle[] = []
  private settled = false
  private resolveTerminal!: (state: WorkflowTerminalState) => void
  private readonly terminalPromise: Promise<WorkflowTerminalState>

  constructor(
    private readonly subagentManager: SubagentManager,
    private readonly agentRegistry: ReadonlyMap<string, Omit<AgentDeps, 'sink'>>,
  ) {
    this.terminalPromise = new Promise((resolve) => {
      this.resolveTerminal = resolve
    })
  }

  private settle(state: WorkflowTerminalState): void {
    if (this.settled) return
    this.settled = true
    this.resolveTerminal(state)
  }

  async run(tree: WorkflowNode, options: WorkflowRunOptions): Promise<WorkflowTerminalState> {
    const agentCount = countAgentLeaves(tree)
    if (agentCount > options.maxAgents) {
      this.settle({ kind: 'error', message: `workflow tree has ${agentCount} agent leaves, exceeding maxAgents (${options.maxAgents})` })
      return this.terminalPromise
    }

    const forceTimer =
      options.forceCancelAfterMs !== undefined ? setTimeout(() => this.forceCancel(), options.forceCancelAfterMs) : undefined

    this.interpret(tree)
      .then((result) => {
        clearTimeout(forceTimer)
        this.settle({ kind: 'completed', result })
      })
      .catch((error: unknown) => {
        clearTimeout(forceTimer)
        this.settle({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })

    return this.terminalPromise
  }

  /** 调用方主动喊停——跟内部超时触发的强制收尾是同一套逻辑（`forceCancel()`）。 */
  async cancel(): Promise<void> {
    this.forceCancel()
  }

  /**
   * 无论是调用方主动 `cancel()`，还是 `forceCancelAfterMs` 超时触发，都走这里：
   * 立刻把终态定成 `cancelled`,不等任何子 Agent 真正退出——诚实的边界：
   * `handle.dispose()` 内部会调 `Agent.dispose()`（Day6），而 `Agent.dispose()`
   * 自己的实现是 `await this.runLoopPromise`（见 `agent-handle.ts`），也就是说
   * 如果子 Agent 的 adapter 完全不理会 `AbortSignal`（真的卡死,不只是慢）,
   * `dispose()` 本身也会无限期挂起。这里选择不等它——`dispose()` 调用照样发出去
   * （在后台跑,`.catch()` 吞掉错误）,但 `WorkflowRunner` 自己的终态记录立刻落定成
   * `cancelled`,不会因为某一个不配合的子任务被无限期拖住。这是 Day17
   * `spawnManaged()` "信号 → 宽限期 → 强杀"里"强杀"那一步在进程内 Agent 场景下的
   * 对应物——`SIGKILL` 对操作系统进程总是有效,但对一个纯 JS 对象内部卡在
   * `await` 上的循环,没有等价的"强杀"手段,只能不等它。
   */
  private forceCancel(): void {
    for (const handle of this.startedChildren) {
      void handle.dispose().catch(() => {})
    }
    this.settle({ kind: 'cancelled' })
  }

  private async interpret(node: WorkflowNode): Promise<WorkflowResultNode> {
    switch (node.kind) {
      case 'agent': {
        const deps = this.agentRegistry.get(node.agentId)
        if (!deps) throw new Error(`unknown agentId: "${node.agentId}" — not found in the agent registry`)
        const handle = this.subagentManager.startChild({
          deps,
          task: { role: 'user', blocks: [{ type: 'text', text: node.task }] },
        })
        this.startedChildren.push(handle)
        const result = await handle.result()
        return { kind: 'agent', agentId: node.agentId, result }
      }
      case 'parallel': {
        const children = await Promise.all(node.children.map((child) => this.interpret(child)))
        return { kind: 'parallel', children }
      }
      case 'pipeline': {
        const steps: WorkflowResultNode[] = []
        for (const step of node.steps) steps.push(await this.interpret(step))
        return { kind: 'pipeline', steps }
      }
      case 'phase': {
        const result = await this.interpret(node.node)
        return { kind: 'phase', name: node.name, result }
      }
      default:
        return assertNeverWorkflowNode(node)
    }
  }
}
