import { createInterface } from 'node:readline/promises'
import type { Message } from '../llm/types.js'
import { Conversation } from './conversation.js'
import { createHttpStreamConnector } from './http-stream-connector.js'
import { runReconnectingStream, StreamGaveUpError } from './reconnecting-stream.js'

export interface TerminalClientOptions {
  readonly baseUrl: string
  readonly sessionId: string
  readonly bearerToken?: string
  /** 每次 `Conversation.messages` 变化时调用——真实终端场景下打印到 stdout，
   * 测试可以注入一个把每次变化都记下来的回调，不用真的解析 stdout 文本。 */
  readonly onUpdate: (messages: readonly Message[]) => void
}

/**
 * "简易终端 client model"——`study.md` 提到的两种实现里选的是这一种，不是浏览器页面
 * （没有浏览器测试基础设施，见 study.md §1）。真正的职责很薄：起一个 `Conversation`
 * （Day23 核心）+ `runReconnectingStream()`（断线自动重连）+ `HttpStreamConnector`
 * （打 Day22 的真实服务器），每次收到新内容就回调给调用方。发消息走一次性的
 * `POST /sessions/:id/messages`，不需要走这条流式连接。
 *
 * 这里故意不接进 `cli.ts` 的子命令分发——跟 Day17 `start_job`/Day19 `ApprovalStore`
 * 同一个纪律：新能力先在核心层独立验证完，接不接真实调用方是另一个决定，见
 * Day27 里程碑。
 */
export async function connectTerminalClient(options: TerminalClientOptions, signal: AbortSignal): Promise<void> {
  const conversation = new Conversation()
  const connector = createHttpStreamConnector(options.baseUrl, options.sessionId, options.bearerToken)

  let lastMessageCount = 0
  const notifyIfChanged = (): void => {
    const messages = conversation.messages
    if (messages.length !== lastMessageCount) {
      lastMessageCount = messages.length
      options.onUpdate(messages)
    }
  }

  try {
    await runReconnectingStream({ connector, conversation, retryDelayMs: 200, onEnvelope: notifyIfChanged }, signal)
  } catch (error) {
    if (!(error instanceof StreamGaveUpError)) throw error
    console.error(error.message)
  }
}

/** 真正跑起来的入口——建一个 session、连上流、在终端里让你敲消息、实时打印回复。
 * 不是自动化测试会调用的东西，是给人手动跑的（见 modules/day23 那天的 README.md）。 */
export async function runTerminalClientCli(baseUrl: string, sessionId: string, bearerToken?: string): Promise<void> {
  const controller = new AbortController()
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  const clientPromise = connectTerminalClient(
    {
      baseUrl,
      sessionId,
      bearerToken,
      onUpdate: (messages) => {
        const last = messages.at(-1)
        if (!last) return
        const text = last.blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ')
        console.log(`${last.role}: ${text}`)
      },
    },
    controller.signal,
  )

  try {
    while (!controller.signal.aborted) {
      const line = await rl.question('> ')
      if (line.trim() === '/quit') break
      await fetch(`${baseUrl}/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
        },
        body: JSON.stringify({ text: line }),
      })
    }
  } finally {
    controller.abort()
    rl.close()
    await clientPromise.catch(() => {})
  }
}
