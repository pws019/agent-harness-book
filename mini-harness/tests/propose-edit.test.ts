import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApprovalAlreadyConsumedError, ApprovalStore } from '../src/core/approval.js'
import { createAutonomousPreset, createReadonlyPreset } from '../src/core/permission-presets.js'
import { contentHash } from '../src/tools/file-io.js'
import { generateEditProposal, proposeEdit } from '../src/propose-edit.js'

const tmpDirs: string[] = []
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'propose-edit-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('generateEditProposal: deterministic find/replace, no LLM involved', () => {
  it('replaces every occurrence and reports a real diff', () => {
    const proposal = generateEditProposal('hello world, hello moon', 'hello', 'hi')
    expect(proposal.newContent).toBe('hi world, hi moon')
    expect(proposal.diff).not.toBe('(no changes)')
  })

  it('a find string that is not present produces "(no changes)"', () => {
    const proposal = generateEditProposal('hello world', 'xyz', 'abc')
    expect(proposal.diff).toBe('(no changes)')
    expect(proposal.newContent).toBe('hello world')
  })

  it('previousContent null (new file) is treated as editing from empty content', () => {
    const proposal = generateEditProposal(null, '', 'seed')
    expect(proposal.previousHash).toBeNull()
  })
})

describe('proposeEdit: end-to-end read -> diff -> approval -> write -> verify', () => {
  it('an approved edit is written to disk and the diff reflects the real change', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'TODO: fix bug\n')

    const outcome = await proposeEdit({
      root,
      filePath: 'notes.txt',
      find: 'TODO',
      replace: 'DONE',
      approvalStore: new ApprovalStore(),
      requestApproval: () => true,
    })

    expect(outcome.kind).toBe('applied')
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('DONE: fix bug\n')
  })

  it('a denied edit (callback returns false) writes nothing and burns no nonce', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'TODO: fix bug\n')
    const store = new ApprovalStore()

    const outcome = await proposeEdit({
      root,
      filePath: 'notes.txt',
      find: 'TODO',
      replace: 'DONE',
      approvalStore: store,
      requestApproval: () => false,
    })

    expect(outcome.kind).toBe('denied')
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('TODO: fix bug\n')
    // 被拒绝的请求从未被消费——它还是"活着"的一条记录，用原参数仍然能成功消费一次，
    // 这正说明"拒绝"和"批准后消费"是两条不同的路径，拒绝不会顺手把 nonce 烧掉。
    if (outcome.kind === 'denied') {
      const originalArgs = { file_path: 'notes.txt', content: 'DONE: fix bug\n', expectedHash: contentHash('TODO: fix bug\n') }
      expect(() => store.consume(outcome.request.nonce, originalArgs)).not.toThrow()
    }
  })

  it('a no-op edit (find text absent) never creates an approval request or calls the callback', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'TODO: fix bug\n')
    const requestApproval = vi.fn(() => true)

    const outcome = await proposeEdit({
      root,
      filePath: 'notes.txt',
      find: 'nonexistent-text',
      replace: 'DONE',
      approvalStore: new ApprovalStore(),
      requestApproval,
    })

    expect(outcome.kind).toBe('no-changes')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('preset "autonomous" auto-approves without ever calling requestApproval', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'TODO: fix bug\n')
    const requestApproval = vi.fn(() => true)

    const outcome = await proposeEdit({
      root,
      filePath: 'notes.txt',
      find: 'TODO',
      replace: 'DONE',
      approvalStore: new ApprovalStore(),
      requestApproval,
      preset: createAutonomousPreset(),
    })

    expect(outcome.kind).toBe('applied')
    expect(requestApproval).not.toHaveBeenCalled()
  })

  it('preset "readonly" denies edit_file without ever calling requestApproval, and writes nothing', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'TODO: fix bug\n')
    const requestApproval = vi.fn(() => true)

    const outcome = await proposeEdit({
      root,
      filePath: 'notes.txt',
      find: 'TODO',
      replace: 'DONE',
      approvalStore: new ApprovalStore(),
      requestApproval,
      preset: createReadonlyPreset(new Set(['read_file', 'list_files', 'search_text'])),
    })

    expect(outcome.kind).toBe('denied')
    expect(requestApproval).not.toHaveBeenCalled()
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('TODO: fix bug\n')
  })

  it('verification runs after a successful write and reports a failing exit code without rolling back the edit', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'TODO: fix bug\n')

    const outcome = await proposeEdit({
      root,
      filePath: 'notes.txt',
      find: 'TODO',
      replace: 'DONE',
      approvalStore: new ApprovalStore(),
      requestApproval: () => true,
      verify: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
    })

    expect(outcome.kind).toBe('applied')
    // 验证命令失败了，但文件已经写完——这个参考实现不做"验证失败就回滚"，是一个记录在
    // study.md 里的已知取舍，不是 bug。
    if (outcome.kind === 'applied') {
      expect(outcome.verification?.passed).toBe(false)
    }
    expect(readFileSync(join(root, 'notes.txt'), 'utf8')).toBe('DONE: fix bug\n')
  })

  it('verification runs after a successful write and reports success', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'TODO: fix bug\n')

    const outcome = await proposeEdit({
      root,
      filePath: 'notes.txt',
      find: 'TODO',
      replace: 'DONE',
      approvalStore: new ApprovalStore(),
      requestApproval: () => true,
      verify: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    })

    expect(outcome.kind).toBe('applied')
    if (outcome.kind === 'applied') expect(outcome.verification?.passed).toBe(true)
  })

  it('honest gap: if the file changes after approval is consumed but before edit_file writes, the nonce is already burned and cannot be retried', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'notes.txt'), 'TODO: fix bug\n')
    const store = new ApprovalStore()

    // 用一个会在"批准"那一刻抢先改写文件的回调，模拟"审批和落盘之间文件被改写"的竞态。
    const requestApproval = () => {
      writeFileSync(join(root, 'notes.txt'), 'TODO: something else entirely\n')
      return true
    }

    await expect(
      proposeEdit({
        root,
        filePath: 'notes.txt',
        find: 'TODO',
        replace: 'DONE',
        approvalStore: store,
        requestApproval,
      }),
    ).rejects.toThrow(/has changed since you last read it/)

    // nonce 已经被消费掉了（在 edit_file 真正执行、真正失败之前）——这是已知且记录在案的缺口：
    // 一次因为竞态而失败的编辑,不能靠重新调用同一个 nonce 重试,只能重新走一遍完整的
    // proposeEdit()（重新读取最新内容、重新生成一次新的审批请求）。
    // 这个测试里唯一的一次 create() 产生的 nonce 是 "approval-0"（ApprovalStore 的实现细节，
    // 见 src/core/approval.ts 的 nextId 计数器），用原参数重新消费应该失败在"已消费"，
    // 而不是别的错误——证明失败发生在 edit_file 之前,不是之后。
    const originalArgs = { file_path: 'notes.txt', content: 'DONE: fix bug\n', expectedHash: contentHash('TODO: fix bug\n') }
    expect(() => store.consume('approval-0', originalArgs)).toThrow(ApprovalAlreadyConsumedError)
  })
})
