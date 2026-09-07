import { isAbsolute, relative, resolve } from 'node:path'

/**
 * 越界路径检测（字符串层面，不做 symlink 解析——symlink 逃逸是 Day15 文件系统能力
 * 那一天要专门处理的问题，今天先建立"不能靠 ../ 逃出工作区"这条底线）。
 */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathEscapeError'
  }
}

export function resolveWithinRoot(root: string, requestedPath: string): string {
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, requestedPath)
  const rel = relative(resolvedRoot, target)
  const escapes = rel === '..' || rel.startsWith(`..${'/'}`) || isAbsolute(rel)
  if (escapes) {
    throw new PathEscapeError(`path escapes workspace root: "${requestedPath}"`)
  }
  return target
}
