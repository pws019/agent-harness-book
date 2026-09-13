import type { CredentialRef, CredentialStore } from './credentials.js'

/**
 * Workspace 是身份与能力边界，不只是"cwd 是哪个字符串"——它还回答"这个工作区
 * 配置了哪些凭据、用哪份设置"。今天只做一次具体示范（`run_command` 的
 * `envCredentials`），不强行把这个类型塞进 Day4/15/16 每一个工具的签名——那是
 * 一次改动面覆盖好几个文件、概念价值有限的机械重构，需要的时候再做,不是今天欠的债。
 */
export interface WorkspaceContext {
  readonly root: string
  readonly credentials: CredentialStore
  /**
   * 允许被注入进 `run_command`/`start_job` 子进程环境的凭据——键是环境变量名，
   * 值是指向真实密钥的引用，不是密钥本身。模型永远看不到、也传不出这份映射,
   * 只能在工具执行的那一刻,由这里解析成真实值,合并进子进程环境。
   */
  readonly envCredentials?: Readonly<Record<string, CredentialRef>>
}
