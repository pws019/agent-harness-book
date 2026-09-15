import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../src/core/system-prompt.js'
import { DuplicateSkillError, SkillRegistry, selectSkillsWithinBudget } from '../src/core/skill-registry.js'

describe('SkillRegistry: on-demand matching, not "include everything"', () => {
  it('a user message that mentions a trigger keyword matches that skill', () => {
    const registry = new SkillRegistry()
    registry.define({ name: 'git-commit', description: 'x', triggerKeywords: ['commit', 'git commit'], body: 'body-a' })
    registry.define({ name: 'unrelated', description: 'x', triggerKeywords: ['xyz'], body: 'body-b' })

    const matched = registry.match('please help me commit this change')
    expect(matched.map((s) => s.name)).toEqual(['git-commit'])
  })

  it('matching is case-insensitive', () => {
    const registry = new SkillRegistry()
    registry.define({ name: 'skill', description: 'x', triggerKeywords: ['Deploy'], body: 'b' })
    expect(registry.match('please deploy this')).toHaveLength(1)
  })

  it('a message with no matching keywords loads nothing', () => {
    const registry = new SkillRegistry()
    registry.define({ name: 'skill', description: 'x', triggerKeywords: ['deploy'], body: 'b' })
    expect(registry.match('what is the weather')).toEqual([])
  })

  it('registering the same name twice throws instead of silently overwriting', () => {
    const registry = new SkillRegistry()
    registry.define({ name: 'a', description: 'x', triggerKeywords: [], body: 'b' })
    expect(() => registry.define({ name: 'a', description: 'y', triggerKeywords: [], body: 'c' })).toThrow(DuplicateSkillError)
  })
})

describe('selectSkillsWithinBudget: a greedy character-count cap, not a fake token estimate', () => {
  it('skills that together exceed the budget are trimmed, earlier ones win', () => {
    const skills = [
      { name: 'a', description: 'x', triggerKeywords: [], body: 'x'.repeat(50) },
      { name: 'b', description: 'x', triggerKeywords: [], body: 'x'.repeat(50) },
      { name: 'c', description: 'x', triggerKeywords: [], body: 'x'.repeat(50) },
    ]
    const selected = selectSkillsWithinBudget(skills, 100)
    expect(selected.map((s) => s.name)).toEqual(['a', 'b']) // 50+50=100 刚好装下，第三个装不下
  })

  it('a skill that alone exceeds the budget is skipped, later smaller ones still get a chance', () => {
    const skills = [
      { name: 'huge', description: 'x', triggerKeywords: [], body: 'x'.repeat(200) },
      { name: 'small', description: 'x', triggerKeywords: [], body: 'x'.repeat(10) },
    ]
    const selected = selectSkillsWithinBudget(skills, 100)
    expect(selected.map((s) => s.name)).toEqual(['small'])
  })
})

describe('integration: matched skills actually show up in the assembled system prompt', () => {
  it('buildSystemPrompt renders a Loaded skills section only when skills is non-empty', () => {
    const registry = new SkillRegistry()
    registry.define({ name: 'git-commit', description: 'x', triggerKeywords: ['commit'], body: 'always write imperative commit messages' })

    const matched = registry.match('help me commit this')
    const withSkills = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: [], skills: matched })
    expect(withSkills).toContain('# Loaded skills')
    expect(withSkills).toContain('always write imperative commit messages')

    const withoutSkills = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: [] })
    expect(withoutSkills).not.toContain('# Loaded skills')

    const emptyMatch = buildSystemPrompt({ identity: 'x', workspaceRoot: '/repo', tools: [], skills: [] })
    expect(emptyMatch).not.toContain('# Loaded skills')
  })
})
