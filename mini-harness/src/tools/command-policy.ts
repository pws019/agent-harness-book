/**
 * 策略判断和底层强制执行分开的具体落地：`CommandPolicy` 只回答"这个命令允不允许跑"
 * 这一个问题，是一个纯函数式的判断，自己不碰文件系统、不 spawn 任何东西——真正
 * "强制执行"这个判断结果的地方在 `bash-tool.ts`/`job-tools.ts` 的 `execute()` 里：
 * 判断说不允许，直接拒绝，不给任何"降级成宿主环境执行"的退路。
 */
export interface CommandPolicy {
  isAllowed(command: string): boolean
}

/** 白名单：只有显式列出的可执行文件名/路径允许被 run_command/start_job 启动。 */
export class AllowlistCommandPolicy implements CommandPolicy {
  private readonly allowed: ReadonlySet<string>

  constructor(allowed: Iterable<string>) {
    this.allowed = new Set(allowed)
  }

  isAllowed(command: string): boolean {
    return this.allowed.has(command)
  }
}

/**
 * fail-closed 包装：如果被包装的策略在求值过程中自己抛了异常（配置损坏、策略实现
 * 有 bug），按"拒绝"处理——绝不能因为策略本身出错，就悄悄退化成"没有策略、默认放行"。
 * 这是今天的核心原则："sandbox 不可用时，危险工具不可静默降级为宿主执行"在
 * 命令执行这个具体场景下的落地：策略不可用 ≈ sandbox 不可用，同样选择拒绝而不是放行。
 */
export class FailClosedCommandPolicy implements CommandPolicy {
  constructor(private readonly inner: CommandPolicy) {}

  isAllowed(command: string): boolean {
    try {
      return this.inner.isAllowed(command)
    } catch {
      return false
    }
  }
}
