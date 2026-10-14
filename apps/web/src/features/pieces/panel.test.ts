// L8-3: the Pieces panel as a component, rendered to markup in Node (no DOM here): searching "dec" shows
// Decision first and marked active, a key moves the mark, the combobox points at the active option, and the
// markup is the panel's listbox of options.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { INITIAL, onKey, type PanelState, reduce, resultsOf } from './model.ts'
import { countText, optionId, PieceList } from './PiecesPanel.tsx'

const render = (s: PanelState, readonly = false) =>
  renderToStaticMarkup(
    createElement(PieceList, { base: 'p', results: resultsOf(s), active: s.active, readonly }),
  )

const options = (markup: string) => [...markup.matchAll(/<div [^>]*role="option"[^>]*>/g)].map((m) => m[0])

const typed = (query: string) => reduce(INITIAL, { type: 'query', query })

describe('the Pieces list', () => {
  it('shows Decision for "dec", as the active option of a listbox', () => {
    const m = render(typed('dec'))
    expect(m).toContain('role="listbox"')
    const opts = options(m)
    expect(opts[0]).toContain('data-piece-id="decision"')
    expect(opts[0]).toContain('aria-selected="true"')
    expect(opts[0]).toContain(`id="${optionId('p', 'decision')}"`)
    expect(m).toContain('Decision')
    expect(m).toContain('A question with a yes and a no.')
  })

  it('marks only the active option, and a key moves the mark', () => {
    let s = typed('d')
    const before = options(render(s))
    expect(before.filter((o) => o.includes('aria-selected="true"'))).toHaveLength(1)
    expect(before[0]).toContain('aria-selected="true"')
    s = onKey(s, 'ArrowDown').state
    const after = options(render(s))
    expect(after[0]).toContain('aria-selected="false"')
    expect(after[1]).toContain('aria-selected="true"')
    // the combobox would now point at the second option
    expect(optionId('p', resultsOf(s)[s.active]?.id ?? 'process')).toBe(after[1]?.match(/id="([^"]+)"/)?.[1])
  })

  it('makes every option draggable for an editor, and none for a viewer', () => {
    expect(options(render(INITIAL)).every((o) => o.includes('draggable="true"'))).toBe(true)
    const viewer = options(render(INITIAL, true))
    expect(viewer.every((o) => o.includes('draggable="false"') && o.includes('aria-disabled="true"'))).toBe(
      true,
    )
  })

  it('says shapes, not pieces, in what people read (the panel is named Shapes)', () => {
    expect(countText(1)).toBe('1 shape')
    expect(countText(0)).toBe('0 shapes')
    expect(countText(12)).toBe('12 shapes')
    expect(render(INITIAL).replace(/<[^>]*>/g, ' ')).not.toMatch(/\bpieces?\b/i)
  })

  it('says so when nothing matches', () => {
    expect(render(typed('zzzz'))).toContain('No shapes match.')
  })
})
