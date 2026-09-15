import { readFile } from 'node:fs/promises'
import { TsserverClient } from './tsserver-client.js'
import { createSearchTextTool } from '../tools/fs-tools.js'
import type { ToolExecutionContext } from '../tools/types.js'

export interface SymbolLocation {
  readonly file: string
  readonly line: number
  readonly offset: number
}

export interface TextMatch {
  readonly path: string
  readonly line: number
  readonly text: string
}

/**
 * 三选一，不是一个含糊的"结果"字段——调用方（未来某天真正把这个接进一个工具时）
 * 必须能从类型上区分"这是语义查询给出的精确定义位置"还是"降级成了文本搜索给出的
 * 一堆疑似相关的行"，两者的可信度完全不同，不能用同一个数组形状糊弄过去。
 */
export type SemanticQueryResult =
  | { readonly kind: 'semantic'; readonly locations: readonly SymbolLocation[] }
  | { readonly kind: 'text-fallback'; readonly matches: readonly TextMatch[] }
  | { readonly kind: 'no-results' }

export interface SemanticQueryProvider {
  findDefinition(root: string, filePath: string, identifierName: string): Promise<SemanticQueryResult>
}

/** 一行的开头（去掉前导空白）看起来像注释——不是真正的词法分析，只认
 * `//`/`/*`/`*`（JSDoc 块注释每行的续行前缀）这三种最常见的写法，跳不过行内
 * 尾随注释、字符串字面量里出现的同名文本这类情况——诚实的局限，见下面
 * `locateIdentifier` 的文档注释。 */
function looksLikeCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')
}

/** 在文件文本里找 `identifierName` 第一次作为完整单词出现的位置——tsserver 的
 * `definition` 命令要的是"哪一行第几列"，不是"这个标识符叫什么"，这里做一次
 * 简单的字面量定位把两者接起来。**不是真正的语法分析**：跳过明显的整行注释
 * （`looksLikeCommentLine()`）是唯一做的一点"降噪"，跳不过字符串字面量、行内
 * 尾随注释——这个仓库自己的代码风格里，JSDoc 经常提前提到某个类型/函数的名字
 * （比如 `session.ts` 顶部的注释里"Session"这个词出现在真正的 `export class
 * Session` 声明之前），如果不跳过整行注释，很容易定位到一个注释里的文字，
 * 查出来的自然是"这里什么符号都没有"（tsserver 老实报告 no-results，不是
 * bug——这个限制真的在写这个函数的过程中被测试跑出来过一次，不是凭空猜的）。 */
function locateIdentifier(text: string, identifierName: string): { line: number; offset: number } | undefined {
  const pattern = new RegExp(`\\b${identifierName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (looksLikeCommentLine(lines[i]!)) continue
    const match = pattern.exec(lines[i]!)
    if (match) return { line: i + 1, offset: match.index + 1 }
  }
  return undefined
}

/**
 * `TsserverClient` 包一层"给个标识符名字,自动定位、自动查定义"——真正查不到的时候
 * 老实抛错（连接失败/超时/找不到这个标识符），不假装查到了什么。 */
export class TsserverProvider {
  constructor(private readonly client: TsserverClient) {}

  async findDefinition(_root: string, filePath: string, identifierName: string): Promise<SemanticQueryResult> {
    const text = await readFile(filePath, 'utf8')
    const position = locateIdentifier(text, identifierName)
    if (!position) return { kind: 'no-results' }

    await this.client.open(filePath)
    const defs = await this.client.definition(filePath, position.line, position.offset)
    if (defs.length === 0) return { kind: 'no-results' }
    return {
      kind: 'semantic',
      locations: defs as readonly SymbolLocation[],
    }
  }
}

/** 包一层 Day15 `search_text`——查不到语义位置时的退路，只是"文本里提到这个名字
 * 的地方"，不是"这个符号真正的声明位置"。 */
export class TextSearchFallbackProvider implements SemanticQueryProvider {
  async findDefinition(root: string, _filePath: string, identifierName: string): Promise<SemanticQueryResult> {
    const tool = createSearchTextTool(root)
    const exec: ToolExecutionContext = { signal: new AbortController().signal, cwd: '.' }
    const value = (await tool.execute({ query: identifierName }, exec)) as { readonly matches: readonly TextMatch[] }
    if (value.matches.length === 0) return { kind: 'no-results' }
    return { kind: 'text-fallback', matches: value.matches }
  }
}

/**
 * 合法的 fail-open 反例——跟 Day18 `CommandPolicy`/Day20 `FailClosedCommandPolicy`
 * 的 fail-closed 纪律故意唱反调,放在一起讲是为了防止学习者把"出错就拒绝"泛化成
 * "任何时候都该这样"。这里查不到/连不上语义服务,老实退化成一个更弱、但依然有用
 * 的能力（文本搜索），而不是假装"查到了"或者干脆整个操作失败——语义查询失败的
 * 代价是"结果不够精确"，不是"权限被绕过"，跟命令执行/文件写入这类操作的失败代价
 * 完全不是一回事，这正是两条纪律选择不同方向的原因。
 */
export function withFallback(primary: SemanticQueryProvider, fallback: SemanticQueryProvider): SemanticQueryProvider {
  return {
    async findDefinition(root, filePath, identifierName) {
      try {
        const result = await primary.findDefinition(root, filePath, identifierName)
        if (result.kind !== 'no-results') return result
      } catch {
        // 语义服务本身连不上/超时——降级，不向上抛错。
      }
      return fallback.findDefinition(root, filePath, identifierName)
    },
  }
}

