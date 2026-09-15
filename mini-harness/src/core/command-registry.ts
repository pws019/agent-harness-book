import { proposeEdit, type ProposeEditOptions, type ProposeEditOutcome } from '../propose-edit.js'

/**
 * 一个人类直接调用的确定性动作——跟 Day4 `ToolDefinition` 的核心区别是"谁触发"：
 * `ToolDefinition` 经过 `ToolRegistry.execute()`，是模型在一次工具调用里选中并传参
 * 调用的；`Command` 从来不出现在模型能看到的工具 schema 列表里，是人（或者人写的
 * 脚本）直接调用的——`cli.ts` 的 `propose-edit`/`inspect-session` 这些子命令,从
 * Day15/Day21 起就已经是这种性质了，只是当时没有一个专门的类型把这个区分显式地
 * 命名出来。今天不是发明新逻辑，是给一个早就隐含存在的区分找一个名字。
 */
export interface Command<Args, Result> {
  readonly name: string
  readonly description: string
  execute(args: Args): Promise<Result>
}

export class DuplicateCommandError extends Error {
  constructor(name: string) {
    super(`duplicate command registration: "${name}"`)
    this.name = 'DuplicateCommandError'
  }
}

export class CommandNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown command: "${name}"`)
    this.name = 'CommandNotFoundError'
  }
}

/**
 * 一次真实的落地示范——把 Day21 已经存在的 `proposeEdit()` 包成一个 `Command`。
 * 这不是新逻辑，`proposeEdit()` 本来就只被 `cli.ts` 的 `propose-edit` 子命令直接
 * 调用（人敲命令触发，不经过模型的工具调用管线）——`createProposeEditCommand()`
 * 只是把这个早就存在的事实用 `Command` 这个类型显式表达出来。
 */
export function createProposeEditCommand(): Command<ProposeEditOptions, ProposeEditOutcome> {
  return {
    name: 'propose-edit',
    description: 'Read a file, generate a proposed edit, get approval, write if approved, optionally verify.',
    execute: (args) => proposeEdit(args),
  }
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command<unknown, unknown>>()

  define<Args, Result>(command: Command<Args, Result>): void {
    if (this.commands.has(command.name)) throw new DuplicateCommandError(command.name)
    this.commands.set(command.name, command as Command<unknown, unknown>)
  }

  names(): readonly string[] {
    return [...this.commands.keys()]
  }

  async execute(name: string, args: unknown): Promise<unknown> {
    const command = this.commands.get(name)
    if (!command) throw new CommandNotFoundError(name)
    return command.execute(args)
  }
}
