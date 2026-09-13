import { existsSync, statSync } from 'node:fs'
import type { CommandPolicy } from './command-policy.js'
import { runProcess } from './process-runner.js'
import { ToolExecutionError, type ToolDefinition } from './types.js'
import { PathEscapeError, resolveWithinRoot } from './workspace.js'

const DEFAULT_TIMEOUT_MS = 10_000
/** 调用方能请求的最长超时——防止一次工具调用把整个 turn 的预算耗在一个命令上。 */
const MAX_TIMEOUT_MS = 60_000
/** 注册进 ToolRegistry 的 timeoutMs：只是兜底安全网，正常情况下 runProcess() 自己的
 * 内部超时会先杀掉子进程、先 resolve——这个更宽的外层超时理论上永远不会真正触发。
 * 见 study.md 关于"registry 的超时只会让 Promise 落空，不会替你杀掉真正的子进程"那条坑。 */
const REGISTRY_TIMEOUT_MS = MAX_TIMEOUT_MS + 5_000
const DEFAULT_MAX_OUTPUT_BYTES = 200_000

interface RunCommandArgs {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** 显式白名单：只有这里列出的变量会出现在子进程环境里，不会继承宿主进程的 env。 */
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string
  readonly timeoutMs?: number
}

interface RunCommandValue {
  readonly command: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
  readonly timedOut: boolean
  readonly aborted: boolean
}

export function createRunCommandTool(root: string, policy?: CommandPolicy): ToolDefinition<RunCommandValue> {
  return {
    name: 'run_command',
    description:
      'Run a command with an explicit argv array inside the workspace (no shell interpretation — pipes/`;`/`$()` are not special). ' +
      'The environment is empty except PATH, plus anything explicitly passed in `env`; nothing from the host process leaks in by default. ' +
      'Output is bounded and reports truncated:true rather than silently dropping data. Timing out or being cancelled kills the whole process tree, not just the top process.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Executable name or path, e.g. "ls" or "node".' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argv, passed literally — not shell-parsed.' },
        cwd: { type: 'string', description: 'Directory relative to the workspace root. Defaults to the root itself.' },
        env: {
          type: 'object',
          additionalProperties: true,
          description: 'Extra environment variables to allow through, on top of PATH. Nothing else from the host is inherited.',
        },
        stdin: { type: 'string', description: 'Text written to the process’s stdin before closing it.' },
        timeoutMs: { type: 'integer', description: `Max wall-clock time. Defaults to ${DEFAULT_TIMEOUT_MS}ms, capped at ${MAX_TIMEOUT_MS}ms.` },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'command', 'exitCode', 'signal', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated', 'timedOut', 'aborted',
        ],
        properties: {
          command: { type: 'string' },
          exitCode: { type: 'integer', description: 'null when killed by a signal instead of exiting normally.' },
          signal: { type: 'string', description: 'null unless the process was killed by a signal (timeout/abort/etc).' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          stdoutTruncated: { type: 'boolean' },
          stderrTruncated: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          aborted: { type: 'boolean' },
        },
      },
      render(_args, value) {
        const status = value.timedOut
          ? 'timed out'
          : value.aborted
            ? 'aborted'
            : value.signal
              ? `killed by ${value.signal}`
              : `exit code ${value.exitCode}`
        const parts = [`$ ${value.command} (${status})`]
        if (value.stdout) parts.push(`stdout:\n${value.stdout}${value.stdoutTruncated ? '\n... [stdout truncated]' : ''}`)
        if (value.stderr) parts.push(`stderr:\n${value.stderr}${value.stderrTruncated ? '\n... [stderr truncated]' : ''}`)
        return parts.join('\n')
      },
    },
    timeoutMs: REGISTRY_TIMEOUT_MS,
    // 有副作用、可能改动共享资源（文件、网络、其他进程）——不能假定跟兄弟调用并发安全。
    isConcurrencySafe: () => false,
    async execute(rawArgs, exec) {
      const args = rawArgs as RunCommandArgs

      const requestedTimeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
      if (requestedTimeout > MAX_TIMEOUT_MS) {
        throw new ToolExecutionError(`timeoutMs ${requestedTimeout} exceeds the ${MAX_TIMEOUT_MS}ms cap`)
      }

      // 策略判断在这里被强制执行：没有策略就是"不限制"（今天默认关闭，接进去才生效），
      // 有策略但说不允许，直接拒绝——不会因为策略之外还有别的理由想放行就绕过去。
      if (policy && !policy.isAllowed(args.command)) {
        throw new ToolExecutionError(`command "${args.command}" is not allowed by the current command policy`)
      }

      let cwd: string
      try {
        cwd = resolveWithinRoot(root, args.cwd ?? '.')
      } catch (error) {
        if (error instanceof PathEscapeError) throw new ToolExecutionError(error.message)
        throw error
      }
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new ToolExecutionError(`cwd "${args.cwd ?? '.'}" does not exist or is not a directory`)
      }

      // 白名单环境：只有 PATH（找可执行文件必需）+ 调用方显式传入的变量。宿主进程
      // `process.env` 里别的一切——包括调用这个工具的 Agent 进程自己持有的任何
      // secret——默认不会出现在子进程里，不需要一份"危险变量黑名单"去过滤。
      const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...(args.env ?? {}) }

      const result = await runProcess(
        {
          command: args.command,
          args: args.args ?? [],
          cwd,
          env,
          stdin: args.stdin,
          timeoutMs: requestedTimeout,
          maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        },
        exec.signal,
      )

      return {
        command: [args.command, ...(args.args ?? [])].join(' '),
        exitCode: result.exitCode,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        timedOut: result.timedOut,
        aborted: result.aborted,
      }
    },
  }
}
