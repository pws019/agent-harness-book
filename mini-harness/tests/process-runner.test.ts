import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess, type SpawnSpec } from '../src/tools/process-runner.js'

const NODE = process.execPath

function spec(overrides: Partial<SpawnSpec> & { readonly args: readonly string[] }): SpawnSpec {
  return {
    command: NODE,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? '' },
    timeoutMs: 2_000,
    maxOutputBytes: 200_000,
    ...overrides,
  }
}

function neverAborts(): AbortSignal {
  return new AbortController().signal
}

const tmpDirs: string[] = []
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'process-runner-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('runProcess: happy path', () => {
  it('captures stdout and a normal exit code', async () => {
    const result = await runProcess(spec({ args: ['-e', 'console.log("hello")'] }), neverAborts())
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('writes stdin through to the process', async () => {
    const result = await runProcess(
      spec({ args: ['-e', 'process.stdin.on("data", (d) => process.stdout.write("echo:" + d))'], stdin: 'ping' }),
      neverAborts(),
    )
    expect(result.stdout).toBe('echo:ping')
  })
})

describe('fault injection: output flood is bounded, not silently dropped', () => {
  it('truncates stdout at maxOutputBytes and reports it, without hanging the process', async () => {
    const result = await runProcess(
      spec({
        args: ['-e', 'for (let i = 0; i < 100000; i++) process.stdout.write("x".repeat(200))'],
        maxOutputBytes: 5_000,
      }),
      neverAborts(),
    )
    expect(result.stdout.length).toBe(5_000)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.exitCode).toBe(0) // 没有因为没人读管道而卡死，进程正常跑完退出
  })
})

describe('fault injection: maxTotalOutputBytes caps stdout+stderr combined, not each independently', () => {
  it('stdout alone hitting the combined cap gets truncated even though it never sees maxOutputBytes', async () => {
    const result = await runProcess(
      spec({
        args: ['-e', 'for (let i = 0; i < 100000; i++) process.stdout.write("x".repeat(200))'],
        maxOutputBytes: 1_000_000, // 故意留得很宽松，证明真正生效的是下面这个合计上限
        maxTotalOutputBytes: 5_000,
      }),
      neverAborts(),
    )
    expect(result.stdout.length).toBe(5_000)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderr.length).toBe(0)
    expect(result.stderrTruncated).toBe(false) // stderr 什么都没写，自己没有超,不该被错误标记
  })

  it('stderr alone hitting the combined cap gets truncated the same way stdout does', async () => {
    const result = await runProcess(
      spec({
        args: ['-e', 'for (let i = 0; i < 100000; i++) process.stderr.write("x".repeat(200))'],
        maxOutputBytes: 1_000_000,
        maxTotalOutputBytes: 5_000,
      }),
      neverAborts(),
    )
    expect(result.stderr.length).toBe(5_000)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdout.length).toBe(0)
    expect(result.stdoutTruncated).toBe(false)
  })

  it('stdout and stderr writing alternately still add up against one shared quota, not 5000 bytes each', async () => {
    const script = `
      for (let i = 0; i < 100000; i++) {
        process.stdout.write("a".repeat(100));
        process.stderr.write("b".repeat(100));
      }
    `
    const result = await runProcess(
      spec({ args: ['-e', script], maxOutputBytes: 1_000_000, maxTotalOutputBytes: 5_000 }),
      neverAborts(),
    )
    // 各自都被切了一刀，但加起来必须封顶在合计上限——不是各自都能吃到 5000。
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.stdout.length + result.stderr.length).toBe(5_000)
  })
})

describe('fault injection: a process that never exits gets killed by the timeout', () => {
  it('resolves at the timeout instead of hanging forever, and marks timedOut', async () => {
    const start = Date.now()
    const result = await runProcess(spec({ args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 200 }), neverAborts())
    expect(result.timedOut).toBe(true)
    expect(Date.now() - start).toBeLessThan(2_000)
  })
})

describe('fault injection: killing the parent also reaps forked children (process-tree kill)', () => {
  it('a grandchild process spawned by the command stops running once the timeout kills the tree', async () => {
    const dir = makeTmpDir()
    const marker = join(dir, 'marker.txt')
    writeFileSync(marker, '')

    // 父进程（我们直接 spawn 的那个）自己再 fork 一个孙进程，孙进程每 20ms 往
    // marker 文件里追加一个字符，用来在事后证明"它是不是还活着"，不用去查系统进程表。
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"), 20)']);
      child.unref();
      setInterval(() => {}, 1000); // 让这个父进程自己也不会主动退出
    `
    const result = await runProcess(spec({ args: ['-e', script], timeoutMs: 200 }), neverAborts())
    expect(result.timedOut).toBe(true)

    const sizeRightAfterKill = readFileSync(marker, 'utf8').length
    await new Promise((r) => setTimeout(r, 200))
    const sizeAfterWaiting = readFileSync(marker, 'utf8').length

    // 如果孙进程还活着，这 200ms 里 marker 文件还会继续变大；进程树被真正回收的话，
    // 两次读到的大小应该一样（cap 一个很小的容差，避免时序上一两次写入的抖动误判）。
    expect(sizeAfterWaiting - sizeRightAfterKill).toBeLessThanOrEqual(2)
  }, 10_000)
})

describe('fault injection: environment is an allowlist, not an inherited copy of the host process', () => {
  it('a secret set on the host process env does not leak into the child unless explicitly passed', async () => {
    process.env.SUPER_SECRET_TOKEN_FOR_TEST = 'leaked-value-should-not-appear'
    try {
      const result = await runProcess(
        spec({ args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'], env: { PATH: process.env.PATH ?? '' } }),
        neverAborts(),
      )
      const childEnv = JSON.parse(result.stdout) as Record<string, string>
      expect(childEnv.PATH).toBeDefined() // 白名单里显式给的会在
      expect(childEnv.SUPER_SECRET_TOKEN_FOR_TEST).toBeUndefined()
      expect(Object.values(childEnv)).not.toContain('leaked-value-should-not-appear')
      // 不断言子进程环境里"只有"哪些 key——像 macOS 的 __CF_USER_TEXT_ENCODING 这种
      // 由操作系统/动态链接器自己注入的无害变量，不受我们传给 spawn() 的 env 控制，
      // 断言"敏感值没有泄漏"才是这里真正关心的安全属性，不是"环境对象长度恰好是几"。
    } finally {
      delete process.env.SUPER_SECRET_TOKEN_FOR_TEST
    }
  })

  it('explicitly passed extra variables do show up', async () => {
    const result = await runProcess(
      spec({
        args: ['-e', 'process.stdout.write(process.env.MY_VAR ?? "(missing)")'],
        env: { PATH: process.env.PATH ?? '', MY_VAR: 'hello' },
      }),
      neverAborts(),
    )
    expect(result.stdout).toBe('hello')
  })
})

describe('fault injection: cancellation races with a long-running process', () => {
  it('aborting the signal kills the process promptly instead of waiting out the full timeout', async () => {
    const controller = new AbortController()
    const promise = runProcess(spec({ args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 10_000 }), controller.signal)
    setTimeout(() => controller.abort(), 100)

    const start = Date.now()
    const result = await promise
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(Date.now() - start).toBeLessThan(2_000) // 远早于 10s 的超时上限
  })
})

describe('fault injection: a bad command surfaces as a rejection, not a hang', () => {
  it('spawning a nonexistent executable rejects instead of resolving or hanging', async () => {
    await expect(runProcess(spec({ command: '/no/such/executable-xyz', args: [] }), neverAborts())).rejects.toThrow()
  })
})
