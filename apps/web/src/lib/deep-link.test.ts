import { describe, expect, it } from 'vitest'
import {
  boardElementPath,
  elementsLink,
  hasDeepLinkParam,
  legacyIdsOf,
  legacyPagesOf,
  legacyShapesLink,
  legacyViewBounds,
  linkBase,
  parseLegacyDeepLink,
  readDeepLink,
  resolveLegacyShapes,
  viewLink,
  withoutParams,
} from './deep-link.ts'

const BASE = 'https://lobby.example/b/brd_1'

describe('new links (?el=, ?view=)', () => {
  it('builds ?el= with readable commas and round-trips ids with dots and colons', () => {
    const ids = ['abcDEF_12-x', 'n1.t', 'x:y']
    const link = elementsLink(BASE, ids)
    expect(link).toBe(`${BASE}?el=abcDEF_12-x,n1.t,x%3Ay`)
    expect(readDeepLink(link)).toEqual({ kind: 'elements', ids })
  })

  it('leaves out ids that are not element ids, duplicates too; none left is the bare board', () => {
    expect(elementsLink(BASE, ['ok', 'ok', 'has,comma', 'sp ace'])).toBe(`${BASE}?el=ok`)
    expect(elementsLink(BASE, [])).toBe(BASE)
    expect(readDeepLink(`${BASE}?el=a,,b,a,%zz`)).toEqual({ kind: 'elements', ids: ['a', 'b'] })
    expect(readDeepLink(`${BASE}?el=,,`)).toBeNull()
  })

  it('builds and reads ?view= (rounded; a malformed or empty rectangle is no link)', () => {
    const link = viewLink(BASE, { x: -120.4, y: 30.6, w: 800, h: 450.2 })
    expect(link).toBe(`${BASE}?view=-120,31,800,450`)
    expect(readDeepLink(link)).toEqual({ kind: 'view', bounds: { x: -120, y: 31, w: 800, h: 450 } })
    expect(readDeepLink(`${BASE}?view=1,2,0,4`)).toBeNull()
    expect(readDeepLink(`${BASE}?view=1,2,x,4`)).toBeNull()
    expect(readDeepLink(`${BASE}?view=1,2,3`)).toBeNull()
  })

  it('prefers ?el= over ?view= over ?d=', () => {
    expect(readDeepLink(`${BASE}?d=sold&view=0,0,10,10&el=new`)?.kind).toBe('elements')
    expect(readDeepLink(`${BASE}?d=sold&view=0,0,10,10`)?.kind).toBe('view')
    expect(readDeepLink(`${BASE}?d=sold`)?.kind).toBe('legacy-shapes')
    expect(readDeepLink(BASE)).toBeNull()
    expect(readDeepLink('not a url')).toBeNull()
  })

  it('knows its parameters and strips them', () => {
    expect(hasDeepLinkParam(`${BASE}?el=a`)).toBe(true)
    expect(hasDeepLinkParam(`${BASE}?d=sa`)).toBe(true)
    expect(hasDeepLinkParam(`${BASE}?thread=t1`)).toBe(false)
    expect(hasDeepLinkParam(`${BASE}?view=review`)).toBe(false) // the review page's address (wave S)
    expect(hasDeepLinkParam(`${BASE}?view=0,0,10,10`)).toBe(true)
    expect(withoutParams(`${BASE}?el=a&thread=t1#x`, ['el', 'view', 'd'])).toBe('/b/brd_1?thread=t1#x')
    // wave S: ?view=review is the review page's address, never a deep link: it is not dropped (a viewport view is)
    expect(withoutParams(`${BASE}?view=review`, ['el', 'view', 'd'])).toBe('/b/brd_1?view=review')
    expect(withoutParams(`${BASE}?view=0,0,100,100&el=a`, ['el', 'view', 'd'])).toBe('/b/brd_1')
    expect(linkBase(`${BASE}?el=a#x`)).toBe(BASE)
  })
})

