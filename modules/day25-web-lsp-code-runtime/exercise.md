# Day 25 实践任务

## 任务 1：亲手复现"定位到注释里的名字"这个坑

在 `src/core/semantic-query.ts` 里，把 `locateIdentifier()` 跳过注释行的那一步去掉：

```ts
function locateIdentifier(text: string, identifierName: string): { line: number; offset: number } | undefined {
  const pattern = new RegExp(`\\b${identifierName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = pattern.exec(lines[i]!)
    if (match) return { line: i + 1, offset: match.index + 1 }
  }
  return undefined
}
```

重新跑：

```bash
pnpm vitest run tests/semantic-query.test.ts
```

确认"finds the real definition of a symbol it can locate in the file text"和"end-to-end...primary succeeds"这两条测试失败——`result.kind` 从 `'semantic'` 变成 `'no-results'`（或者 `withFallback` 那条变成 `'text-fallback'`）。打开 `src/core/session.ts` 前几行，自己找一下"Session"这个词第一次出现在哪里，验证你的理解跟 study.md §4 描述的一致。跑完记得改回来，确认全绿。

## 任务 2：亲手复现 `instanceof Error` 跨 realm 失效这个坑

在 `src/core/code-runtime.ts` 里，把超时判断改回"看起来更直觉"的版本：

```ts
if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
  throw new CodeRuntimeTimeoutError(options.timeoutMs ?? 2_000)
}
```

重新跑：

```bash
pnpm vitest run tests/code-runtime.test.ts
```

确认"a script that runs longer than the timeout is aborted"这条测试失败——抛出的不是 `CodeRuntimeTimeoutError`，是 `vm` 内部的原始超时错误。自己写一段 `node -e`（不用 vitest，直接跑）验证一下：`vm.createContext()` 建出来的 context 里抛的错误，`instanceof`（宿主的 `Error`）到底是 `true` 还是 `false`,跟 study.md §7 最后那段描述对不对得上。跑完记得改回来，确认全绿。

## 任务 3：一道思考题（不用写代码）

`study.md` §7 演示的沙箱逃逸靠的是"任何传进沙箱的宿主函数,都是一条潜在的逃逸通道"。想一想：如果 `CodeRuntime` 的真实使用场景就是需要给沙箱脚本一些"能力"（比如让它能调用一个 `readFile(path)` 辅助函数），完全不传任何函数进去不现实。有没有办法在"必须传函数进去"的前提下,降低（不是完全消除——你已经知道 `vm` 不是真安全边界）这条逃逸通道的风险？至少想一条具体的缓解思路,并说清楚它能挡住什么、挡不住什么（提示：可以想一想"传一个函数"和"传一个经过某种包装、调用方式受限的东西"之间有没有区别）。

## 验收自查

- [ ] `pnpm test` 全绿，包括你在任务1、任务2里临时改坏又改回来之后的状态。
- [ ] 我能解释：任务1里去掉注释跳过逻辑之后，`tsserver` 为什么会诚实地报告"查无此符号"，而不是报错或者查到错误的位置——具体是什么原因导致查询位置本身就没有对应的符号。
- [ ] 我能解释：任务2里 `instanceof Error` 为什么在这个场景下会返回 `false`，哪怕两个错误对象的构造器名字看起来都叫"Error"。
- [ ] 我写完了任务3的缓解思路，明确说了它挡得住什么、挡不住什么，不是"应该会更安全"这种没有边界的回答。
