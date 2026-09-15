import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TextSearchFallbackProvider,
  TsserverProvider,
  withFallback,
  type SemanticQueryProvider,
  type SemanticQueryResult,
} from '../src/core/semantic-query.js'
import { TsserverClient } from '../src/core/tsserver-client.js'

const TSSERVER_TIMEOUT = 20_000

const tmpDirs: string[] = []
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-query-test-'))
  tmpDirs.push(dir)
  return dir
}

const clients: TsserverClient[] = []
afterEach(() => {
  while (clients.length > 0) clients.pop()!.dispose()
})

describe('TsserverProvider: real semantic lookups against this actual repo', () => {
  it(
    'finds the real definition of a symbol it can locate in the file text',
    async () => {
      const client = new TsserverClient()
      clients.push(client)
      const provider = new TsserverProvider(client)
      const file = resolve(process.cwd(), 'src/core/session.ts')

      const result = await provider.findDefinition(process.cwd(), file, 'Session')
      expect(result.kind).toBe('semantic')
      if (result.kind === 'semantic') expect(result.locations.length).toBeGreaterThan(0)
    },
    TSSERVER_TIMEOUT,
  )

  it(
    'a name that does not appear anywhere in the file reports no-results, not an error',
    async () => {
      const client = new TsserverClient()
      clients.push(client)
      const provider = new TsserverProvider(client)
      const file = resolve(process.cwd(), 'src/core/session.ts')

      const result = await provider.findDefinition(process.cwd(), file, 'ThisIdentifierDoesNotExistAnywhere')
      expect(result).toEqual({ kind: 'no-results' })
    },
    TSSERVER_TIMEOUT,
  )
})

describe('TextSearchFallbackProvider: wraps Day15 search_text, does not pretend to be semantic', () => {
  it('finds textual occurrences of a name', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'a.txt'), 'here is FooBar once\nand FooBar again\n')
    const provider = new TextSearchFallbackProvider()

    const result = await provider.findDefinition(root, join(root, 'a.txt'), 'FooBar')
    expect(result.kind).toBe('text-fallback')
    if (result.kind === 'text-fallback') expect(result.matches.length).toBe(2)
  })

  it('reports no-results when the text truly does not appear', async () => {
    const root = makeWorkspace()
    writeFileSync(join(root, 'a.txt'), 'nothing relevant here\n')
    const provider = new TextSearchFallbackProvider()
    const result = await provider.findDefinition(root, join(root, 'a.txt'), 'NeverAppears')
    expect(result).toEqual({ kind: 'no-results' })
  })
})

describe('withFallback: the honest fail-open counter-example to Day18/20 fail-closed', () => {
  it('uses the primary result when it actually finds something', async () => {
    const primary: SemanticQueryProvider = {
      async findDefinition(): Promise<SemanticQueryResult> {
        return { kind: 'semantic', locations: [{ file: 'x.ts', line: 1, offset: 1 }] }
      },
    }
    const fallback: SemanticQueryProvider = {
      async findDefinition(): Promise<SemanticQueryResult> {
        throw new Error('fallback should not be called')
      },
    }
    const combined = withFallback(primary, fallback)
    const result = await combined.findDefinition('/root', '/root/x.ts', 'X')
    expect(result.kind).toBe('semantic')
  })

  it('falls back when the primary throws (e.g. the language service is unavailable)', async () => {
    const primary: SemanticQueryProvider = {
      async findDefinition(): Promise<SemanticQueryResult> {
        throw new Error('tsserver connection lost')
      },
    }
    const fallback: SemanticQueryProvider = {
      async findDefinition(): Promise<SemanticQueryResult> {
        return { kind: 'text-fallback', matches: [{ path: 'x.ts', line: 1, text: 'X' }] }
      },
    }
    const combined = withFallback(primary, fallback)
    const result = await combined.findDefinition('/root', '/root/x.ts', 'X')
    expect(result.kind).toBe('text-fallback')
  })

  it('falls back when the primary finds nothing (kind: no-results), not just when it throws', async () => {
    const primary: SemanticQueryProvider = {
      async findDefinition(): Promise<SemanticQueryResult> {
        return { kind: 'no-results' }
      },
    }
    let fallbackCalled = false
    const fallback: SemanticQueryProvider = {
      async findDefinition(): Promise<SemanticQueryResult> {
        fallbackCalled = true
        return { kind: 'text-fallback', matches: [] }
      },
    }
    const combined = withFallback(primary, fallback)
    await combined.findDefinition('/root', '/root/x.ts', 'X')
    expect(fallbackCalled).toBe(true)
  })

  it(
    'end-to-end: a real TsserverProvider wrapped with a real TextSearchFallbackProvider, primary succeeds',
    async () => {
      const client = new TsserverClient()
      clients.push(client)
      const combined = withFallback(new TsserverProvider(client), new TextSearchFallbackProvider())
      const file = resolve(process.cwd(), 'src/core/session.ts')

      const result = await combined.findDefinition(process.cwd(), file, 'Session')
      expect(result.kind).toBe('semantic') // 真的查到了，不需要降级
    },
    TSSERVER_TIMEOUT,
  )
})
