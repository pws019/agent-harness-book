import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGraduationDemo } from '../src/graduation-demo.js'

/**
 * 全课程毕业演示：把 Day1-29 各自独立建好的每一块，真的串成大纲原文那条完整叙事跑一遍——
 * 建 session → 调查多个来源 → 长上下文触发 compaction → 提出文件修改 → 精确审批 →
 * 沙箱内执行 → 启动后台验证 → 断线重连 → 模拟服务重启并恢复 → 验证目标 → 输出证据、
 * 审计和成本。这条测试本身就是"这条叙事真的能从头跑到尾"的证明，不是挑几个片段
 * 分别测。
 */

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'graduation-demo-'))
  tmpDirs.push(dir)
  return dir
}

describe('runGraduationDemo(): the full end-to-end narrative, using only real pieces', () => {
  it('every stage genuinely happens — no stage is faked or skipped', async () => {
    const workspace = makeWorkspace()
    const report = await runGraduationDemo({ workspace, query: 'GRADUATION_NEEDLE' })

    // 阶段一：调查——证据文本真的来自两个独立文件，不是编出来的
    expect(report.evidence).toContain('GRADUATION_NEEDLE')
    expect(report.evidence).toContain('source-a.md')
    expect(report.evidence).toContain('source-b.md')

    // 阶段二：压缩——5 轮 turn 之后真的触发了（不是"历史还不够长"的 undefined 那条分支）
    expect(report.compactionApplied).toBe(true)

    // 阶段三：提出文件修改 → 审批 → 沙箱内验证
    expect(report.editOutcome.kind).toBe('applied')
    if (report.editOutcome.kind === 'applied') {
      expect(report.editOutcome.verification?.passed).toBe(true)
    }

    // 阶段四：后台验证 job 真的跑完了，审计记录真的有 created + consumed 两条
    expect(report.backgroundJob.exitCode).toBe(0)
    expect(report.backgroundJob.stdout).toContain('background verification passed')
    expect(report.backgroundJobAudit.map((r) => r.kind)).toEqual(['created', 'consumed'])

    // 阶段五：断线重连真的收敛了
    expect(report.reconnectConverged).toBe(true)

    // 阶段六：模拟重启后从磁盘重建出的 Agent，事件数量跟持久化文件完全对得上
    expect(report.restartRecovered).toBe(true)

    // 阶段七：goal 真的通过了一个独立 verify()（检查了真实文件内容），不是模型自称完成
    expect(report.goalClosed).toBe(true)

    // 阶段八：遥测报告是从真实事件日志派生出来的——HeuristicInvestigationAdapter
    // 从不上报 usage，所以 token/成本诚实地是 'unknown'，不是编一个假数字出来
    expect(report.telemetry.totals.inputTokens).toBe('unknown')
    expect(report.telemetry.estimatedCostUsd).toBe('unknown')
    expect(report.telemetry.records.length).toBeGreaterThan(0)
  })

  it('the target file on disk was genuinely modified — not just claimed by the report', async () => {
    const workspace = makeWorkspace()
    await runGraduationDemo({ workspace, query: 'ANOTHER_NEEDLE' })

    const { readFile } = await import('node:fs/promises')
    const notesContent = await readFile(join(workspace, 'notes.md'), 'utf8')
    expect(notesContent).toContain('DONE')
    expect(notesContent).not.toContain('TODO')
  })

  it('the persisted session file on disk is what the "service restart" stage actually reads back', async () => {
    const workspace = makeWorkspace()
    await runGraduationDemo({ workspace, query: 'THIRD_NEEDLE' })

    const { FileRawStore, JsonlSessionStore } = await import('../src/core/persistence.js')
    const { truncated, events } = JsonlSessionStore.open(new FileRawStore(join(workspace, 'session.jsonl'))).load()
    expect(truncated).toBe(false)
    expect(events.length).toBeGreaterThan(0)
    expect(events.some((e) => e.type === 'compaction/start')).toBe(true)
  })
})
