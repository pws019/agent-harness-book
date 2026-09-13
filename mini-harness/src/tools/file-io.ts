import { createHash } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { ToolExecutionError } from './types.js'

/** 采样这么多字节找二进制特征，跟 git 判断一个文件是不是文本用的经验阈值一样。 */
const BINARY_SNIFF_BYTES = 8_000

export function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * 极简二进制探测：采样开头一段字节，出现 NUL 字节就判定为二进制。不是完美的判定法
 * （UTF-16 文本、极小的合法二进制文件都可能误判），但足够挡住"把图片/可执行文件
 * 当文本读出乱码，或者当文本写进去改坏"这类明显错误。
 */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(BINARY_SNIFF_BYTES, buffer.length))
  return sample.includes(0)
}

/**
 * 原子写：先写到同目录下的临时文件，再 rename 到目标路径。rename 在同一个文件系统内
 * 是原子操作——中途进程被杀，目标文件要么是完整的旧内容，要么是完整的新内容，
 * 不会出现"写了一半"的中间态（呼应 Day14 学过的"仅追加日志"同一个思路，这里换成
 * "整份替换但不留半成品"）。
 */
export function writeFileAtomic(targetPath: string, content: string): void {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmpPath, content, 'utf8')
  renameSync(tmpPath, targetPath)
}

export function ensureNotBinaryOrThrow(buffer: Buffer, label: string): void {
  if (looksBinary(buffer)) {
    throw new ToolExecutionError(`refusing to treat "${label}" as text: looks like a binary file`)
  }
}

/**
 * 朴素行级 diff：只裁掉开头和结尾相同的行，中间剩下的部分整段展示"删除的旧内容"和
 * "新增的新内容"。不是真正的 LCS/Myers diff（不会在中间部分再找共同行），但足够
 * 教学用途预览"这次编辑大概改了哪一段"，且实现和理解成本都很低。
 */
export function simpleDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1
  }

  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1
    newEnd -= 1
  }

  const removed = oldLines.slice(start, oldEnd).map((line) => `-${line}`)
  const added = newLines.slice(start, newEnd).map((line) => `+${line}`)
  if (removed.length === 0 && added.length === 0) return '(no changes)'
  return [...removed, ...added].join('\n')
}
