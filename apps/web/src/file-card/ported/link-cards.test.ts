import { BOARD_CARD_KIND, BOARD_CARD_LABEL } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { boardLinkOf } from '../../features/board-links/model.ts'
import {
  BOARD_CARD_H,
  canBoardCard,
  cardForUrl,
  hostOf,
  LINK_CARD_KIND,
  labelOf,
  linkContentHandler,
  linkOf,
  placeBoardCard,
  titleOf,
} from './link-cards.tsx'

const card = (link: unknown, kind: unknown = LINK_CARD_KIND, type = 'rectangle') =>
  ({ type, link, customData: { lobby: { kind } } }) as never

describe('D2: link cards', () => {
  it('a link card is a rectangle of kind link-card with an http(s) link (the converter’s too)', () => {
    expect(linkOf(card('https://example.com/a'))).toBe('https://example.com/a')
    expect(linkOf(card('http://example.com'))).toBe('http://example.com/')
    expect(linkOf(card('javascript:alert(1)'))).toBeNull()
    expect(linkOf(card('/b/board_1'))).toBeNull()
    expect(linkOf(card('https://example.com', 'highlight'))).toBeNull()
    expect(linkOf(card('https://example.com', LINK_CARD_KIND, 'ellipse'))).toBeNull()
    expect(linkOf({ type: 'rectangle', link: 'https://example.com' } as never)).toBeNull()
  })

  it('the label says the title, then the site; with no title, the site alone', () => {
    const url = 'https://www.example.com/brief'
    expect(hostOf(url)).toBe('example.com')
    expect(labelOf({ title: 'Q3 brief', siteName: 'Example', icon: null }, url)).toBe(
      'Q3 brief\nExample · example.com',
    )
    expect(labelOf({ title: 'Q3 brief', siteName: 'example.com', icon: null }, url)).toBe(
      'Q3 brief\nexample.com',
    )
    expect(labelOf({ title: null, siteName: null, icon: null }, url)).toBe('example.com')
    expect(titleOf('Q3 brief\nexample.com', url)).toBe('Q3 brief')
    expect(titleOf('', url)).toBe('example.com')
  })
})

const ORIGIN = 'https://lobby.example'
const PUBLIC = 'https://lobby.darkburn.com'

