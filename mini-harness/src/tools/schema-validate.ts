import type { JsonSchema } from './types.js'

export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly message: string }

/** 校验一个值是否匹配我们这套极简 JSON Schema 子集。返回第一个碰到的错误。 */
export function validateArgs(schema: JsonSchema, value: unknown): ValidationResult {
  const message = validate(schema, value, '$')
  return message === undefined ? { ok: true } : { ok: false, message }
}

function validate(schema: JsonSchema, value: unknown, path: string): string | undefined {
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${path}: expected object, got ${describeType(value)}`
      }
      const obj = value as Record<string, unknown>
      const properties = schema.properties ?? {}
      for (const key of schema.required ?? []) {
        if (!(key in obj)) return `${path}.${key}: missing required property`
      }
      for (const key of Object.keys(obj)) {
        const propSchema = properties[key]
        if (!propSchema) {
          if (schema.additionalProperties === false) {
            return `${path}.${key}: unexpected additional property (this tool does not accept it)`
          }
          continue
        }
        const error = validate(propSchema, obj[key], `${path}.${key}`)
        if (error) return error
      }
      return undefined
    }
    case 'string': {
      if (typeof value !== 'string') return `${path}: expected string, got ${describeType(value)}`
      if (schema.enum && !schema.enum.includes(value)) {
        return `${path}: must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`
      }
      return undefined
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || Number.isNaN(value)) return `${path}: expected number, got ${describeType(value)}`
      if (schema.type === 'integer' && !Number.isInteger(value)) return `${path}: expected integer, got ${value}`
      return undefined
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return `${path}: expected boolean, got ${describeType(value)}`
      return undefined
    }
    case 'array': {
      if (!Array.isArray(value)) return `${path}: expected array, got ${describeType(value)}`
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const error = validate(schema.items, value[i], `${path}[${i}]`)
          if (error) return error
        }
      }
      return undefined
    }
    default:
      return undefined
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/**
 * 定义期检查：每个 object 节点必须显式声明 additionalProperties: true|false。
 * 这是"未知参数怎么处理"这个问题的答案——强制工具作者在写 schema 的那一刻就表态，
 * 而不是留到调用期才发现某个字段该不该被接受。
 */
export function assertExplicitAdditionalProperties(schema: JsonSchema, path = '$'): void {
  if (schema.type === 'object') {
    if (schema.additionalProperties !== true && schema.additionalProperties !== false) {
      throw new Error(
        `tool schema error at ${path}: object nodes must explicitly declare additionalProperties: true | false`,
      )
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      assertExplicitAdditionalProperties(sub, `${path}.${key}`)
    }
  } else if (schema.type === 'array' && schema.items) {
    assertExplicitAdditionalProperties(schema.items, `${path}[]`)
  }
}
