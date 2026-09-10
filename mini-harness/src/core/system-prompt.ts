import type { ToolSchema } from '../tools/types.js'

/**
 * 系统提示词的输入——固定分段，不是随手拼字符串。每次请求前都从当前的能力快照
 * 重新组装（见 buildSystemPrompt 下面的说明），不会缓存上一次的结果。
 */
export interface SystemPromptSections {
  readonly identity: string
  readonly workspaceRoot: string
  readonly tools: readonly ToolSchema[]
  readonly taskContext?: string
}

/**
 * 从固定分段拼出确定性的系统提示词字符串。刻意做成一个无状态的纯函数，不是某个
 * 对象的方法、也不缓存任何东西——**每次调用都必须重新传入当前的 `tools` 快照**，
 * 这是保证"工具被移除后 prompt 不再宣称它可用"这条不变式成立的唯一方式：如果这个
 * 函数自己攒了一份"上次算过的工具列表"，移除工具之后忘了让它失效，prompt 就会撒谎。
 */
export function buildSystemPrompt(sections: SystemPromptSections): string {
  const parts = [
    `# Identity\n${sections.identity}`,
    `# Workspace\n${sections.workspaceRoot}`,
    `# Available tools\n${renderToolList(sections.tools)}`,
  ]
  if (sections.taskContext) {
    parts.push(`# Task context\n${sections.taskContext}`)
  }
  return parts.join('\n\n')
}

function renderToolList(tools: readonly ToolSchema[]): string {
  if (tools.length === 0) return '(none)'
  return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n')
}
