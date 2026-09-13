import { existsSync, statSync } from 'node:fs'
import { JobNotFoundError, JobRuntime, type JobStatus } from '../core/job-runtime.js'
import { ToolExecutionError, type ToolDefinition } from './types.js'
import { PathEscapeError, resolveWithinRoot } from './workspace.js'

const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000 // 6 小时——后台任务不该继承 run_command 那种"一次工具调用"的短预算
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_OUTPUT_BYTES = 200_000

function statusLine(status: JobStatus): string {
  switch (status.kind) {
    case 'running':
      return 'running'
    case 'completed':
      return `completed (exit code ${status.exitCode}${status.signal ? `, signal ${status.signal}` : ''})`
    case 'cancelled':
      return 'cancelled'
    case 'error':
      return `error: ${status.message}`
  }
}

function toToolError(error: unknown): never {
  if (error instanceof JobNotFoundError) throw new ToolExecutionError(error.message)
  throw error
}

interface StartJobArgs {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

interface StartJobValue {
  readonly jobId: string
}

export function createStartJobTool(root: string, runtime: JobRuntime): ToolDefinition<StartJobValue> {
  return {
    name: 'start_job',
    description:
      'Start a command in the background and return immediately with a jobId — use this instead of run_command when a command may run longer than you want to wait synchronously. ' +
      'Check on it later with job_status; stop it with cancel_job. Same argv/env rules as run_command: no shell interpretation, env is an allowlist.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Executable name or path.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argv, passed literally.' },
        cwd: { type: 'string', description: 'Directory relative to the workspace root. Defaults to the root itself.' },
        env: { type: 'object', additionalProperties: true, description: 'Extra environment variables allowed through, on top of PATH.' },
        timeoutMs: { type: 'integer', description: `Max lifetime for the job. Defaults to ${DEFAULT_TIMEOUT_MS}ms, capped at ${MAX_TIMEOUT_MS}ms.` },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['jobId'], properties: { jobId: { type: 'string' } } },
      render: (_args, value) => `started ${value.jobId}`,
    },
    timeoutMs: 5_000, // 这个只是 registry 的调用超时（"接受这次调度请求"要多快），不是 Job 本身能跑多久
    isConcurrencySafe: () => true, // start_job 本身立刻返回，不占着不放，可以跟兄弟调用并发
    async execute(rawArgs) {
      const args = rawArgs as StartJobArgs
      const requestedTimeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS
      if (requestedTimeout > MAX_TIMEOUT_MS) {
        throw new ToolExecutionError(`timeoutMs ${requestedTimeout} exceeds the ${MAX_TIMEOUT_MS}ms cap`)
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

      const env: Record<string, string> = { PATH: process.env.PATH ?? '', ...(args.env ?? {}) }
      const jobId = runtime.start({
        command: args.command,
        args: args.args ?? [],
        cwd,
        env,
        timeoutMs: requestedTimeout,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      })
      return { jobId }
    },
  }
}

interface JobIdArgs {
  readonly jobId: string
}

interface JobStatusValue {
  readonly jobId: string
  readonly status: string
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

export function createJobStatusTool(runtime: JobRuntime): ToolDefinition<JobStatusValue> {
  return {
    name: 'job_status',
    description: 'Check on a background job started with start_job: its current status and everything it has printed so far.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['jobId'],
      properties: { jobId: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['jobId', 'status', 'stdout', 'stderr', 'stdoutTruncated', 'stderrTruncated'],
        properties: {
          jobId: { type: 'string' },
          status: { type: 'string' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          stdoutTruncated: { type: 'boolean' },
          stderrTruncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const parts = [`${value.jobId}: ${value.status}`]
        if (value.stdout) parts.push(`stdout:\n${value.stdout}${value.stdoutTruncated ? '\n... [truncated]' : ''}`)
        if (value.stderr) parts.push(`stderr:\n${value.stderr}${value.stderrTruncated ? '\n... [truncated]' : ''}`)
        return parts.join('\n')
      },
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => true, // 只读一份快照，不改任何状态，随便跟别的调用并发
    async execute(rawArgs) {
      const args = rawArgs as JobIdArgs
      try {
        const snapshot = runtime.poll(args.jobId)
        return {
          jobId: snapshot.id,
          status: statusLine(snapshot.status),
          stdout: snapshot.stdout,
          stderr: snapshot.stderr,
          stdoutTruncated: snapshot.stdoutTruncated,
          stderrTruncated: snapshot.stderrTruncated,
        }
      } catch (error) {
        return toToolError(error)
      }
    },
  }
}

interface CancelJobValue {
  readonly jobId: string
  readonly requested: true
}

export function createCancelJobTool(runtime: JobRuntime): ToolDefinition<CancelJobValue> {
  return {
    name: 'cancel_job',
    description:
      'Request cancellation of a background job started with start_job. Returns immediately once the kill signal is sent — ' +
      'call job_status afterwards to see the final status, it may take a moment to actually stop.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['jobId'],
      properties: { jobId: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['jobId', 'requested'],
        properties: { jobId: { type: 'string' }, requested: { type: 'boolean' } },
      },
      render: (_args, value) => `cancellation requested for ${value.jobId}`,
    },
    timeoutMs: 5_000,
    isConcurrencySafe: () => false, // 会改变共享的 JobRuntime 状态，跟对同一个 job 的其它调用不该并发
    async execute(rawArgs) {
      const args = rawArgs as JobIdArgs
      try {
        runtime.cancel(args.jobId)
      } catch (error) {
        return toToolError(error)
      }
      return { jobId: args.jobId, requested: true }
    },
  }
}

export function createJobTools(root: string, runtime: JobRuntime): readonly ToolDefinition<unknown>[] {
  return [
    createStartJobTool(root, runtime) as ToolDefinition<unknown>,
    createJobStatusTool(runtime) as ToolDefinition<unknown>,
    createCancelJobTool(runtime) as ToolDefinition<unknown>,
  ]
}
