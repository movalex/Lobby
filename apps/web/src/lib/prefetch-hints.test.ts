// K1-5 (wave K): lib/prefetch-board.ts, the title hints the board skeleton shows before the board answers.
// A link to a board that the person points at, focuses or presses leaves the board's title (the link's
// `data-board-title`, or the board card's title) and the workspace whose page it was on; the board page
// itself remembers a board it opened. In memory only, the latest wins.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boardTitleHint, installBoardPrefetch, rememberBoardTitle } from './prefetch-board.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const origin = 'https://lobby.example'
/** A link inside a board card, as the dashboard draws one (a card element with a title element). */
const cardLink = (href: string, card?: { title: string; own?: string }) => {
  const titleEl = card ? { getAttribute: (n: string) => (n === 'title' ? card.title : null) } : null
  const cardEl = card ? { querySelector: () => titleEl } : null
  const a = {
    getAttribute: (n: string) =>
      n === 'href' ? href : n === 'data-board-title' ? (card?.own ?? null) : null,
  }
  return {
    closest: (sel: string) => (sel === 'a[href]' ? a : sel.startsWith('[data-board-id=') ? cardEl : null),
  }
}

describe('title hints for the skeleton (K1-5)', () => {
  it('the delegation remembers the title of the board card the person reached, with the page’s workspace', () => {
    vi.stubGlobal('location', { origin, pathname: '/w/wsp_0123456789ab' })
    const handlers = new Map<string, (e: Event) => void>()
    const doc = {
      addEventListener: (t: string, fn: (e: Event) => void) => handlers.set(t, fn),
      removeEventListener: (t: string) => handlers.delete(t),
    }
    const off = installBoardPrefetch(doc as never, () => true)
    handlers.get('pointerover')?.({ target: cardLink('/b/b-hint0000001', { title: 'Q3 plan' }) } as never)
    expect(boardTitleHint('b-hint0000001')).toEqual({ title: 'Q3 plan', workspaceId: 'wsp_0123456789ab' })
    // the link's own data-board-title wins
    handlers.get('click')?.({
      target: cardLink('/b/b-hint0000002', { title: 'Card title', own: 'Own title' }),
    } as never)
    expect(boardTitleHint('b-hint0000002')?.title).toBe('Own title')
    // a link with nothing around it: no hint
    handlers.get('focusin')?.({ target: cardLink('/b/b-hint0000003') } as never)
    expect(boardTitleHint('b-hint0000003')).toBeNull()
    off()
  })

  it('kept per board, trimmed, the latest wins; nothing for an unknown board', () => {
    rememberBoardTitle('b-title00001', '  Retro  ', 'wsp_0123456789ab')
    expect(boardTitleHint('b-title00001')).toEqual({ title: 'Retro', workspaceId: 'wsp_0123456789ab' })
    rememberBoardTitle('b-title00001', 'Retro, renamed')
    expect(boardTitleHint('b-title00001')).toEqual({ title: 'Retro, renamed', workspaceId: null })
    rememberBoardTitle('b-title00001', '   ')
    expect(boardTitleHint('b-title00001')?.title).toBe('Retro, renamed')
    expect(boardTitleHint('b-nothing0001')).toBeNull()
  })

  it('bounded: the oldest hints go first', () => {
    for (let i = 0; i < 250; i++) rememberBoardTitle(`b-many${String(i).padStart(6, '0')}`, `Board ${i}`)
    expect(boardTitleHint('b-many000000')).toBeNull()
    expect(boardTitleHint('b-many000249')?.title).toBe('Board 249')
  })
})
