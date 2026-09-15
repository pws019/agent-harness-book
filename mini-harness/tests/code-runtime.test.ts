import { describe, expect, it } from 'vitest'
import { CodeRuntime, CodeRuntimeTimeoutError } from '../src/core/code-runtime.js'

describe('CodeRuntime: explicit bindings allowlist, nothing ambient', () => {
  it('a script can use exactly the bindings it was given', () => {
    const runtime = new CodeRuntime()
    const result = runtime.run('a + b', { a: 2, b: 3 })
    expect(result).toBe(5)
  })

  it('process/require are not ambiently available — they are undefined, not the host ones', () => {
    const runtime = new CodeRuntime()
    expect(runtime.run('typeof process', {})).toBe('undefined')
    expect(runtime.run('typeof require', {})).toBe('undefined')
  })

  it('a binding not explicitly passed in is unreachable', () => {
    const runtime = new CodeRuntime()
    expect(runtime.run('typeof secretThing', { a: 1 })).toBe('undefined')
  })

  it('a script that runs longer than the timeout is aborted', () => {
    const runtime = new CodeRuntime()
    expect(() => runtime.run('while (true) {}', {}, { timeoutMs: 100 })).toThrow(CodeRuntimeTimeoutError)
  })

  it('a genuine runtime error inside the script propagates, not swallowed', () => {
    const runtime = new CodeRuntime()
    expect(() => runtime.run('undefinedVariable.property', {})).toThrow()
  })
})

describe('CodeRuntime: accepted gap — node:vm is not a real security boundary', () => {
  it(
    'a script can escape the sandbox via any host-realm function passed in as a binding, reaching the real process',
    () => {
      const runtime = new CodeRuntime()
      // `helper` 看起来完全无害——只是一个普通的绑定函数,不是故意留的后门。但它是
      // 在宿主 realm 里创建的,它的 `.constructor`（Function）也是宿主 realm 的
      // Function 构造器——脚本可以借着这条原型链,用宿主的 Function 构造器造一个
      // 新函数,这个新函数天生就在宿主 realm 里运行,`process` 对它来说是真实存在的
      // 全局变量,不是沙箱里那个"undefined"。
      const helper = (): number => 42
      const realPid = process.pid

      const escapedPid = runtime.run('helper.constructor.constructor("return process.pid")()', { helper })

      expect(escapedPid).toBe(realPid) // 真的拿到了宿主进程的真实 pid，不是沙箱里的假值
    },
  )

  it('the escape requires a host-realm function binding — pure-data bindings alone do not enable it', () => {
    const runtime = new CodeRuntime()
    // 只传纯数据（数字/字符串/对象字面量），不传任何函数——`constructor` 链条上碰到
    // 的都是沙箱自己 context 里的内建对象，够不到宿主的 Function 构造器。
    expect(() => runtime.run('({}).constructor.constructor("return process.pid")()', { n: 1, s: 'x', o: { a: 1 } })).toThrow()
  })
})
