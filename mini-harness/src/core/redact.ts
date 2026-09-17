export type Redactor = (text: string) => string

const PLACEHOLDER = '[REDACTED]'

/**
 * 给定一组已知的敏感值，返回一个把它们在任意文本里原样替换成占位符的函数——
 * 不是靠正则猜"这看起来像不像密钥"，是精确匹配调用方明确告诉过的具体值。
 * 空字符串会被过滤掉：`''.split('').join(x)` 会在文本每个字符之间插一份占位符，
 * 那不是"脱敏"，是把文本破坏成乱码。
 */
export function createRedactor(secretValues: readonly string[]): Redactor {
  const values = [...new Set(secretValues.filter((value) => value.length > 0))]
  if (values.length === 0) return (text) => text
  return (text) => values.reduce((acc, secret) => acc.split(secret).join(PLACEHOLDER), text)
}
