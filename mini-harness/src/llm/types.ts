/**
 * 内部统一的消息与流式事件模型。
 *
 * 所有 provider 的 wire 协议都必须被适配器（Day3）翻译成这里定义的类型，
 * Agent loop、组装器、测试代码永远只认这一套类型，不认任何具体 SDK 的类型。
 */

export type Role = 'user' | 'assistant' | 'tool'

export interface TextBlock {
  readonly type: 'text'
  readonly text: string
}

export interface ReasoningBlock {
  readonly type: 'reasoning'
  readonly text: string
}

export interface ToolCallBlock {
  readonly type: 'tool-call'
  readonly id: string
  readonly name: string
  /** 原始 JSON 字符串。只有在 block-end 触发之后才保证是完整、可 JSON.parse 的字符串。 */
  readonly arguments: string
}

export interface ToolResultBlock {
  readonly type: 'tool-result'
  readonly toolCallId: string
  readonly content: string
  readonly isError?: boolean
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock

export interface Message {
  readonly role: Role
  readonly blocks: readonly ContentBlock[]
}

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
}

export type LlmFailureCode =
  | 'EMPTY_RESPONSE'
  | 'CONTEXT_WINDOW_EXCEEDED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'UNSUPPORTED_OPTION'
  | 'AUTH_ERROR'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'PROTOCOL_ERROR'

export interface LlmFailure {
  readonly message: string
  readonly code: LlmFailureCode
  readonly status?: number
  /** provider 要求的重试延迟，只是「事实」，是否真的重试由上层重试策略决定（Day3）。 */
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}

export type FinishReason =
  | { readonly kind: 'stop' }
  | { readonly kind: 'tool-calls' }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'aborted'; readonly failure: LlmFailure }
  | { readonly kind: 'error'; readonly failure: LlmFailure }

/**
 * 封闭的可辨识联合类型：所有 provider 的 wire event 都要被适配器翻译成这七种之一。
 * 新增变体必须同时更新 `assertNever` 覆盖到的每一处 switch，否则编译不通过。
 */
export type StreamChunk =
  | {
      readonly type: 'block-start'
      readonly index: number
      readonly blockType: ContentBlock['type']
      readonly id?: string
      readonly name?: string
    }
  | { readonly type: 'text-delta'; readonly index: number; readonly delta: string }
  | { readonly type: 'reasoning-delta'; readonly index: number; readonly delta: string }
  | { readonly type: 'tool-call-delta'; readonly index: number; readonly argumentsDelta: string }
  | { readonly type: 'block-end'; readonly index: number; readonly block: ContentBlock }
  | { readonly type: 'usage'; readonly usage: TokenUsage }
  | { readonly type: 'finish'; readonly reason: FinishReason }

export function assertNever(value: never): never {
  throw new Error(`Unhandled StreamChunk variant: ${JSON.stringify(value)}`)
}
