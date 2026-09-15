import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AllowlistCommandPolicy, FailClosedCommandPolicy } from '../src/tools/command-policy.js'
import { createWebFetchTool } from '../src/tools/web-fetch-tool.js'
import type { ToolExecutionContext } from '../src/tools/types.js'

function ctx(): ToolExecutionContext {
  return { signal: new AbortController().signal, cwd: '.' }
}

let server: Server | undefined
let baseUrl = ''
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
  }
})

async function startFixtureServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<string> {
  server = createServer(handler)
  await new Promise<void>((resolve) => server!.listen(0, resolve))
  const port = (server!.address() as AddressInfo).port
  baseUrl = `http://127.0.0.1:${port}`
  return baseUrl
}

describe('createWebFetchTool: real sockets against a local fixture server, not the real internet', () => {
  it('a successful fetch returns the body tagged as untrusted external content', async () => {
    const url = await startFixtureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('hello from fixture server')
    })
    const tool = createWebFetchTool()
    const result = await tool.execute({ url }, ctx())
    expect(result).toMatchObject({ kind: 'ok', body: 'hello from fixture server', provenance: 'untrusted-external' })
  })

  it('a 404 response is reported as an http-error with the real status code', async () => {
    const url = await startFixtureServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    const tool = createWebFetchTool()
    const result = await tool.execute({ url }, ctx())
    expect(result).toEqual({ kind: 'http-error', status: 404 })
  })

  it('connecting to a port nothing is listening on reports network-error, not a hang', async () => {
    const tool = createWebFetchTool({ timeoutMs: 2_000 })
    const result = await tool.execute({ url: 'http://127.0.0.1:1' }, ctx())
    expect(result.kind).toBe('network-error')
  })

  it('a server that never responds is reported as timeout within the configured budget', async () => {
    const url = await startFixtureServer(() => {
      // 故意什么都不做——连接建立了,但永远不 writeHead/end()。
    })
    const tool = createWebFetchTool({ timeoutMs: 300 })
    const start = Date.now()
    const result = await tool.execute({ url }, ctx())
    expect(result).toEqual({ kind: 'timeout' })
    expect(Date.now() - start).toBeLessThan(2_000)
  })

  it('a body larger than maxBodyBytes is truncated and flagged', async () => {
    const url = await startFixtureServer((_req, res) => {
      res.writeHead(200)
      res.end('x'.repeat(1_000))
    })
    const tool = createWebFetchTool({ maxBodyBytes: 100 })
    const result = await tool.execute({ url }, ctx())
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.body.length).toBe(100)
      expect(result.truncated).toBe(true)
    }
  })

  it('rejects an invalid URL before ever attempting a connection', async () => {
    const tool = createWebFetchTool()
    await expect(tool.execute({ url: 'not a url' }, ctx())).rejects.toThrow()
  })
})

describe('createWebFetchTool: reuses Day18 CommandPolicy for host allowlisting, not a parallel policy', () => {
  it('a host not in the allowlist is denied without ever attempting a connection', async () => {
    const url = await startFixtureServer((_req, res) => res.end('should never be reached'))
    const policy = new AllowlistCommandPolicy(['some-other-host'])
    const tool = createWebFetchTool({ policy })
    const result = await tool.execute({ url }, ctx())
    expect(result.kind).toBe('denied')
  })

  it('an allowed host (matched by hostname) is fetched normally', async () => {
    const url = await startFixtureServer((_req, res) => res.end('ok'))
    const policy = new AllowlistCommandPolicy(['127.0.0.1'])
    const tool = createWebFetchTool({ policy })
    const result = await tool.execute({ url }, ctx())
    expect(result.kind).toBe('ok')
  })

  it('a policy that throws while evaluating denies fail-closed, same as run_command', async () => {
    const url = await startFixtureServer((_req, res) => res.end('should never be reached'))
    const brokenPolicy = { isAllowed: () => { throw new Error('policy bug') } }
    const tool = createWebFetchTool({ policy: new FailClosedCommandPolicy(brokenPolicy) })
    const result = await tool.execute({ url }, ctx())
    expect(result.kind).toBe('denied')
  })
})
