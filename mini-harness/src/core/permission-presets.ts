export type PermissionDecision = 'auto-approve' | 'require-approval' | 'deny'

export interface PermissionPreset {
  readonly name: string
  decide(toolName: string): PermissionDecision
}

/**
 * 三个 preset 都吃同一份"哪些工具是只读的"显式集合——不靠猜工具名字的规律
 * （比如"以 read_ 开头就当只读"），跟 Day18 `CommandPolicy` 选显式白名单、
 * 不选"猜哪些变量名危险"是同一个理由：显式列出的东西不会有"这次命名不符合
 * 约定就漏判"的风险。
 */
export function createReadonlyPreset(readOnlyTools: ReadonlySet<string>): PermissionPreset {
  return { name: 'readonly', decide: (toolName) => (readOnlyTools.has(toolName) ? 'auto-approve' : 'deny') }
}

export function createBalancedPreset(readOnlyTools: ReadonlySet<string>): PermissionPreset {
  return { name: 'balanced', decide: (toolName) => (readOnlyTools.has(toolName) ? 'auto-approve' : 'require-approval') }
}

export function createAutonomousPreset(): PermissionPreset {
  return { name: 'autonomous', decide: () => 'auto-approve' }
}
