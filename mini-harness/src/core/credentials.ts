/**
 * 配置里只保存这个不透明引用，不保存真实密钥——`id` 只是"去哪能换到真实值"的
 * 指路牌，它本身完全可以被写进日志、Session 事件、错误信息，不会泄漏任何东西
 * （这是它存在的全部意义：一个可以被随便传来传去、随便打印的东西）。真正的值只有
 * 在 `CredentialStore.resolve()` 被调用的那一刻、真正要用的地方才会出现。
 */
export interface CredentialRef {
  readonly id: string
}

export class CredentialNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown credential: "${id}"`)
    this.name = 'CredentialNotFoundError'
  }
}

export interface CredentialStore {
  resolve(ref: CredentialRef): string
}

/** 教学用的最小实现——真实系统里这里会接操作系统 keychain/secrets manager 之类,
 * 接口保持一样,`resolve()` 之外没有别的公开方法能拿到原始值。 */
export class InMemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>()

  set(id: string, value: string): void {
    this.values.set(id, value)
  }

  resolve(ref: CredentialRef): string {
    const value = this.values.get(ref.id)
    if (value === undefined) throw new CredentialNotFoundError(ref.id)
    return value
  }
}
