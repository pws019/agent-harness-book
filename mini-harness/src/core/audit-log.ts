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

  /**
   * 通知 sink——但吞掉它自己抛出的错误。这是根 `README.md` 企业级不变式清单第16条
   * ("telemetry sink 故障不能破坏主任务")第一次被真正落实成代码，不只是清单上的一句话
   * （见 Day29 `tests/load-and-chaos.test.ts` 的真实验证）。`AuditSink` 是一个尽力而为
   * 的旁路通知,不是"这次审批动作能不能成功"的前提条件——真正的审批状态机（谁被批准了
   * 什么）完全由 `inner: ApprovalStore` 决定,已经在上面几行成功返回,不会因为审计通知
   * 失败而回滚或抛出。**这个决定只适用于这种"尽力而为的旁路通知"场景**：Day9
   * `Agent`/`session.ts` 里 `SessionSink` 的 `append()` 故意没有做同样的事——那个 sink
   * 除了广播（Day22）还兼作持久化通道（`JsonlSessionStore`），如果写盘失败也被静默吞掉,
   * 会让"事件已经追加"和"事件其实没有真的落盘"这两个不一致的状态被隐藏起来,比抛出去
   * 更危险。同一种接口形状（“可选的 sink，失败了怎么办”），在两个不同职责下应该有不同的
   * 答案——不是所有失败都该被无声吞掉,只有真正"可有可无"的旁路通知才该这样处理。
   */
  private notify(entry: AuditRecord): void {
    try {
      this.sink?.record(entry)
    } catch {
      // 故意吞掉——见上面的类级别文档注释。
    }
  }

  create(action: string, target: string, argsSummary: string, args: unknown, ttlMs: number, principal: string, now: number = Date.now()): ApprovalRequest {
    const request = this.inner.create(action, target, argsSummary, args, ttlMs, now)
    this.metadata.set(request.nonce, { action, target })
    this.notify({ kind: 'created', principal, nonce: request.nonce, action, target, at: now })
    return request
  }

  /** 只有 `inner.consume()` 真正成功（没有抛错）才会发出审计记录——一次因为参数
   * 不对/已过期/已消费而失败的尝试,不应该被记成"这次消费发生过"。 */
  consume(nonce: string, args: unknown, principal: string, now: number = Date.now()): void {
    this.inner.consume(nonce, args, now)
    const meta = this.metadata.get(nonce)
    this.notify({ kind: 'consumed', principal, nonce, action: meta?.action ?? '(unknown)', target: meta?.target ?? '(unknown)', at: now })
  }

  revoke(nonce: string, principal: string, now: number = Date.now()): void {
    this.inner.revoke(nonce, now)
    const meta = this.metadata.get(nonce)
    this.notify({ kind: 'revoked', principal, nonce, action: meta?.action ?? '(unknown)', target: meta?.target ?? '(unknown)', at: now })
  }
}
