import { ApprovalStore, type ApprovalRequest } from './approval.js'

/** 一次审批生命周期动作——`created`/`consumed`/`revoked` 分别对应 `ApprovalStore`
 * 的 `create()`/`consume()`/`revoke()` 真正成功之后。`principal` 是调用方自称的
 * 身份字符串，**不是经过验证的用户身份**——这个项目至今没有真实的用户认证/授权
 * 系统（Day22 的 bearer token 也只是"有没有钥匙"），跟那个诚实缺口是同一类。 */
export type AuditRecord =
  | { readonly kind: 'created'; readonly principal: string; readonly nonce: string; readonly action: string; readonly target: string; readonly at: number }
  | { readonly kind: 'consumed'; readonly principal: string; readonly nonce: string; readonly action: string; readonly target: string; readonly at: number }
  | { readonly kind: 'revoked'; readonly principal: string; readonly nonce: string; readonly action: string; readonly target: string; readonly at: number }

export interface AuditSink {
  record(entry: AuditRecord): void
}

/**
 * 包一层真实的 `ApprovalStore`（组合，不修改 `approval.ts` 本身）——转发
 * `create`/`consume`/`revoke` 的同时往一个可选的 `AuditSink` 发一条记录。
 * `ApprovalStore` 本身不暴露"给一个 nonce 查它的 action/target 是什么"这样的
 * 查询方法（`consume()`/`revoke()` 只接受 nonce，不返回原始请求），所以这里
 * 自己维护一份从 create() 时就记下来的小映射，只存静态元数据（action/target，
 * 创建后不会变），不重复 `ApprovalStore` 内部真正的状态机（consumed/revoked/
 * expired 那些判断完全交给被包的那个实例，这里不重新做一遍）。
 */
export class AuditingApprovalStore {
  private readonly metadata = new Map<string, { readonly action: string; readonly target: string }>()

  constructor(
    private readonly inner: ApprovalStore,
    private readonly sink?: AuditSink,
  ) {}

  create(action: string, target: string, argsSummary: string, args: unknown, ttlMs: number, principal: string, now: number = Date.now()): ApprovalRequest {
    const request = this.inner.create(action, target, argsSummary, args, ttlMs, now)
    this.metadata.set(request.nonce, { action, target })
    this.sink?.record({ kind: 'created', principal, nonce: request.nonce, action, target, at: now })
    return request
  }

  /** 只有 `inner.consume()` 真正成功（没有抛错）才会发出审计记录——一次因为参数
   * 不对/已过期/已消费而失败的尝试,不应该被记成"这次消费发生过"。 */
  consume(nonce: string, args: unknown, principal: string, now: number = Date.now()): void {
    this.inner.consume(nonce, args, now)
    const meta = this.metadata.get(nonce)
    this.sink?.record({ kind: 'consumed', principal, nonce, action: meta?.action ?? '(unknown)', target: meta?.target ?? '(unknown)', at: now })
  }

  revoke(nonce: string, principal: string, now: number = Date.now()): void {
    this.inner.revoke(nonce, now)
    const meta = this.metadata.get(nonce)
    this.sink?.record({ kind: 'revoked', principal, nonce, action: meta?.action ?? '(unknown)', target: meta?.target ?? '(unknown)', at: now })
  }
}
