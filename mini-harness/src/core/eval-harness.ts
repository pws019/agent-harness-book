import { runInvestigation, type InvestigationOutcome } from '../cli.js'
import { LlmAdapter } from '../llm/adapter.js'
import { mulberry32, streamFake } from '../llm/fake-adapter.js'
import type { Message, StreamChunk } from '../llm/types.js'

/**
 * 一个场景要检查的具体断言——判别联合，不是一堆可选字段拼出来的模糊校验器。
 * 三选一覆盖大纲要的"离线场景集 + contract test"最常见的三类检查：最终文本
 * 有没有提到该提到的证据、有没有调用该调用的工具、有没有以预期的方式收尾。
 */
export type ScenarioAssertion =
  | { readonly kind: 'final-text-includes'; readonly substring: string }
  | { readonly kind: 'tool-called'; readonly name: string }
  | { readonly kind: 'stop-reason'; readonly expected: 'completed' | 'cancelled' | 'budget_exhausted' | 'error' }

export function assertNeverAssertion(value: never): never {
  throw new Error(`Unhandled ScenarioAssertion variant: ${JSON.stringify(value)}`)
}

/** 一个离线场景——直接复用 `cli.ts` 的 `runInvestigation()`，不是重新发明一套
 * "怎么跑一次调查"的机制。`workspace` 由调用方自己建好、自己清理（`EvalHarness`
 * 不接管 fixture 的生命周期,跟测试文件里已有的 `mkdtempSync`/`afterEach` 模式
 * 保持一致,不重复发明）。 */
export interface Scenario {
  readonly name: string
  readonly workspace: string
  readonly goal: string
  readonly query: string
  readonly maxSteps?: number
  readonly assertions: readonly ScenarioAssertion[]
}

export interface AssertionResult {
  readonly assertion: ScenarioAssertion
  readonly passed: boolean
  readonly detail: string
}

export interface ScenarioResult {
  readonly scenario: string
  readonly passed: boolean
  readonly assertions: readonly AssertionResult[]
  readonly outcome: InvestigationOutcome
}

function checkAssertion(assertion: ScenarioAssertion, outcome: InvestigationOutcome): AssertionResult {
  switch (assertion.kind) {
    case 'final-text-includes': {
      const passed = outcome.summary.includes(assertion.substring)
      return { assertion, passed, detail: passed ? `final text contains "${assertion.substring}"` : `final text does NOT contain "${assertion.substring}"` }
    }
    case 'tool-called': {
      const passed = outcome.record.events.some((event) => event.type === 'tool-call' && event.toolCall.name === assertion.name)
      return { assertion, passed, detail: passed ? `tool "${assertion.name}" was called` : `tool "${assertion.name}" was never called` }
    }
    case 'stop-reason': {
      const passed = outcome.record.stopReason.kind === assertion.expected
      return { assertion, passed, detail: `stopReason.kind was "${outcome.record.stopReason.kind}", expected "${assertion.expected}"` }
    }
    default:
      return assertNeverAssertion(assertion)
  }
}

/** 跑一次场景,对着真实产出的 `InvestigationOutcome`（`outcome.summary`/`outcome.record`）
 * 逐条校验断言——不是校验一段编好的预期输出,是校验一次真实调查真的做到了什么。 */
export async function runScenario(
  scenario: Scenario,
  adapterFactory?: (query: string) => LlmAdapter,
): Promise<ScenarioResult> {
  const outcome = await runInvestigation(
    { workspace: scenario.workspace, goal: scenario.goal, query: scenario.query, ...(scenario.maxSteps ? { maxSteps: scenario.maxSteps } : {}) },
    adapterFactory,
  )
  const assertions = scenario.assertions.map((assertion) => checkAssertion(assertion, outcome))
  return { scenario: scenario.name, passed: assertions.every((a) => a.passed), assertions, outcome }
}

export interface EvalReport {
  readonly results: readonly ScenarioResult[]
  readonly passCount: number
  readonly totalCount: number
}

/** 依次跑完一整个场景集，聚合成一份报告——场景之间没有共享状态，顺序跑（不并发）
 * 是为了让失败的场景更容易定位是哪一个,不是性能考虑。 */
export async function runScenarioSet(scenarios: readonly Scenario[], adapterFactory?: (query: string) => LlmAdapter): Promise<EvalReport> {
  const results: ScenarioResult[] = []
  for (const scenario of scenarios) results.push(await runScenario(scenario, adapterFactory))
  return { results, passCount: results.filter((r) => r.passed).length, totalCount: results.length }
}

export interface SampleReport {
  readonly scenario: string
  readonly samples: number
  readonly passCount: number
  readonly passRate: number
}

/** "模型抽样评测"——同一个场景跑 n 次，聚合出通过率。诚实记录：这门课至今只有
 * `HeuristicInvestigationAdapter` 这一种完全确定性的 adapter，用它跑 `sampleScenario()`
 * 只会得到 100% 或 0% 的通过率（每次结果完全一样），没法演示"抽样"真正要解决的
 * 问题——同一个 prompt 面对一个有真实变动性的 provider,多次运行结果可能不同。
 * `createFlakySampleAdapter()` 是专门为了证明"聚合通过率"这条计算路径本身是对的
 * 而造的合成 adapter，不代表这门课接入了真实的非确定性 provider。 */
export async function sampleScenario(scenario: Scenario, samples: number, adapterFactory: (query: string) => LlmAdapter): Promise<SampleReport> {
  let passCount = 0
  for (let i = 0; i < samples; i++) {
    const result = await runScenario(scenario, adapterFactory)
    if (result.passed) passCount++
  }
  return { scenario: scenario.name, samples, passCount, passRate: passCount / samples }
}

/**
 * 一个带种子随机性的合成 adapter——每次 `stream()` 调用按种子伪随机决定"这次假装
 * 调查成功还是失败"（成功：正常调用 `list_files`/`search_text` 走一遍真实工具链；
 * 失败：直接返回一句不包含任何证据的空洞总结,让 `final-text-includes` 断言必然
 * 落空）。复用 Day2/3 就有的 `mulberry32` 种子 PRNG——跟 `fault-injecting-transport.ts`
 * （Day23）同一个"确定性伪随机，同一个种子永远复现同样的结果序列"手法，只是这次
 * 用来演示 `sampleScenario()` 的聚合逻辑，不是模拟网络故障。
 */
export function createFlakySampleAdapter(seed: number, successProbability: number): (query: string) => LlmAdapter {
  const rand = mulberry32(seed)
  return (_query: string) => new FlakyAdapter(rand() < successProbability)
}

function toolCallMessage(id: string, name: string, args: unknown): Message {
  return { role: 'assistant', blocks: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] }
}

function textMessage(text: string): Message {
  return { role: 'assistant', blocks: [{ type: 'text', text }] }
}

class FlakyAdapter extends LlmAdapter {
  private step = 0
  constructor(private readonly succeeds: boolean) {
    super()
  }

  async *stream(): AsyncIterable<StreamChunk> {
    this.step += 1
    if (!this.succeeds) {
      yield* streamFake({ message: textMessage('investigation inconclusive, nothing located'), finishReason: { kind: 'stop' } })
      return
    }
    if (this.step === 1) {
      yield* streamFake({ message: toolCallMessage('call-list', 'list_files', {}), finishReason: { kind: 'tool-calls' } })
      return
    }
    yield* streamFake({ message: textMessage('investigation complete, evidence found in files'), finishReason: { kind: 'stop' } })
  }
}