describe('N7-1: board cards from a pasted board link', () => {
  it('a /b/ URL of this Lobby makes a board card (the relative path stored); external URLs still make link cards', () => {
    expect(cardForUrl(`${ORIGIN}/b/b-two0000001`, [ORIGIN])).toEqual({
      kind: 'board-card',
      link: '/b/b-two0000001',
    })
    expect(cardForUrl(`${ORIGIN}/b/b-two0000001?el=frame-1`, [ORIGIN])).toEqual({
      kind: 'board-card',
      link: '/b/b-two0000001?el=frame-1',
    })
    // the deployment's public origin (VITE_PUBLIC_ORIGIN) counts as this Lobby too
    expect(cardForUrl(`${PUBLIC}/b/b-two0000001`, [ORIGIN, PUBLIC])).toEqual({
      kind: 'board-card',
      link: '/b/b-two0000001',
    })
    // the relative path itself
    expect(cardForUrl('/b/b-two0000001', [ORIGIN])).toEqual({ kind: 'board-card', link: '/b/b-two0000001' })
    expect(cardForUrl('https://example.com/brief', [ORIGIN])).toEqual({
      kind: 'link-card',
      url: 'https://example.com/brief',
    })
  })

  it('a foreign-origin /b/ URL makes a normal link card; a Lobby URL that is not exactly one board too', () => {
    expect(cardForUrl('https://evil.example/b/b-two0000001', [ORIGIN])).toEqual({
      kind: 'link-card',
      url: 'https://evil.example/b/b-two0000001',
    })
    for (const u of [
      `${ORIGIN}/b/b-two0000001?el=a,b`,
      `${ORIGIN}/b/b-two0000001?view=1,2,3,4`,
      `${ORIGIN}/b/b-two0000001#frame`,
      `${ORIGIN}/w/wsp_0123456789`,
    ])
      expect(cardForUrl(u, [ORIGIN])?.kind, u).toBe('link-card')
    // not a link at all: it stays text
    expect(cardForUrl('javascript:alert(1)', [ORIGIN])).toBeNull()
    expect(cardForUrl('/w/wsp_0123456789', [ORIGIN])).toBeNull()
  })

  it('boardLinkOf accepts relative paths only (an absolute URL, even this Lobby’s, is no stored board link)', () => {
    expect(boardLinkOf({ link: '/b/b-two0000001' })).toEqual({ boardId: 'b-two0000001', elementId: null })
    expect(boardLinkOf({ link: `${ORIGIN}/b/b-two0000001` })).toBeNull()
    expect(boardLinkOf({ link: '//evil.example/b/b-two0000001' })).toBeNull()
    expect(boardLinkOf({ link: 'b/b-two0000001' })).toBeNull()
  })

  it('places a board card that stores the path and the kind only: no title, no thumbnail, the label “Board link”', () => {
    const created: { type: string; props: Record<string, unknown> }[] = []
    const selected: string[][] = []
    const ctx = fakeCtx({ created, selected })
    const id = placeBoardCard(ctx, '/b/b-two0000001?el=frame-1', { x: 100, y: 100 })
    expect(created.map((c) => c.type)).toEqual(['rectangle', 'text'])
    const [rect, label] = created
    expect(rect?.props).toMatchObject({
      id,
      link: '/b/b-two0000001?el=frame-1',
      customData: { lobby: { kind: BOARD_CARD_KIND } },
      height: BOARD_CARD_H,
    })
    expect(label?.props).toMatchObject({
      text: BOARD_CARD_LABEL,
      originalText: BOARD_CARD_LABEL,
      containerId: id,
    })
    // nothing else about the target anywhere in what was created
    const all = JSON.stringify(created)
    expect(all).not.toMatch(/thumbnail|title|\/api\//i)
    expect(selected).toEqual([[id]])
  })

  it('anyone who can edit may add one (name-only guests too: the link is Lobby-relative); a viewer may not', () => {
    const editor = fakeCtx({ created: [], selected: [] })
    expect(canBoardCard(editor, '/b/b-two0000001')).toBe(true)
    expect(canBoardCard(editor, 'https://lobby.example/b/b-two0000001')).toBe(false)
    expect(canBoardCard(fakeCtx({ created: [], selected: [], readOnly: true }), '/b/b-two0000001')).toBe(
      false,
    )
  })

  it('the URL handler takes a board URL of this page’s origin as a board card, synchronously, with no preview fetch', () => {
    const created: { type: string; props: Record<string, unknown> }[] = []
    const ctx = fakeCtx({ created, selected: [] })
    const origin = 'http://localhost:3000'
    const g = globalThis as { location?: unknown; fetch?: unknown }
    const saved = { location: g.location, fetch: g.fetch }
    let fetched = 0
    g.location = { origin }
    g.fetch = () => {
      fetched++
      return Promise.reject(new Error('no fetch'))
    }
    try {
      expect(
        linkContentHandler.handle({ kind: 'url', url: `${origin}/b/b-two0000001` }, ctx, null, 'paste'),
      ).toBe(true)
    } finally {
      g.location = saved.location
      g.fetch = saved.fetch
    }
    expect(created[0]?.props).toMatchObject({
      link: '/b/b-two0000001',
      customData: { lobby: { kind: BOARD_CARD_KIND } },
    })
    expect(fetched).toBe(0)
  })
})

describe('P-017: a card inserted with no point lands in free space near the view’s centre', () => {
  const overlaps = (a: Record<string, unknown>, b: { x: number; y: number; width: number; height: number }) =>
    (a.x as number) < b.x + b.width &&
    b.x < (a.x as number) + (a.width as number) &&
    (a.y as number) < b.y + b.height &&
    b.y < (a.y as number) + (a.height as number)

  it('a note at the centre: the card goes beside it, not on it, and stays near the centre', () => {
    const created: { type: string; props: Record<string, unknown> }[] = []
    const note = { id: 'n1', type: 'stickynote', x: 400, y: 300, width: 200, height: 200 }
    const ctx = fakeCtx({ created, selected: [], items: [note] })
    placeBoardCard(ctx, '/b/b-two0000001', null)
    const rect = created[0]?.props ?? {}
    expect(overlaps(rect, note)).toBe(false)
    const cx = (rect.x as number) + (rect.width as number) / 2
    const cy = (rect.y as number) + (rect.height as number) / 2
    expect(Math.hypot(cx - 500, cy - 400)).toBeLessThan(500)
  })

  it('an empty view: the centre itself; a point given (a paste at the pointer) is kept as it is', () => {
    const created: { type: string; props: Record<string, unknown> }[] = []
    placeBoardCard(fakeCtx({ created, selected: [] }), '/b/b-two0000001', null)
    expect(created[0]?.props).toMatchObject({ x: 500 - 160, y: 400 - BOARD_CARD_H / 2 })
    const pasted: { type: string; props: Record<string, unknown> }[] = []
    const note = { id: 'n1', type: 'stickynote', x: 400, y: 300, width: 200, height: 200 }
    placeBoardCard(fakeCtx({ created: pasted, selected: [], items: [note] }), '/b/b-two0000001', {
      x: 500,
      y: 400,
    })
    expect(pasted[0]?.props).toMatchObject({ x: 500 - 160, y: 400 - BOARD_CARD_H / 2 })
  })
})

/** The parts of a feature context placing a card uses. */
function fakeCtx(opts: {
  created: { type: string; props: Record<string, unknown> }[]
  selected: string[][]
  readOnly?: boolean
  items?: { id: string; type: string; x: number; y: number; width: number; height: number }[]
}): CanvasFeatureContext {
  const els = opts.items ?? []
  const canvas = {
    readOnly: () => opts.readOnly ?? false,
    viewport: { get: () => ({ x: 0, y: 0, width: 1000, height: 800, zoom: 1 }) },
    text: { measure: (s: string) => ({ width: s.length * 8, height: 20 }) },
    items: () => els,
    get: (id: string) => els.find((e) => e.id === id),
    isLocked: () => false,
    isHidden: () => false,
    bounds: (id: string) => {
      const e = els.find((x) => x.id === id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    transact: (
      _label: string,
      fn: (tx: { create(type: string, props: Record<string, unknown>): void }) => void,
    ) => fn({ create: (type, props) => opts.created.push({ type, props }) }),
    select: (ids: string[]) => opts.selected.push(ids),
  }
  return {
    canvas,
    me: { user: { id: 'usr_editor000000001' } },
    registries: {},
  } as unknown as CanvasFeatureContext
}
