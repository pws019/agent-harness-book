/**
 * 一棵计划树的描述符——四选一，跟 `SessionEvent`/`StreamEnvelope` 同一套封闭联合
 * 类型纪律。刻意设计成**纯数据**（`isJsonValue()` 能安全通过）：`agent` 叶子只带
 * 一个 `agentId`（字符串引用）和一段任务文本，不直接嵌入真实的 `AgentDeps`
 * （adapter/工具注册表这类活的宿主对象）——真正的 `AgentDeps` 由 `WorkflowRunner`
 * 在**真正执行**的那一刻,通过 `agentId` 从一份注册表里查出来,不会出现在树本身里。
 * 这个决定让这棵树可以安全地从 Day25 `CodeRuntime`（`node:vm`）里的脚本构建出来，
 * 不需要把真实的宿主函数/对象传进沙箱当参数。
 */
export type WorkflowNode =
  | { readonly kind: 'agent'; readonly agentId: string; readonly task: string }
  | { readonly kind: 'parallel'; readonly children: readonly WorkflowNode[] }
  | { readonly kind: 'pipeline'; readonly steps: readonly WorkflowNode[] }
  | { readonly kind: 'phase'; readonly name: string; readonly node: WorkflowNode }

export function assertNeverWorkflowNode(value: never): never {
  throw new Error(`Unhandled WorkflowNode variant: ${JSON.stringify(value)}`)
}

/** 运行时校验一个值是不是合法的 `WorkflowNode`——`CodeRuntime`（`node:vm`）跑完一段
 * 脚本拿到的返回值只是 `unknown`，脚本作者完全可能写错（比如最后一句不是
 * `agent(...)`/`parallel(...)` 调用，而是随手写的字符串）,这个函数把"这段脚本的
 * 完成值到底是不是一棵合法计划树"这件事从隐式假设变成显式检查，检查不通过就
 * fail-closed 拒绝，不会把一个形状不对的值硬塞给 `WorkflowRunner.interpret()`
 * 造成运行时才炸的更晦涩的错误。 */
export function isWorkflowNode(value: unknown): value is WorkflowNode {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return false
  const node = value as { readonly kind: unknown }
  switch (node.kind) {
    case 'agent': {
      const n = value as { readonly agentId?: unknown; readonly task?: unknown }
      return typeof n.agentId === 'string' && typeof n.task === 'string'
    }
    case 'parallel': {
      const n = value as { readonly children?: unknown }
      return Array.isArray(n.children) && n.children.every(isWorkflowNode)
    }
    case 'pipeline': {
      const n = value as { readonly steps?: unknown }
      return Array.isArray(n.steps) && n.steps.every(isWorkflowNode)
    }
    case 'phase': {
      const n = value as { readonly name?: unknown; readonly node?: unknown }
      return typeof n.name === 'string' && isWorkflowNode(n.node)
    }
    default:
      return false
  }
}

/** 树里用到的所有不重复 `agentId`——CLI 的 `run-workflow` 子命令用它决定要为哪些
 * agentId 准备真实的 `AgentDeps`,不用调用方自己再重复一遍遍历树的逻辑。 */
export function collectAgentIds(node: WorkflowNode): readonly string[] {
  const ids = new Set<string>()
  const visit = (n: WorkflowNode): void => {
    switch (n.kind) {
      case 'agent':
        ids.add(n.agentId)
        return
      case 'parallel':
        n.children.forEach(visit)
        return
      case 'pipeline':
        n.steps.forEach(visit)
        return
      case 'phase':
        visit(n.node)
        return
      default:
        assertNeverWorkflowNode(n)
    }
  }
  visit(node)
  return [...ids]
}

/** 树里一共有几个 `agent` 叶子——`WorkflowRunner` 在真正启动任何一个子 Agent 之前
 * 用它跟 `maxAgents` 比较，跟 Day19/26 "fail-closed，先检查再行动"是同一个纪律。 */
export function countAgentLeaves(node: WorkflowNode): number {
  switch (node.kind) {
    case 'agent':
      return 1
    case 'parallel':
      return node.children.reduce((sum, child) => sum + countAgentLeaves(child), 0)
    case 'pipeline':
      return node.steps.reduce((sum, step) => sum + countAgentLeaves(step), 0)
    case 'phase':
      return countAgentLeaves(node.node)
    default:
      return assertNeverWorkflowNode(node)
  }
}
