import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TsserverClient } from '../src/core/tsserver-client.js'

// tsserver 冷启动一个真实项目（要读 tsconfig.json、索引全部 .ts 文件）比普通单测慢得多，
// 这里统一给足超时，不跟其它天的"几十毫秒"测试放在同一个期望里。
const TSSERVER_TIMEOUT = 20_000

const clients: TsserverClient[] = []
afterEach(() => {
  while (clients.length > 0) clients.pop()!.dispose()
})

function makeClient(): TsserverClient {
  const client = new TsserverClient()
  clients.push(client)
  return client
}

describe('TsserverClient: a real tsserver process, real protocol, not a mock', () => {
  it(
    'open() + definition() find the real definition of a symbol in this actual repo',
    async () => {
      const client = makeClient()
      const file = resolve(process.cwd(), 'src/core/session.ts')
      await client.open(file)

      // src/core/agent-handle.ts 在第一行左右 import Session —— 用它的引用位置去查定义，
      // 更省事的办法：直接在 session.ts 内部找 "export class Session" 这一行自己查定义
      // （对自身声明查 definition，tsserver 应该原样指回同一个位置）。
      const text = await import('node:fs').then((fs) => fs.readFileSync(file, 'utf8'))
      const lines = text.split('\n')
      const lineIndex = lines.findIndex((l) => l.includes('export class Session'))
      expect(lineIndex).toBeGreaterThan(-1)
      const offset = lines[lineIndex]!.indexOf('Session') + 1

      const defs = await client.definition(file, lineIndex + 1, offset)
      expect(defs.length).toBeGreaterThan(0)
      expect(JSON.stringify(defs)).toContain('session.ts')
    },
    TSSERVER_TIMEOUT,
  )

  it(
    'references() finds more than one usage of a widely-used real symbol',
    async () => {
      const client = makeClient()
      const file = resolve(process.cwd(), 'src/core/agent-handle.ts')
      await client.open(file)

      const text = await import('node:fs').then((fs) => fs.readFileSync(file, 'utf8'))
      const lines = text.split('\n')
      const lineIndex = lines.findIndex((l) => l.includes('export class Agent'))
      expect(lineIndex).toBeGreaterThan(-1)
      const offset = lines[lineIndex]!.indexOf('Agent') + 1

      const refs = await client.references(file, lineIndex + 1, offset)
      // Agent 类在这个真实代码库里被大量测试文件 import——真实引用数远不止 1。
      expect(refs.length).toBeGreaterThan(1)
    },
    TSSERVER_TIMEOUT,
  )

  it(
    'querying a position that is not a symbol returns an empty result, not an error',
    async () => {
      const client = makeClient()
      const file = resolve(process.cwd(), 'src/core/session.ts')
      await client.open(file)
      const defs = await client.definition(file, 1, 1) // 文件第一个字符，大概率是空白/注释
      expect(defs).toEqual([])
    },
    TSSERVER_TIMEOUT,
  )

  it(
    'dispose() actually terminates the underlying OS process',
    async () => {
      const client = new TsserverClient()
      const file = resolve(process.cwd(), 'src/core/session.ts')
      await client.open(file)
      const pid = (client as unknown as { child: { pid?: number } }).child.pid
      expect(pid).toBeDefined()

      client.dispose()
      await new Promise((r) => setTimeout(r, 300))

      expect(() => process.kill(pid!, 0)).toThrow() // ESRCH：进程真的不在了
    },
    TSSERVER_TIMEOUT,
  )

  it(
    'a request made after the process has exited rejects instead of hanging forever',
    async () => {
      const client = new TsserverClient()
      const file = resolve(process.cwd(), 'src/core/session.ts')
      await client.open(file)
      client.dispose()
      await new Promise((r) => setTimeout(r, 300))
      await expect(client.definition(file, 1, 1)).rejects.toThrow()
    },
    TSSERVER_TIMEOUT,
  )
})
