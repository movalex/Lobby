// Wave P (P-004): a board with no picture yet gets one neutral placeholder, the same in every view, never a drawing that
// could pass for the board's content (mind maps, flowcharts, note layouts).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BoardCardThumb, BoardThumb } from './BoardCard.tsx'
import { thumbStyle } from './model.ts'

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el)

describe('the placeholder of a board without a thumbnail', () => {
  it('says "No preview yet" and shows the board’s initials, with a tint that is the board’s own', () => {
    const out = html(createElement(BoardThumb, { boardId: 'b-3k9x0q2m7a', title: 'Festival booth plan' }))
    expect(out).toContain('data-testid="board-thumb-placeholder"')
    expect(out).toContain('No preview yet')
    expect(out).toContain('>FB<')
    expect(out).toContain(`fill="${thumbStyle('b-3k9x0q2m7a').bg}"`)
  })

  it('is the same picture every time for a board (Recent, All boards, a reload)', () => {
    const one = html(createElement(BoardThumb, { boardId: 'b-aaaaaaaaaa', title: 'Retro' }))
    expect(html(createElement(BoardThumb, { boardId: 'b-aaaaaaaaaa', title: 'Retro' }))).toBe(one)
    const card = (status: 'active' | 'archived') =>
      html(
        createElement(BoardCardThumb, {
          board: { id: 'b-aaaaaaaaaa', title: 'Retro', status, thumbnailVersion: null },
        }),
      )
    expect(card('active')).toBe(one)
    expect(card('archived')).toBe(one)
  })

  it('draws no content: no paths, no notes, no connectors, no cards', () => {
    for (let i = 0; i < 12; i++) {
      const out = html(createElement(BoardThumb, { boardId: `b-${i}xxxxxxxxx`, title: 'Plan' }))
      expect(out).not.toContain('<path')
      expect(out).not.toContain('<circle')
      expect(out).not.toContain('dr-thumb__note')
      expect(out).not.toContain('dr-thumb__card')
      expect((out.match(/<rect/g) ?? []).length).toBe(1)
    }
  })

  it('an untitled board has a neutral frame glyph, not the letters "UB"', () => {
    const out = html(createElement(BoardThumb, { boardId: 'b-1', title: 'Untitled board' }))
    expect(out).not.toContain('>UB<')
    expect(out).not.toContain('board-thumb-initials')
    expect(out).toContain('No preview yet')
  })

  it('a trashed board shows it too, and a board with a picture shows the picture instead', () => {
    const cardOf = (status: 'active' | 'trashed') =>
      html(
        createElement(BoardCardThumb, {
          board: { id: 'b-2', title: 'Old', status, thumbnailVersion: 'v1' },
        }),
      )
    expect(cardOf('trashed')).toContain('board-thumb-placeholder')
    const withPicture = cardOf('active')
    expect(withPicture).toContain('data-testid="board-thumbnail"')
    expect(withPicture).not.toContain('No preview yet')
  })
})
