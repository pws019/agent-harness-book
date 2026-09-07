# Day 4 实践任务

## 任务 1：读代码

按 `types.ts` → `schema-validate.ts` → `registry.ts` → `workspace.ts` → `fs-tools.ts` 的顺序通读。重点关注：

- `assertExplicitAdditionalProperties()` 在哪里被调用，为什么是在 `define()` 而不是 `execute()` 里。
- `registry.ts` 里那段关于取消检查时机的注释——对照 study.md 第5节，理解这个坑是怎么被发现和修复的。
- `fs-tools.ts` 里 `search_text` 的输出上限策略：为什么是"截断+报告总数"而不是直接截断丢弃。

## 任务 2：新增一个 `file_stats` 工具

在 `fs-tools.ts` 里新增一个只读工具 `file_stats`，接受 `{ file_path: string }`，返回该文件的字节大小、行数、是否以换行符结尾。要求：

1. `parameters` 必须显式声明 `additionalProperties: false`。
2. 复用 `resolveWithinRoot()` 做路径越界防护，不要自己重新实现一套。
3. `output.render()` 用一行人类可读文本描述结果，比如 `"src/index.ts: 6 lines, 123 bytes"`。
4. 给它设置一个合理的 `timeoutMs`。
5. 在 `createReadOnlyFsTools()` 里把它加进返回列表。

## 任务 3：为新工具写测试

在 `tests/tools.test.ts` 里新增一组测试，至少覆盖：

- 正常路径：对 `src/index.ts` 调用，断言返回的行数、字节数正确。
- 路径越界：对 `../outside-secret.txt` 调用，断言抛 `PathEscapeError`。
- 文件不存在：断言抛出的错误信息里包含文件路径，方便排查。

## 任务 4：故意写一个"浅工具"，感受一下区别

在测试文件里（不需要接入 registry，写成一个独立小例子即可）设计一版"浅接口"的文件读取流程：`open(path) -> handle`、`readChunk(handle, size) -> {data, handle}`、`close(handle)`。写一段调用代码，让它读出跟 `read_file` 一样的内容。

写完后回答（写在 PR 描述或者你自己的笔记里，不需要提交）：
- 这版浅接口需要几次工具调用才能完成同样的读取？
- 如果中间一次调用失败（比如 `readChunk` 抛异常），调用方要怎么知道现在的 `handle` 还有没有效？
- 这版设计里，哪些复杂度被转嫁给了调用方（也就是模型）？

## 验收自查

- [ ] `pnpm test` 全绿，新工具的测试覆盖了正常路径、越界路径、文件不存在三种情况。
- [ ] 我能不看代码，讲清楚 `assertExplicitAdditionalProperties()` 防住了什么问题。
- [ ] 我能讲清楚"取消检查时机"那个坑——为什么调用一个 async 函数会有同步执行的部分。
