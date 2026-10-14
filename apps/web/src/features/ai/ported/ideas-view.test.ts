// P-041 (wave P): the ideas prompt ("Ideas with AI") opens on sticky notes, as the button says; the mind map is the
// other choice, not the default, whatever the board holds. The two choices sit in one row under their label.
import { describe, expect, it, vi } from 'vitest'
import { AiOverlay } from './Overlay.tsx'
import { aiMenu } from './runtime.ts'
import { NONE } from './target.ts'
import { aiKit, note, renderIn } from './test-kit.ts'

const openIdeas = (seed: Parameters<typeof aiKit>[0]) => {
  vi.stubGlobal('document', { activeElement: null, querySelector: () => null })
  const k = aiKit(seed)
  aiMenu(k.canvas).set({
    at: { x: 100, top: 100, bottom: 120 },
    view: 'ideas',
    target: NONE,
    pending: null,
  })
  return renderIn(k, AiOverlay)
}
const checked = (html: string, testId: string) =>
  new RegExp(`<input[^>]*data-testid="${testId}"[^>]*checked`).test(html)

describe('P-041: the ideas prompt', () => {
  it('opens on sticky notes on an empty board (it used to open on a mind map there)', () => {
    const html = openIdeas([])
    expect(html).toContain('data-testid="ai-ideas-as-notes"')
    expect(checked(html, 'ai-ideas-as-notes')).toBe(true)
    expect(checked(html, 'ai-ideas-as-map')).toBe(false)
    expect(html).toContain('How many')
    expect(html).toContain('>Generate<')
  })

  it('opens on sticky notes on a board with content too', () => {
    const html = openIdeas(note('n1', 0, 0, 'Summer'))
    expect(checked(html, 'ai-ideas-as-notes')).toBe(true)
    expect(checked(html, 'ai-ideas-as-map')).toBe(false)
  })

  it('puts the two choices in one row under "Show them as"', () => {
    const html = openIdeas([])
    expect(html).toMatch(
      /Show them as<\/legend><div class="dr-ai-form__choices">(?:(?!<\/div>).)*ai-ideas-as-notes(?:(?!<\/div>).)*ai-ideas-as-map/s,
    )
  })
})
