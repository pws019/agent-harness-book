import { assertExplicitAdditionalProperties, validateArgs } from './schema-validate.js'
import {
  ToolAbortedError,
  ToolArgsError,
  ToolNotFoundError,
  ToolOutputError,
  ToolTimeoutError,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
  type ToolSchema,
} from './types.js'

/**
 * 深模块的落地：模型面对的接口只有 name/description/parameters 三样东西，
 * 参数校验、超时、取消全部收在这里统一处理，工具作者的 execute() 只管干活。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  define<Value>(tool: ToolDefinition<Value>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`duplicate tool registration: "${tool.name}"`)
    }
    assertExplicitAdditionalProperties(tool.parameters)
    this.tools.set(tool.name, tool as ToolDefinition)
  }

  /** 面向模型的 schema 列表。execute/output/timeoutMs 等实现细节绝不会出现在这里。 */
  schemas(): readonly ToolSchema[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  async execute(name: string, rawArgs: unknown, exec: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      throw new ToolNotFoundError(`unknown tool: "${name}"`)
    }

    const validation = validateArgs(tool.parameters, rawArgs)
    if (!validation.ok) {
      throw new ToolArgsError(validation.message)
    }

    // Check abort BEFORE invoking execute(): calling an async function runs its body
    // synchronously up to the first `await`, so a not-yet-started tool body must never be
    // reached once cancellation has already happened -- checking only after would let
    // synchronous side effects run under a signal the caller already tried to abort.
    if (exec.signal.aborted) {
      throw new ToolAbortedError('aborted before dispatch')
    }

    const value = await runWithTimeoutAndAbort(() => tool.execute(rawArgs, exec), tool.timeoutMs, exec.signal)

    let content: string
    try {
      content = tool.output.render(rawArgs, value)
    } catch (error) {
      // finalizeContent/render must be total and never throw -- if it does, that's a bug in the
      // tool definition, not a normal execution failure, so we classify it distinctly.
      throw new ToolOutputError(`output.render() threw for tool "${name}": ${String(error)}`)
    }

    return { name, args: rawArgs, value, content }
  }
}

async function runWithTimeoutAndAbort<T>(
  startWork: () => Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise =
    timeoutMs === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ToolTimeoutError(`tool timed out after ${timeoutMs}ms`)), timeoutMs)
        })

  const abortPromise = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(new ToolAbortedError('aborted during execution')), { once: true })
  })

  try {
    const work = startWork()
    const racers = timeoutPromise ? [work, timeoutPromise, abortPromise] : [work, abortPromise]
    return await Promise.race(racers)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
