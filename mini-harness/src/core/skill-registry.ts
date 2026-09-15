/**
 * 一份按需加载的过程知识——跟 Day4 `ToolDefinition` 不一样：工具是"模型能调用的动作"，
 * skill 是"喂进系统提示词、教模型怎么做某件事的一段文字",模型自己不能"调用"它,
 * 只能读到它、照着做。
 */
export interface SkillDefinition {
  readonly name: string
  readonly description: string
  /** 触发关键词——`match()` 用纯字符串包含判断这次用户消息该不该加载这个 skill。
   * 不做语义/模糊匹配（没有向量库,也不打算为了这个引入一个新依赖）——诚实的缺口，
   * 见 study.md。 */
  readonly triggerKeywords: readonly string[]
  /** 加载之后真正塞进系统提示词的内容。 */
  readonly body: string
}

export class DuplicateSkillError extends Error {
  constructor(name: string) {
    super(`duplicate skill registration: "${name}"`)
    this.name = 'DuplicateSkillError'
  }
}

/**
 * 全部塞进系统提示词（Day11 `buildSystemPrompt` 原本的做法）vs 按需匹配加载——
 * 前者简单，但 skill 数量一多，系统提示词的体积会跟着线性增长，哪怕这一轮对话
 * 根本用不上大多数 skill。`SkillRegistry` 选的是后者：只有用户消息里出现了触发
 * 关键词的 skill 才会被选中，不相关的 skill 完全不占用这一轮的提示词空间。
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillDefinition>()

  define(skill: SkillDefinition): void {
    if (this.skills.has(skill.name)) throw new DuplicateSkillError(skill.name)
    this.skills.set(skill.name, skill)
  }

  has(name: string): boolean {
    return this.skills.has(name)
  }

  /** 给一条用户消息文本，返回触发关键词命中的全部 skill——不做排序/截断，
   * 那是 `selectSkillsWithinBudget()` 的事。 */
  match(userMessageText: string): readonly SkillDefinition[] {
    const lower = userMessageText.toLowerCase()
    return [...this.skills.values()].filter((skill) => skill.triggerKeywords.some((keyword) => lower.includes(keyword.toLowerCase())))
  }
}

/**
 * 从命中的 skill 里,按 `body` 的字符数贪心挑选,直到超出预算为止——这里故意用
 * "字符数"而不是"token 数"当预算单位：这个项目里没有任何地方实现过真实的 token
 * 估算（`TokenMeter`，Day12，记录的是 provider **事后**报告的真实用量，不是
 * 请求前的预估），伪造一个"看起来像 token 数"的估算函数只会制造一种虚假的精确感。
 * 字符数是诚实的替代指标：不精确,但至少不假装自己是别的东西。
 */
export function selectSkillsWithinBudget(matched: readonly SkillDefinition[], maxBodyChars: number): readonly SkillDefinition[] {
  const selected: SkillDefinition[] = []
  let used = 0
  for (const skill of matched) {
    const cost = skill.body.length
    if (used + cost > maxBodyChars) continue
    selected.push(skill)
    used += cost
  }
  return selected
}
