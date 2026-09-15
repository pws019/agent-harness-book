import { describe, expect, it } from 'vitest'
import { FixtureSearchIndex, createWebSearchTool } from '../src/tools/web-search-tool.js'
import type { ToolExecutionContext } from '../src/tools/types.js'

function ctx(): ToolExecutionContext {
  return { signal: new AbortController().signal, cwd: '.' }
}

describe('FixtureSearchIndex: deterministic, no real network', () => {
  it('matches on title or snippet, case-insensitively', () => {
    const index = new FixtureSearchIndex([
      { url: 'https://example.com/a', title: 'TypeScript basics', snippet: 'learn the fundamentals' },
      { url: 'https://example.com/b', title: 'unrelated', snippet: 'nothing to see here' },
    ])
    expect(index.search('typescript')).toHaveLength(1)
    expect(index.search('fundamentals')).toHaveLength(1)
    expect(index.search('nope')).toHaveLength(0)
  })
})

describe('createWebSearchTool: results are tagged as untrusted external content', () => {
  it('returns matching results with provenance tagged', async () => {
    const index = new FixtureSearchIndex([{ url: 'https://example.com/a', title: 'Deep modules', snippet: 'Ousterhout' }])
    const tool = createWebSearchTool(index)
    const result = await tool.execute({ query: 'deep' }, ctx())
    expect(result.provenance).toBe('untrusted-external')
    expect(result.results).toHaveLength(1)
  })

  it('the untrusted tag survives into the rendered content a model would actually see', async () => {
    const index = new FixtureSearchIndex([{ url: 'https://example.com/a', title: 'Deep modules', snippet: 'x' }])
    const tool = createWebSearchTool(index)
    const result = await tool.execute({ query: 'deep' }, ctx())
    const rendered = tool.output.render({ query: 'deep' }, result)
    expect(rendered).toContain('[UNTRUSTED]')
  })

  it('a query with no matches returns an empty results array, not an error', async () => {
    const index = new FixtureSearchIndex([])
    const tool = createWebSearchTool(index)
    const result = await tool.execute({ query: 'anything' }, ctx())
    expect(result.results).toEqual([])
  })

  it('rejects a call missing the required query field', async () => {
    const tool = createWebSearchTool(new FixtureSearchIndex([]))
    await expect(tool.execute({}, ctx())).rejects.toThrow()
  })
})
