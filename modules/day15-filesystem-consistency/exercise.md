# Day 15 实践任务

## 任务 1：亲手制造一次 symlink 逃逸，看它被真的挡住

```bash
cd mini-harness
mkdir -p /tmp/day15-outside /tmp/day15-workspace
echo "top secret" > /tmp/day15-outside/secret.txt
ln -s /tmp/day15-outside/secret.txt /tmp/day15-workspace/looks-local.txt
```

写一个几行的 `tsx` 脚本（或者直接跑 `tests/fs-tools-integration.test.ts` 里对应的用例），用 `createReadOnlyFsTools('/tmp/day15-workspace')` 建一个 registry，调用 `read_file({ file_path: 'looks-local.txt' })`。确认抛出的是 `PathEscapeError`，读一下报错信息里带没带"via a symlink"这几个字，跟纯 `../` 逃逸的报错区分开。

## 任务 2：亲手复现一次 TOCTOU，并确认原文件没被污染

1. 建一个临时 workspace，写入 `a.txt` 内容为 `v1`。
2. 用 `read_file` 读一次，记下 `contentHash`。
3. **不通过工具**，直接用 `node:fs` 的 `writeFileSync` 把 `a.txt` 改成 `v1 (changed by someone else)`。
4. 用刚才第 2 步记下的旧 `contentHash` 去调 `edit_file`，确认它抛错，而且报错信息提到"has changed since you last read it"。
5. 再用 `read_file` 读一次，确认内容还是第 3 步写的那个版本——`edit_file` 的失败没有把文件改坏，也没有留下"写了一半"的痕迹。

## 任务 3：一道思考题（不用写代码）

`edit_file` 的 `content` 参数要求调用方（模型）给出**编辑之后的完整文件内容**，而不是像 `diff`/`patch` 那样只给"改了哪几行"。对一个几千行的大文件来说，这意味着模型哪怕只改一行，也要把整份文件重新生成一遍发给工具。

结合 study.md 第2节讲的"深接口、一套边界检查"这个设计取舍，想一想：如果 `edit_file` 改成接受"旧文本片段 + 新文本片段"（类似字符串替换）而不是整份新内容，`expectedHash` 这套机制还能不能沿用？如果不能整体沿用，具体是哪一步会出问题？（提示：`expectedHash` 校验的对象是"当前磁盘内容的哈希"，"旧文本片段"这种描述方式隐含了一个额外假设——这个片段在当前文件里必须能唯一定位。）

## 验收自查

- [ ] `pnpm test` 全绿，包括 `tests/fs-tools-integration.test.ts`。
- [ ] 我能不看代码，把"字符串层面检测"和"symlink 真实路径检测"这两道关卡分别举一个能通过第一道但被第二道拦下的具体例子。
- [ ] 我能解释 `edit_file` 四种"文件是否存在 × 是否传 expectedHash"组合里，为什么"已存在但没传"和"不存在但传了"都要拒绝，而不只是拒绝"hash 对不上"这一种情况。
- [ ] 我写完了任务 3 的思考题，具体说清楚了"哪一步会出问题"，不是空泛地说"不行"。
