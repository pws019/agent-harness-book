import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * 越界路径检测。Day15 之前只做字符串层面的 `../` 检测；Day15 补上 symlink 逃逸——
 * 字符串层面看起来老老实实待在 workspace 里的路径，如果中间某一段是指向外面的符号链接，
 * 磁盘上真正打开的文件其实在 workspace 外面。
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

  // 第一道关卡：纯字符串层面。resolve() 已经把 `../` 这类段折叠掉了，这里只是判断
  // 折叠后的结果还在不在 root 底下，不碰文件系统，成本最低，挡掉最常见的攻击。
  assertWithin(resolvedRoot, target, requestedPath, 'path escapes workspace root')

  // 第二道关卡：真实路径。target 本身（或者它还存在的那部分祖先目录）可能经过一个
  // symlink 才落到磁盘上的某个位置——realpath 就是"顺着 symlink 走到底"之后的真实位置。
  const realRoot = safeRealpath(resolvedRoot)
  const realTarget = safeRealpath(target)
  assertWithin(realRoot, realTarget, requestedPath, 'path escapes workspace root via a symlink')

  return target
}

function assertWithin(root: string, target: string, requestedPath: string, message: string): void {
  const rel = relative(root, target)
  const escapes = rel === '..' || rel.startsWith(`..${'/'}`) || isAbsolute(rel)
  if (escapes) {
    throw new PathEscapeError(`${message}: "${requestedPath}"`)
  }
}

/**
 * 顺着路径往上找到第一个真实存在的祖先目录，对它调用 `realpathSync`（解开所有 symlink），
 * 再把还不存在的那一段路径原样拼回去。这样即使目标文件本身还不存在（比如 `edit_file`
 * 要新建一个文件），也能算出"这条路径最终会落在磁盘上的哪个真实目录里"。
 */
function safeRealpath(absolutePath: string): string {
  if (existsSync(absolutePath)) {
    return realpathSync(absolutePath)
  }
  const parent = dirname(absolutePath)
  if (parent === absolutePath) {
    // 一路往上到了文件系统根目录还是不存在——说明 root 自己就有问题，原样返回，
    // 交给调用方后续的 assertWithin 去判定（大概率会因为奇怪的相对路径而拒绝）。
    return absolutePath
  }
  return join(safeRealpath(parent), basename(absolutePath))
}
