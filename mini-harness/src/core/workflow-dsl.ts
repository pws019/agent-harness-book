import type { WorkflowNode } from './workflow-types.js'

/**
 * 四个纯构建函数——调用它们**不执行任何东西**，只是构建一棵 `WorkflowNode` 描述符
 * 树，延后到真正 `WorkflowRunner.run()` 的时候才会被解释、执行。这跟 React 的
 * `createElement()`（或者 JSX 编译出来的等价调用）是同一个形状：调用 `agent(...)`
 * 返回的是一个普通的描述对象，不会真的启动任何 Agent，后面有别的东西（这里是
 * `WorkflowRunner`）负责遍历这棵树、决定什么时候、怎么真正执行它。
 *
 * 这四个函数本身就是今天要接进 Day25 `CodeRuntime` 的绑定——一段脚本调用它们
 * 拼出一棵树，脚本本身完全不需要碰任何真实的 Agent/工具/网络连接。
 */
export function agent(agentId: string, task: string): WorkflowNode {
  return { kind: 'agent', agentId, task }
}

export function parallel(...children: readonly WorkflowNode[]): WorkflowNode {
  return { kind: 'parallel', children }
}

export function pipeline(...steps: readonly WorkflowNode[]): WorkflowNode {
  return { kind: 'pipeline', steps }
}

export function phase(name: string, node: WorkflowNode): WorkflowNode {
  return { kind: 'phase', name, node }
}
