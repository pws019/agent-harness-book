/**
 * 一个极简的 JSON Schema 子集，够描述我们三个只读工具的参数就行。
 * 关键约束（对应 study.md）：所有 object 节点必须显式声明 additionalProperties，
 * ToolRegistry.define() 会在定义期就强制检查这一点，而不是留到调用期才发现。
 */
export interface JsonSchema {
  readonly type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array'
  readonly description?: string
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
  readonly items?: JsonSchema
  readonly enum?: readonly (string | number)[]
}

/** 模型能看到的全部内容，就这三个字段。绝不能出现 execute/output 等实现细节。 */
export interface ToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal
  readonly cwd: string
}

export interface ToolOutputSpec<Value> {
  /** 工具承诺产出的规范数据形状，供程序化调用方（Day 25 的 run_code 之类）直接消费。 */
  readonly schema: JsonSchema
  /** 纯函数：把规范值翻译成模型/人类能看的文本。绝不能抛异常、绝不能有副作用。 */
  readonly render: (args: unknown, value: Value) => string
}

export interface ToolDefinition<Value = unknown> extends ToolSchema {
  readonly output: ToolOutputSpec<Value>
  /** 毫秒。未设置表示不强制超时（不建议，仅用于测试）。 */
  readonly timeoutMs?: number
  /** 纯同步分类器：只有显式返回 true，这个调用才允许跟兄弟调用并发执行。默认视为不安全（独占）。 */
  readonly isConcurrencySafe?: (args: unknown) => boolean
  execute(args: unknown, exec: ToolExecutionContext): Promise<Value>
}

export interface ToolResult {
  readonly name: string
  readonly args: unknown
  readonly value: unknown
  /** output.render() 的结果：模型实际看到的文本。 */
  readonly content: string
}

export type ToolErrorCode = 'INVALID_ARGS' | 'INVALID_TOOL_OUTPUT' | 'UNKNOWN_TOOL' | 'TIMEOUT' | 'ABORTED' | 'EXECUTION_FAILED'

export class ToolError extends Error {
  readonly code: ToolErrorCode
  constructor(code: ToolErrorCode, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

export class ToolArgsError extends ToolError {
  constructor(message: string) {
    super('INVALID_ARGS', message)
    this.name = 'ToolArgsError'
  }
}

export class ToolOutputError extends ToolError {
  constructor(message: string) {
    super('INVALID_TOOL_OUTPUT', message)
    this.name = 'ToolOutputError'
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(message: string) {
    super('UNKNOWN_TOOL', message)
    this.name = 'ToolNotFoundError'
  }
}

export class ToolTimeoutError extends ToolError {
  constructor(message: string) {
    super('TIMEOUT', message)
    this.name = 'ToolTimeoutError'
  }
}

export class ToolAbortedError extends ToolError {
  constructor(message: string) {
    super('ABORTED', message)
    this.name = 'ToolAbortedError'
  }
}

export class ToolExecutionError extends ToolError {
  constructor(message: string) {
    super('EXECUTION_FAILED', message)
    this.name = 'ToolExecutionError'
  }
}
