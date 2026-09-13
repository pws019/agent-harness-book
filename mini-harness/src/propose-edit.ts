import { readFile } from 'node:fs/promises'
import { ApprovalStore, type ApprovalRequest } from './core/approval.js'
import type { PermissionDecision, PermissionPreset } from './core/permission-presets.js'
import type { CommandPolicy } from './tools/command-policy.js'
import { contentHash, ensureNotBinaryOrThrow, simpleDiff } from './tools/file-io.js'
import { createRunCommandTool } from './tools/bash-tool.js'
import { createEditFileTool } from './tools/fs-tools.js'
import { ToolRegistry } from './tools/registry.js'
import type { ToolExecutionContext } from './tools/types.js'
import { resolveWithinRoot } from './tools/workspace.js'

const APPROVAL_TTL_MS = 5 * 60_000

export interface EditProposal {
  readonly previousContent: string | null
  readonly previousHash: string | null
  readonly newContent: string
  readonly diff: string
}

/**
 * 确定性、非 LLM 的"新内容生成"——字面量查找替换。跟 Day7 `HeuristicInvestigationAdapter`
 * 一样，用一条写死的规则代替真实模型来决定下一步产出什么，方便在没有真实 provider 的情况下
 * 演示"生成新内容 -> 展示 diff -> 审批 -> 写入"这条完整链路。接真实模型时，只需要把这个
 * 函数换成"把 previousContent 喂给 LLM、要求它给出改完之后的全文"，下游的审批/写入/验证
 * 逻辑不需要改一行——这正是 Day3 讲的"Agent loop 不认识具体 provider"同一个道理，只是
 * 这次换成了"proposeEdit() 不认识内容是怎么生成的"。
 */
export function generateEditProposal(previousContent: string | null, find: string, replace: string): EditProposal {
  const base = previousContent ?? ''
  const newContent = base.split(find).join(replace)
  return {
    previousContent,
    previousHash: previousContent === null ? null : contentHash(previousContent),
    newContent,
    diff: simpleDiff(base, newContent),
  }
}

export interface VerifyCommand {
  readonly command: string
  readonly args?: readonly string[]
}

export interface VerificationResult {
  readonly exitCode: number | null
  readonly passed: boolean
  readonly output: string
}

/** 调用方（CLI 或测试）决定"批不批"的方式——真实终端场景下是一个读 stdin 的实现，
 * 测试里直接注入一个返回固定布尔值的函数，不需要伪造键盘输入。 */
export type ApprovalCallback = (request: ApprovalRequest, diff: string) => Promise<boolean> | boolean

export interface ProposeEditOptions {
  readonly root: string
  readonly filePath: string
  readonly find: string
  readonly replace: string
  readonly approvalStore: ApprovalStore
  readonly requestApproval: ApprovalCallback
  /** 给了 preset 就先问它——`auto-approve` 跳过 requestApproval()，`deny` 直接拒绝
   * （连 requestApproval() 都不调用），只有 `require-approval` 才真的去问人。
   * 不给 preset 时，行为等价于永远 `require-approval`。 */
  readonly preset?: PermissionPreset
  readonly verify?: VerifyCommand
  readonly commandPolicy?: CommandPolicy
}

export type ProposeEditOutcome =
  | { readonly kind: 'no-changes'; readonly diff: string }
  | { readonly kind: 'denied'; readonly diff: string; readonly request: ApprovalRequest }
  | {
      readonly kind: 'applied'
      readonly diff: string
      readonly newHash: string
      readonly verification?: VerificationResult
    }

function editToolArgs(filePath: string, proposal: EditProposal): unknown {
  return {
    file_path: filePath,
    content: proposal.newContent,
    ...(proposal.previousHash !== null ? { expectedHash: proposal.previousHash } : {}),
  }
}

/**
 * 里程碑三的端到端链路：读文件 -> 生成新内容 -> 展示 diff -> 审批 -> 批准才写盘 ->
 * 跑验证命令。串起 Day15 `edit_file`、Day16 `run_command`（复用 Day18 `CommandPolicy`）、
 * Day19 `ApprovalStore`/`PermissionPreset`——这几天各自独立验证过的机制，第一次被真正
 * 接进一条可以从 CLI 跑起来的调用链。
 *
 * 已知的、故意不解决的缺口（跟 Day18 威胁模型"诚实记录缺口"是同一个纪律）：`approvalStore
 * .consume()` 发生在真正调用 `edit_file` 之前——如果这之间文件被别的进程改写，`edit_file`
 * 会因为 `expectedHash` 不匹配而失败，但这次批准已经被消费掉了，不能重试同一个 nonce。
 * 要修复需要把"消费 nonce"和"落盘成功"做成一个原子操作，今天没有做（见 exercise.md）。
 */
export async function proposeEdit(options: ProposeEditOptions): Promise<ProposeEditOutcome> {
  const { root, filePath, find, replace, approvalStore, requestApproval, preset, verify, commandPolicy } = options

  const target = resolveWithinRoot(root, filePath)
  let previousContent: string | null = null
  try {
    const buffer = await readFile(target)
    ensureNotBinaryOrThrow(buffer, filePath)
    previousContent = buffer.toString('utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const proposal = generateEditProposal(previousContent, find, replace)
  if (proposal.diff === '(no changes)') {
    // 没有实际改动——不生成审批请求，没有什么值得审计的具体动作。
    return { kind: 'no-changes', diff: proposal.diff }
  }

  const args = editToolArgs(filePath, proposal)
  const request = approvalStore.create('edit_file', filePath, proposal.diff.slice(0, 200), args, APPROVAL_TTL_MS)

  const decision: PermissionDecision = preset ? preset.decide('edit_file') : 'require-approval'
  let approved: boolean
  if (decision === 'auto-approve') {
    approved = true
  } else if (decision === 'deny') {
    approved = false
  } else {
    approved = await requestApproval(request, proposal.diff)
  }

  if (!approved) {
    return { kind: 'denied', diff: proposal.diff, request }
  }

  approvalStore.consume(request.nonce, args)

  const tools = new ToolRegistry()
  tools.define(createEditFileTool(root))
  if (verify) tools.define(createRunCommandTool(root, commandPolicy))
  const exec: ToolExecutionContext = { signal: new AbortController().signal, cwd: '.' }

  const editResult = await tools.execute('edit_file', args, exec)
  const editValue = editResult.value as { readonly newHash: string | null }

  let verification: VerificationResult | undefined
  if (verify) {
    const verifyResult = await tools.execute('run_command', { command: verify.command, args: verify.args ?? [] }, exec)
    const verifyValue = verifyResult.value as { readonly exitCode: number | null }
    verification = { exitCode: verifyValue.exitCode, passed: verifyValue.exitCode === 0, output: verifyResult.content }
  }

  return { kind: 'applied', diff: proposal.diff, newHash: editValue.newHash ?? '', verification }
}
