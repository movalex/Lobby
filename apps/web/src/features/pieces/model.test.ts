// L8-3: the Pieces panel's state and keys. 'dec' finds Decision first; the arrow keys move the active piece
// and wrap, Enter inserts it; Escape clears a query, then closes; a drop's text names a piece or nothing.
import { PIECES } from '@draftroom/templates/pieces/catalog'
import { describe, expect, it } from 'vitest'
import { dragPayload, INITIAL, onKey, type PanelState, pieceOfDrop, reduce, resultsOf } from './model.ts'

const typed = (query: string): PanelState => reduce(INITIAL, { type: 'query', query })

describe('searching', () => {
  it('lists every piece before anything is typed, and narrows by category', () => {
    expect(resultsOf(INITIAL)).toHaveLength(PIECES.length)
    expect(resultsOf(reduce(INITIAL, { type: 'category', category: 'agency' })).map((p) => p.id)).toEqual([
      'shot',
      'storyboard',
      'persona',
      'stage',
    ])
  })

  it('finds Decision for "dec", first', () => {
    const s = typed('dec')
    expect(resultsOf(s)[0]?.id).toBe('decision')
    expect(s.active).toBe(0)
  })

  it('starts again from the first piece when the query or the category changes', () => {
    let s = typed('d')
    s = reduce(s, { type: 'move', by: 1 })
    expect(s.active).toBe(1)
    expect(reduce(s, { type: 'query', query: 'da' }).active).toBe(0)
    expect(reduce(s, { type: 'category', category: 'flowchart' }).active).toBe(0)
  })
})

describe('the keys in the search box', () => {
  it('Enter inserts the active piece: "dec" then Enter makes a Decision', () => {
    const r = onKey(typed('dec'), 'Enter')
    expect(r).toMatchObject({ handled: true, insert: 'decision' })
  })

  it('the arrow keys move the active piece, wrapping at both ends, and Enter inserts the one they stopped on', () => {
    let s = typed('d')
    const ids = resultsOf(s).map((p) => p.id)
    expect(ids.length).toBeGreaterThan(2)
    s = onKey(s, 'ArrowDown').state
    expect(onKey(s, 'Enter').insert).toBe(ids[1])
    s = onKey(s, 'ArrowDown').state
    expect(onKey(s, 'Enter').insert).toBe(ids[2])
    // up from the first wraps to the last
    s = typed('d')
    s = onKey(s, 'ArrowUp').state
    expect(onKey(s, 'Enter').insert).toBe(ids.at(-1))
    // and down from the last wraps to the first
    s = onKey(s, 'ArrowDown').state
    expect(onKey(s, 'Enter').insert).toBe(ids[0])
  })

  it('Home and End mean the first and the last piece only when nothing is typed (otherwise they move the caret)', () => {
    expect(onKey(INITIAL, 'End')).toMatchObject({ handled: true, state: { active: PIECES.length - 1 } })
    expect(onKey(onKey(INITIAL, 'End').state, 'Home').state.active).toBe(0)
    expect(onKey(typed('d'), 'End').handled).toBe(false)
    expect(onKey(typed('d'), 'Home').handled).toBe(false)
  })

  it('Enter with no match inserts nothing, and says it used the key', () => {
    const r = onKey(typed('zzzz'), 'Enter')
    expect(r.insert).toBeUndefined()
    expect(r.handled).toBe(true)
    expect(onKey(typed('zzzz'), 'ArrowDown').state.active).toBe(0)
  })

  it('Escape clears what is typed, then closes the panel', () => {
    const r = onKey(typed('dec'), 'Escape')
    expect(r.state.query).toBe('')
    expect(r.close).toBeUndefined()
    expect(onKey(r.state, 'Escape').close).toBe(true)
  })

  it('leaves every other key to the search box', () => {
    for (const k of ['a', 'Backspace', 'Tab', 'ArrowLeft', ' ']) expect(onKey(INITIAL, k).handled).toBe(false)
  })
})

describe('the drag payload', () => {
  it('round-trips a piece id, and refuses any other text', () => {
    for (const p of PIECES) expect(pieceOfDrop(dragPayload(p.id))).toBe(p.id)
    expect(pieceOfDrop(`  ${dragPayload('button')}  `)).toBe('button')
    for (const t of [
      '',
      'button',
      'lobby-piece:',
      'lobby-piece:nope',
      'lobby-piece:button x',
      'some notes\nand more',
    ])
      expect(pieceOfDrop(t)).toBeNull()
  })
})
