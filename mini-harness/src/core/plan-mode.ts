import type { PermissionDecision, PermissionPreset } from './permission-presets.js'

export type AgentMode = 'planning' | 'executing'

export interface ModeTransition {
  readonly mode: AgentMode
  readonly at: number
}

/**
 * Plan mode 把"探索/设计"和"真正执行"分成两个阶段——探索期不该有副作用,只有明确
 * 切换到执行阶段之后,写操作才被允许。今天的落地直接复用 Day19 `PermissionPreset`：
 * `planning` 阶段配一个 `readonly` 预设（只读工具自动放行,其它一律拒绝),`executing`
 * 阶段配一个更宽松的预设——不发明新的判断逻辑,只是把"现在是哪个阶段"和"这个阶段该
 * 用哪个 preset"这件事显式地管理起来。
 *
 * 故意没有做的事：`Agent` 的 `ToolRegistry` 在构造时就固定了（`AgentDeps.tools`），
 * 没有办法在一个 `Agent` 实例活着的时候动态换掉它——`PlanModeController` 因此不是
 * "包一层 Agent、真的切断它的工具访问"，而是一个独立的**决策器**：`decide(toolName)`
 * 回答"这次调用在当前模式下允不允许"，调用方（未来某天真正把审批接进 `runTurn` 时)
 * 在真正执行工具调用之前去问它。这跟 Day19 `PermissionPreset` 本身"今天只交付判断
 * 逻辑,不接进 `runTurn`"是同一个纪律，见 study.md。
 */
export class PlanModeController {
  private mode: AgentMode = 'planning'
  private readonly transitions: ModeTransition[]

  constructor(private readonly presets: { readonly planning: PermissionPreset; readonly executing: PermissionPreset }, now: number = Date.now()) {
    this.transitions = [{ mode: 'planning', at: now }]
  }

  get currentMode(): AgentMode {
    return this.mode
  }

  get currentPreset(): PermissionPreset {
    return this.presets[this.mode]
  }

  /** 切换到另一个模式——切到当前已经在的模式是 no-op,不产生新的转换记录
   * （幂等，跟 Day6 `Agent.dispose()`/Day17 `JobRuntime.dispose()` 同一个心智模型）。 */
  switchTo(mode: AgentMode, now: number = Date.now()): void {
    if (mode === this.mode) return
    this.mode = mode
    this.transitions.push({ mode, at: now })
  }

  /** 这次工具调用在当前模式下允不允许——直接委托给当前模式对应的 preset,
   * `PlanModeController` 自己不重新发明判断规则。 */
  decide(toolName: string): PermissionDecision {
    return this.currentPreset.decide(toolName)
  }

  /** 完整的模式切换历史——审计用：想知道"这次危险操作发生时,Agent 是不是刚从
   * planning 切到 executing 没多久"这类问题,答案都在这里。 */
  get history(): readonly ModeTransition[] {
    return this.transitions
  }
}
