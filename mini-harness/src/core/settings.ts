/** 固定的四层，优先级从低到高——数组里靠后的层覆盖靠前的层。 */
export type SettingsLayerName = 'default' | 'deployment' | 'workspace' | 'user'

export interface SettingsLayer {
  readonly source: SettingsLayerName
  readonly values: Readonly<Record<string, unknown>>
}

/** 合并之后每个 key 不只有最终值，还留着"这个值是哪一层给的"——这是跟"直接
 * `Object.assign` 拼一遍"唯一的区别，但正是这一点让"为什么是这个值"可以被追溯。 */
export interface ResolvedSetting {
  readonly value: unknown
  readonly source: SettingsLayerName
}

export function mergeSettings(layers: readonly SettingsLayer[]): Readonly<Record<string, ResolvedSetting>> {
  const result: Record<string, ResolvedSetting> = {}
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      result[key] = { value, source: layer.source }
    }
  }
  return result
}
