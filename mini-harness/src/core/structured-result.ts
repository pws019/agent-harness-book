import { isJsonValue } from './session.js'

/** 一个子 Agent 跑完之后,能合法跨越父子边界的唯一东西——`data` 必须先过 Day8
 * `isJsonValue()` 校验。父 Agent 绝不会拿到子 Agent 内部那份可变的 `Message[]`
 * 历史,只会拿到这个经过校验的、无损 JSON 形状的结果。 */
export interface StructuredResult {
  readonly ok: boolean
  readonly data: unknown
}

export class InvalidStructuredResultError extends Error {
  constructor(reason: string) {
    super(`child result failed structured-result validation: ${reason}`)
    this.name = 'InvalidStructuredResultError'
  }
}

/**
 * 唯一合法的构造方式——不直接 `{ok, data}` 字面量拼一个出来,逼着调用方过这一道
 * 校验。复用 Day8 `isJsonValue()`,不是新发明一套校验逻辑：`Session.append()`
 * 本来就靠它保证"日志里只能有无损 JSON",这里是同一个不变式在"父子结果传递"
 * 这个新场景下的复用——子 Agent 可能想返回的东西里混进 `undefined`/函数/循环
 * 引用这类没法安全序列化的值,`createStructuredResult()` 在这里就直接拒绝,
 * 不会一路带着一个"看起来像 JSON 但其实不是"的值传到父 Agent 手里才炸。
 */
export function createStructuredResult(ok: boolean, data: unknown): StructuredResult {
  if (!isJsonValue(data)) throw new InvalidStructuredResultError('data is not a lossless JSON value')
  return { ok, data }
}