describe('wave N (N7-5): a board at one element', () => {
  it('builds /b/<id>?el=<id> (or the bare board) and reads back as the element link', () => {
    expect(boardElementPath('b-two0000001', 'card-1')).toBe('/b/b-two0000001?el=card-1')
    expect(boardElementPath('b-two0000001', null)).toBe('/b/b-two0000001')
    expect(boardElementPath('b-two0000001')).toBe('/b/b-two0000001')
    const withColon = boardElementPath('b-two0000001', 'n.1:x')
    expect(withColon).toBe('/b/b-two0000001?el=n.1%3Ax')
    expect(readDeepLink(new URL(withColon, BASE).toString())).toEqual({ kind: 'elements', ids: ['n.1:x'] })
  })

  it('a stored board-card path (its ?el= id unencoded) opens at that element too', () => {
    expect(readDeepLink(new URL('/b/b-two0000001?el=n.1:x', BASE).toString())).toEqual({
      kind: 'elements',
      ids: ['n.1:x'],
    })
    expect(hasDeepLinkParam(new URL('/b/b-two0000001?el=frame-1', BASE).toString())).toBe(true)
  })
})

describe('legacy tldraw links (?d=)', () => {
  // tldraw's own strings (createDeepLinkString) are checked against these in dashboard/search/content-search.test.ts
  it('builds the legacy shapes string (dots encoded) and reads it back from a URL', () => {
    const ids = ['shape:plain', 'shape:with.dot', 'shape:ünï', 'shape:a b']
    const ours = legacyShapesLink(ids)
    expect(ours).toBe('splain.with%2Edot.%C3%BCn%C3%AF.a%20b')
    const url = new URL(BASE)
    url.searchParams.set('d', ours)
    expect(readDeepLink(url.toString())).toEqual({
      kind: 'legacy-shapes',
      parts: ['plain', 'with.dot', 'ünï', 'a b'],
    })
  })

  it('reads viewport and page links (tldraw strings)', () => {
    const v = 'v-10.20.300.200.two'
    expect(parseLegacyDeepLink(v)).toEqual({
      kind: 'legacy-view',
      bounds: { x: -10, y: 20, w: 300, h: 200 },
      pageId: 'page:two',
    })
    expect(parseLegacyDeepLink('v1.2.3.4')).toEqual({
      kind: 'legacy-view',
      bounds: { x: 1, y: 2, w: 3, h: 4 },
      pageId: null,
    })
    const p = 'pthree'
    expect(parseLegacyDeepLink(p)).toEqual({ kind: 'legacy-page', pageId: 'page:three' })
    for (const bad of ['', 'x1', 's', 'v1.2.3', 'vA.2.3.4', 's%zz'])
      expect(parseLegacyDeepLink(bad)).toBeNull()
  })

  it('maps shape ids to live element ids: directly, through legacyIds, and a dotted list longest match first', () => {
    const live = new Set(['a', 'b', 'a.t', 'xk3', 'c.d.e'])
    const isLive = (id: string) => live.has(id)
    expect(resolveLegacyShapes(['a', 'b'], isLive)).toEqual(['a', 'b'])
    expect(resolveLegacyShapes(['gone', 'b'], isLive)).toEqual(['b'])
    // a hand-made link that did not encode the dots of 'c.d.e'
    expect(resolveLegacyShapes(['c', 'd', 'e', 'a'], isLive)).toEqual(['c.d.e', 'a'])
    // 'a.t' is live and longer than 'a'
    expect(resolveLegacyShapes(['a', 't'], isLive)).toEqual(['a.t'])
    // the converter renamed an unsafe tldraw id
    expect(resolveLegacyShapes(['we!rd'], isLive, { 'shape:we!rd': 'xk3' })).toEqual(['xk3'])
    expect(resolveLegacyShapes(['a', 'a'], isLive)).toEqual(['a'])
  })

  it('moves a viewport link by its page’s frozen offset', () => {
    const doc = {
      legacyPages: { 'page:page': { dx: 0, dy: 0 }, 'page:two': { dx: 4800, dy: -120 }, bad: { dx: 'x' } },
      legacyIds: { 'shape:a!': 'xa', n: 3 },
    }
    const pages = legacyPagesOf(doc)
    expect(pages).toEqual({ 'page:page': { dx: 0, dy: 0 }, 'page:two': { dx: 4800, dy: -120 } })
    expect(legacyIdsOf(doc)).toEqual({ 'shape:a!': 'xa' })
    const r = { x: 10, y: 20, w: 100, h: 50 }
    expect(legacyViewBounds(r, 'page:two', pages)).toEqual({ x: 4810, y: -100, w: 100, h: 50 })
    expect(legacyViewBounds(r, 'page:unknown', pages)).toEqual(r)
    expect(legacyViewBounds(r, null, pages)).toEqual(r)
    expect(legacyPagesOf(undefined)).toEqual({})
    expect(legacyIdsOf(null)).toEqual({})
  })
})
