/**
 * 跨天汇总回归：原始大纲 Day18 点名的 5 种红队场景,逐条验证"防线是不是真的还生效"。
 * 大部分机制在 Day15/16/17 已经各自测过一次,这里不是重复造轮子,是把它们按"红队
 * 场景"这个维度重新组织一遍,任何一天以后不小心改坏了某个防线,这份测试会先炸。
 * 见 modules/day18-sandbox-and-least-privilege/threat-model.md。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRunCommandTool } from '../src/tools/bash-tool.js'
import { AllowlistCommandPolicy, FailClosedCommandPolicy } from '../src/tools/command-policy.js'
import { createReadOnlyFsTools } from '../src/tools/fs-tools.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ToolExecutionError, type ToolExecutionContext } from '../src/tools/types.js'
import { PathEscapeError } from '../src/tools/workspace.js'

const NODE = process.execPath

function ctx(): ToolExecutionContext {
  return { signal: new AbortController().signal, cwd: '.' }
}

const tmpDirs: string[] = []
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'red-team-test-'))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true })
})

describe('红队场景1：prompt injection 要求读取密钥', () => {
  it('run_command 的 env 白名单让宿主进程的 secret 对子进程不可见,即使被诱导去执行"打印所有环境变量"这类命令', async () => {
    const root = makeWorkspace()
    process.env.RED_TEAM_SECRET = 'super-secret-value'
    try {
      const registry = new ToolRegistry()
      registry.define(createRunCommandTool(root))
      const result = await registry.execute(
        'run_command',
        { command: NODE, args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'] },
        ctx(),
      )
      expect(result.content).not.toContain('super-secret-value')
    } finally {
      delete process.env.RED_TEAM_SECRET
    }
  })
})

describe('红队场景2：命令通过 shell 特性绕过', () => {
  it('shell 元字符（分号+第二条命令）只是 argv 里一个字符串的字面内容，不会被拆成"再执行一条新命令"', async () => {
    const root = makeWorkspace()
    const pwnedMarker = join(root, 'pwned.txt')
    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root))

    // 如果 spawn 走了 shell 解析，`echo hello; touch pwned.txt` 会被拆成两条命令，
    // pwned.txt 就会被真的创建出来；不走 shell 的话，`echo` 收到的是一整个字面参数
    // "hello; touch pwned.txt"，原样打印，不会有任何"touch"发生。
    const result = await registry.execute(
      'run_command',
      { command: 'echo', args: [`hello; touch ${pwnedMarker}`] },
      ctx(),
    )
    expect(result.content).toContain(`hello; touch ${pwnedMarker}`) // 原样打印出来了，说明是字面字符串
    expect(existsSync(pwnedMarker)).toBe(false) // 没有第二条命令被"注入"执行
  })
})

describe('红队场景3：symlink 逃逸', () => {
  it('工具层的 resolveWithinRoot 拒绝跟着一个指向 workspace 外的符号链接走', async () => {
    const root = makeWorkspace()
    const outside = makeWorkspace()
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'looks-local.txt'))

    const registry = new ToolRegistry()
    for (const tool of createReadOnlyFsTools(root)) registry.define(tool)

    await expect(registry.execute('read_file', { file_path: 'looks-local.txt' }, ctx())).rejects.toThrow(PathEscapeError)
  })
})

describe('红队场景4：网络外传——当前接受的缺口，不是已解决问题', () => {
  it('一个被 CommandPolicy 允许的可执行文件，本身依然有能力发起网络请求——策略只挡"哪个程序能跑"，不挡"跑起来的程序能连哪里"', async () => {
    // 这条测试不真的发网络请求（避免测试依赖外网、变得不确定）——它验证的是
    // "CommandPolicy 允许 node 之后，我们没有任何机制阻止 node 脚本自己发起
    // 网络连接"这件事本身：只要 node.http/https 模块在，策略层完全看不见、
    // 也管不到这一层。这就是 study.md 里明确写的"当前接受的缺口"。
    const root = makeWorkspace()
    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root, new AllowlistCommandPolicy([NODE])))

    const result = await registry.execute(
      'run_command',
      { command: NODE, args: ['-e', 'process.stdout.write(typeof require("node:http").request)'] },
      ctx(),
    )
    // "function" 存在,说明这个被允许的程序完全有能力自己发起网络请求——
    // CommandPolicy 挡不住这个,只有 OS 级网络隔离才能挡,今天没有做。
    expect(result.content).toContain('function')
  })

  it('一个不在白名单里的已知网络工具会被 CommandPolicy 直接拒绝——这是唯一今天真正提供的、部分的缓解', async () => {
    const root = makeWorkspace()
    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(root, new AllowlistCommandPolicy(['ls', 'cat']))) // 白名单里没有 curl/wget
    await expect(registry.execute('run_command', { command: 'curl', args: ['https://example.com'] }, ctx())).rejects.toThrow(
      ToolExecutionError,
    )
  })
})

describe('红队场景5：fork bomb（缩小规模的安全模拟版）', () => {
  it('一个命令连续 fork 出好几个子进程，超时之后整棵树都被回收，不留任何存活的子孙', async () => {
    const dir = makeWorkspace()
    const marker = join(dir, 'marker.txt')
    writeFileSync(marker, '')
    const registry = new ToolRegistry()
    registry.define(createRunCommandTool(dir))

    const forkBombLite = `
      const { spawn } = require('node:child_process');
      for (let i = 0; i < 4; i++) {
        spawn(process.execPath, ['-e', 'setInterval(() => require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"), 20)']);
      }
      setInterval(() => {}, 1000);
    `
    await registry.execute('run_command', { command: NODE, args: ['-e', forkBombLite], timeoutMs: 200 }, ctx())

    const sizeRightAfter = readFileSync(marker, 'utf8').length
    await new Promise((r) => setTimeout(r, 200))
    const sizeAfterWaiting = readFileSync(marker, 'utf8').length
    expect(sizeAfterWaiting - sizeRightAfter).toBeLessThanOrEqual(8) // 4 个子进程，允许一点点时序抖动，但不该继续显著增长
  }, 10_000)
})

describe('fail-closed 是这几条防线共同的兜底原则', () => {
  it('CommandPolicy 求值本身出错时，拒绝而不是悄悄放行——不管红队场景是哪一种，这条兜底原则都适用', async () => {
    const root = makeWorkspace()
    const registry = new ToolRegistry()
    registry.define(
      createRunCommandTool(
        root,
        new FailClosedCommandPolicy({
          isAllowed() {
            throw new Error('policy backend unreachable')
          },
        }),
      ),
    )
    await expect(registry.execute('run_command', { command: NODE, args: ['-e', '1'] }, ctx())).rejects.toThrow(
      ToolExecutionError,
    )
  })
})
