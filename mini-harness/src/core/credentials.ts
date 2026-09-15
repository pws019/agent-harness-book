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

/**
 * 真实部署场景下最常见的凭据来源：运维在启动时把真实密钥设进宿主进程的
 * `process.env`，不写进代码或配置文件。映射规则选最简单的直接对应——`ref.id`
 * 本身就是环境变量名，不做任何前缀拼接或大小写转换。没有选"自动转大写"/"自动加
 * 前缀"这类看起来更规整的映射，是因为环境变量名本身不是敏感信息（敏感的是它的
 * 值），引入一层隐式转换规则只会让"这个 id 到底对应哪个环境变量"变成一件需要
 * 额外记住一条换算规则才能确认的事——直接对应是唯一不需要文档就能看懂的映射。
 */
export class EnvCredentialStore implements CredentialStore {
  resolve(ref: CredentialRef): string {
    const value = process.env[ref.id]
    if (value === undefined) throw new CredentialNotFoundError(ref.id)
    return value
  }
}
