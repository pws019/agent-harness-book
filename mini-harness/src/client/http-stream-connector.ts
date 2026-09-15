import { decodeEnvelopeLine, type StreamEnvelope } from '../server/wire-protocol.js'
import type { StreamConnector } from './reconnecting-stream.js'

/**
 * `StreamConnector` 打真实网络的实现——对 Day22 `GET /sessions/:id/events` 发一个
 * 真实 `fetch()`，把响应 body（换行分隔 JSON,`res.body` 是一个 `ReadableStream<Uint8Array>`）
 * 按字节读、按行切、逐行 `decodeEnvelopeLine()`。这是 `wire-protocol.ts` 里"选换行分隔
 * JSON 不选 SSE"这个决定在客户端这一侧真正兑现的地方——不需要认识 SSE 的
 * `data: `/空行 framing 语法，一个通用的按行切分逻辑就够。
 */
export function createHttpStreamConnector(baseUrl: string, sessionId: string, bearerToken?: string): StreamConnector {
  return {
    async *connect(since, signal): AsyncIterable<StreamEnvelope> {
      const url = new URL(`${baseUrl}/sessions/${sessionId}/events`)
      if (since !== undefined) url.searchParams.set('since', String(since))

      const headers: Record<string, string> = {}
      if (bearerToken) headers.authorization = `Bearer ${bearerToken}`

      const res = await fetch(url, { signal, headers })
      if (!res.ok || !res.body) {
        throw new Error(`GET ${url} failed: ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newlineIndex = buffer.indexOf('\n')
          while (newlineIndex >= 0) {
            const line = buffer.slice(0, newlineIndex)
            buffer = buffer.slice(newlineIndex + 1)
            if (line.trim().length > 0) yield decodeEnvelopeLine(line)
            newlineIndex = buffer.indexOf('\n')
          }
        }
      } finally {
        reader.releaseLock()
      }
    },
  }
}
