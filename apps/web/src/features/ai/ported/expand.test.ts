// K7-1: what "Expand with AI" asks for (./expand.ts): the topic's words as the prompt, cut to the 200-character
// cap of the existing 'ideas' action, and the topic's path (with its children) as the context.
import { AI_MAX_REQUEST_SHAPES, AI_PROMPT_MAX_CHARS, AiRunInput } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { MindmapRuntime } from '../../mindmap/ported/runtime.ts'
import { type El, fakeMapCanvas, measure } from '../../mindmap/test-canvas.ts'
import { EXPAND_CONTEXT_CHILDREN, EXPAND_COUNT, expandPlan, promptOf } from './expand.ts'
import { refOf } from './target.ts'

function mapOf(...children: [string, ...string[]][]) {
  const f = fakeMapCanvas()
  const rt = new MindmapRuntime(f.canvas, (text, size) => measure(text, size))
  const built = rt.createMapFromOutline({
    text: 'Launch',
    children: children.map(([text, ...kids]) => ({
      text,
      children: kids.map((k) => ({ text: k, children: [] })),
    })),
  })
  if (!built) throw new Error('no map')
  const idOf = (text: string) => {
    const hit = [...f.els.values()].find(
      (e) => !e.isDeleted && e.type !== 'text' && f.canvas.text.of(e.id) === text,
    )
    if (!hit) throw new Error(`no topic ${text}`)
    return hit.id
  }
  return { f, rt, idOf }
}

describe('promptOf: the topic words as the ideas prompt', () => {
  it('one line, trimmed', () => {
    expect(promptOf('  Channels \n and   press  ')).toBe('Channels and press')
  })

  it('cut to the 200-character cap of the existing action, and the contract accepts it', () => {
    const long = `${'word '.repeat(80)}end`
    const p = promptOf(long)
    expect(p.length).toBeLessThanOrEqual(AI_PROMPT_MAX_CHARS)
    expect(p.length).toBe(AI_PROMPT_MAX_CHARS - 1) // the cut lands after a space, which is trimmed
    expect(long.startsWith(p)).toBe(true)
    expect(
      AiRunInput.safeParse({ action: 'ideas', shapeIds: [], prompt: p, count: EXPAND_COUNT }).success,
    ).toBe(true)
  })

  it('never ends on half of an emoji (UTF-16 units, as the contract counts)', () => {
    const p = promptOf(`${'a'.repeat(199)}😀 and more`)
    expect(p).toBe('a'.repeat(199))
    expect(AiRunInput.safeParse({ action: 'ideas', shapeIds: [], prompt: p, count: 5 }).success).toBe(true)
    expect(promptOf('😀'.repeat(150)).length).toBeLessThanOrEqual(AI_PROMPT_MAX_CHARS)
  })
})

describe('expandPlan: the path and the children are the context', () => {
  it('the path from the central topic to the topic, then the topic’s children', () => {
    const { rt, idOf } = mapOf(['Audience', 'Fans', 'Press'], ['Channels'])
    const plan = expandPlan(rt, idOf('Audience'))
    if ('problem' in plan) throw new Error(plan.problem)
    expect(plan.path).toEqual([idOf('Launch'), idOf('Audience')])
    expect(plan.context).toEqual([idOf('Launch'), idOf('Audience'), idOf('Fans'), idOf('Press')])
    expect(plan.prompt).toBe('Audience')
    expect(plan.label).toBe('the topic “Audience”')
    // every one is an object ref the api reads
    expect(plan.context.map(refOf).every((r) => r.startsWith('shape:'))).toBe(true)
  })

  it('a deeper topic carries its whole path', () => {
    const { rt, idOf } = mapOf(['Audience', 'Fans'])
    const plan = expandPlan(rt, idOf('Fans'))
    if ('problem' in plan) throw new Error(plan.problem)
    expect(plan.path).toEqual([idOf('Launch'), idOf('Audience'), idOf('Fans')])
  })

  it('the central topic expands too (its path is itself)', () => {
    const { rt, idOf } = mapOf(['A'], ['B'])
    const plan = expandPlan(rt, idOf('Launch'))
    if ('problem' in plan) throw new Error(plan.problem)
    expect(plan.path).toEqual([idOf('Launch')])
    expect(plan.context).toEqual([idOf('Launch'), idOf('A'), idOf('B')])
  })

  it('caps the context: at most 20 children, and never more than a request may name', () => {
    const kids = Array.from({ length: 30 }, (_, i) => `k${i}`)
    const { rt, idOf } = mapOf(['Hub', ...kids] as [string, ...string[]])
    const plan = expandPlan(rt, idOf('Hub'))
    if ('problem' in plan) throw new Error(plan.problem)
    expect(plan.context).toHaveLength(2 + EXPAND_CONTEXT_CHILDREN)
    expect(plan.context.length).toBeLessThanOrEqual(AI_MAX_REQUEST_SHAPES)
  })

  it('an empty topic or a topic that is gone cannot be expanded', () => {
    const { f, rt, idOf } = mapOf(['Filled'])
    const root = idOf('Launch')
    const label = f.els.get(root)?.boundElements as { id: string }[]
    f.els.set(label[0]?.id as string, { ...(f.els.get(label[0]?.id as string) as El), originalText: '  ' })
    expect(expandPlan(rt, root)).toEqual({ problem: 'empty' })
    expect(expandPlan(rt, 'nope')).toEqual({ problem: 'gone' })
  })
})
