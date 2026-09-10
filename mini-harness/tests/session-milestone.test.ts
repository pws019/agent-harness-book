import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseArgs, runInvestigation } from '../src/cli.js'
import { FileRawStore, JsonlSessionStore } from '../src/core/persistence.js'
import { projectSummary } from '../src/core/session-projection.js'

/**
 * Day14 里程碑：把 Day7 的 CLI 接上 Day8-13 的整套持久化机制，验证"跑一个多 step 的
 * 真实调查 -> 模拟进程在中途被杀 -> 用同一个 session 文件重新跑一次"这整条链路真的
 * 收敛，而不是只在内存里的 Session 单元测试里成立。
 */

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, 'fixtures', 'workspace')

describe('milestone: a real investigation persists to a real file and survives a simulated crash', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('a completed investigation writes a clean, fully-derivable session file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mini-harness-milestone-'))
    const sessionFile = join(dir, 'session.jsonl')
    const args = parseArgs(['--workspace', workspaceRoot, '--query', 'TARGET_NEEDLE', '--session-file', sessionFile])

    const outcome = await runInvestigation(args)
    expect(outcome.record.stopReason).toEqual({ kind: 'completed' })

    const { events, truncated } = JsonlSessionStore.open(new FileRawStore(sessionFile)).load()
    expect(truncated).toBe(false)
    const summary = projectSummary(events)
    expect(summary.turnCount).toBe(1)
    expect(summary.lastStopReason).toEqual({ kind: 'completed' })
    expect(summary.toolCallCountByName).toEqual({ list_files: 1, search_text: 1 })
  })

  it('a session file interrupted mid-write is detected, honestly closed, and a fresh investigation continues in the same file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mini-harness-milestone-'))
    const sessionFile = join(dir, 'session.jsonl')
    const args = parseArgs(['--workspace', workspaceRoot, '--query', 'TARGET_NEEDLE', '--session-file', sessionFile])

    // 第一次调查正常跑完，产出一份完整的 session 文件。
    await runInvestigation(args)
    const fullContent = readFileSync(sessionFile, 'utf8')

    // 模拟"进程在这份完整日志写到一半时被杀"：截掉最后 3 行（大致相当于砍掉最后一个
    // step 和 turn/end），只留下前面已经完整落盘的部分，再拼一段不完整的半行 JSON。
    const lines = fullContent.split('\n').filter((l) => l.length > 0)
    const truncatedContent = `${lines.slice(0, lines.length - 3).join('\n')}\n{"kind":"event","event":{"type":"step/start"`
    writeFileSync(sessionFile, truncatedContent)

    // 加载出来应该能识别出"这是从中断恢复的"。
    const beforeResume = JsonlSessionStore.open(new FileRawStore(sessionFile)).load()
    expect(beforeResume.truncated).toBe(true)

    // 用同一个 session 文件重新跑一次调查——这不是"续上被打断的那次模型对话"（我们的
    // 设计里，被打断的 turn 会被诚实地收尾成 cancelled，不会假装能接着推理下去），而是
    // "同一份会话历史里,追加一次全新的、成功的调查"。
    const outcome = await runInvestigation(args)
    expect(outcome.record.stopReason).toEqual({ kind: 'completed' })

    const { events, truncated } = JsonlSessionStore.open(new FileRawStore(sessionFile)).load()
    expect(truncated).toBe(false) // 这次是正常收尾的，不再是从中断恢复的状态
    const summary = projectSummary(events)
    expect(summary.turnCount).toBe(2) // 第一个 turn（恢复时被判定 cancelled）+ 这次新的 turn
    expect(summary.lastStopReason).toEqual({ kind: 'completed' })

    const turnEndReasons = events.filter((e) => e.type === 'turn/end').map((e) => (e as { reason: unknown }).reason)
    expect(turnEndReasons).toEqual([{ kind: 'cancelled' }, { kind: 'completed' }])
  })
})
