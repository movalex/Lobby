import { describe, expect, it } from 'vitest'
import { parseLegacyDeepLink, readDeepLink } from '../../lib/deep-link.ts'
import {
  contentSearchApplies,
  HIT_LINK_FORMAT,
  hitHref,
  isSearchable,
  kindLabel,
  pendingNote,
  scopeForSection,
  searchKey,
  shapesDeepLink,
  summary,
} from './content-search.ts'

describe('content search helpers', () => {
  it('covers the list on screen, and nothing in the trash', () => {
    expect(scopeForSection({ kind: 'recent' })).toEqual({ status: 'active', projectId: null })
    expect(scopeForSection({ kind: 'all' })).toEqual({ status: 'active', projectId: null })
    expect(scopeForSection({ kind: 'project', projectId: 'prj_AAAAAAAAAAAA' })).toEqual({
      status: 'active',
      projectId: 'prj_AAAAAAAAAAAA',
    })
    expect(scopeForSection({ kind: 'archived' })).toEqual({ status: 'archived', projectId: null })
    expect(scopeForSection({ kind: 'trash' })).toBeNull()
  })

  it('searches only for words of two or more letters, within the length limit', () => {
    expect(isSearchable('ze')).toBe(true)
    expect(isSearchable('  a  ')).toBe(false)
    expect(isSearchable('a b !')).toBe(false)
    expect(isSearchable('a bc')).toBe(true)
    expect(isSearchable('東京')).toBe(true)
    expect(isSearchable('z'.repeat(201))).toBe(false)
  })

  it('builds the legacy deep link as tldraw 5.4.2 did (checked against its strings on 2026-09-30), and it round-trips', () => {
    // createDeepLinkString({ type: 'shapes', shapeIds }) of tldraw 5.4.2: 's' + the ids without 'shape:',
    // URI-encoded with '.' as %2E, joined by '.'
    const cases: [string[], string][] = [
      [['shape:abc123'], 'sabc123'],
      [['shape:with.dots'], 'swith%2Edots'],
      [['shape:ünï cødé/?&#'], 's%C3%BCn%C3%AF%20c%C3%B8d%C3%A9%2F%3F%26%23'],
      [['shape:a', 'shape:b'], 'sa.b'],
    ]
    for (const [ids, theirs] of cases) {
      const ours = shapesDeepLink(ids)
      expect(ours).toBe(theirs)
      expect(parseLegacyDeepLink(ours)).toEqual({
        kind: 'legacy-shapes',
        parts: ids.map((id) => id.replace(/^shape:/, '')),
      })
    }
  })

  it('opens shapes with ?el= (the one board page since wave 4 part 2) and comments with ?thread=', () => {
    expect(HIT_LINK_FORMAT).toBe('el')
    expect(hitHref('b-board1', { kind: 'note', objectId: 'shape:n1' })).toBe('/b/b-board1?el=n1')
    expect(hitHref('b-board1', { kind: 'frame', objectId: 'shape:a.b' })).toBe('/b/b-board1?el=a.b')
    expect(hitHref('b-board1', { kind: 'comment', objectId: 'thr_AAAAAAAAAAAA' })).toBe(
      '/b/b-board1?thread=thr_AAAAAAAAAAAA',
    )
    expect(hitHref('b-board1', { kind: 'resolved-comment', objectId: 'thr_AAAAAAAAAAAA' })).toBe(
      '/b/b-board1?thread=thr_AAAAAAAAAAAA',
    )
    // the legacy format is still built on request (dots encoded, then URL-encoded again in the query)
    expect(hitHref('b-board1', { kind: 'frame', objectId: 'shape:a.b' }, 'd')).toBe('/b/b-board1?d=sa%252Eb')
    const url = new URL(hitHref('b-board1', { kind: 'frame', objectId: 'shape:a.b' }, 'd'), 'http://x')
    expect(parseLegacyDeepLink(url.searchParams.get('d') ?? '')).toEqual({
      kind: 'legacy-shapes',
      parts: ['a.b'],
    })
  })

  it('on the new canvas: ?el=<element id> (dots kept, the board page also reads the legacy ?d=)', () => {
    expect(hitHref('b-board1', { kind: 'note', objectId: 'shape:n1' }, 'el')).toBe('/b/b-board1?el=n1')
    const href = hitHref('b-board1', { kind: 'frame', objectId: 'shape:a.b' }, 'el')
    expect(href).toBe('/b/b-board1?el=a.b')
    expect(readDeepLink(new URL(href, 'http://x').toString())).toEqual({ kind: 'elements', ids: ['a.b'] })
    expect(hitHref('b-board1', { kind: 'note', objectId: 'shape:bad id' }, 'el')).toBe('/b/b-board1')
    expect(hitHref('b-board1', { kind: 'comment', objectId: 'thr_AAAAAAAAAAAA' }, 'el')).toBe(
      '/b/b-board1?thread=thr_AAAAAAAAAAAA',
    )
  })

  it('the legacy link reader agrees with tldraw 5.4.2’s own deep-link strings (recorded 2026-09-30)', () => {
    // viewport: 'v' + x.y.w.h rounded + the page id without 'page:'; page: 'p' + the page id without 'page:'
    expect(parseLegacyDeepLink('v-10.20.300.200.two')).toEqual({
      kind: 'legacy-view',
      bounds: { x: -10, y: 20, w: 300, h: 200 },
      pageId: 'page:two',
    })
    expect(parseLegacyDeepLink('pthree')).toEqual({ kind: 'legacy-page', pageId: 'page:three' })
  })

  it('says what was found in plain words', () => {
    expect(summary({ totalHits: 0, totalBoards: 0, capped: false })).toBe('No matches inside boards.')
    expect(summary({ totalHits: 1, totalBoards: 1, capped: false })).toBe('1 match in 1 board')
    expect(summary({ totalHits: 7, totalBoards: 3, capped: false })).toBe('7 matches in 3 boards')
    expect(summary({ totalHits: 400, totalBoards: 12, capped: true })).toBe('400+ matches in 12+ boards')
    expect(pendingNote(0)).toBeNull()
    expect(pendingNote(1)).toBe('1 board is still being indexed, so its newest text may be missing.')
    expect(pendingNote(3)).toMatch(/^3 boards are still being indexed/)
    expect(kindLabel('arrow')).toBe('Connector')
    expect(kindLabel('resolved-comment')).toBe('Resolved comment')
  })

  it('shows "Inside boards" only for a searchable query outside the trash', () => {
    expect(contentSearchApplies({ kind: 'recent' }, 'zebra')).toBe(true)
    expect(contentSearchApplies({ kind: 'recent' }, 'z')).toBe(false)
    expect(contentSearchApplies({ kind: 'trash' }, 'zebra')).toBe(false)
  })

  it('treats a new workspace, list or query as a new search', () => {
    const a = searchKey('wsp_A', { status: 'active', projectId: null }, ' Zebra ')
    expect(a).toBe(searchKey('wsp_A', { status: 'active', projectId: null }, 'zebra'))
    expect(a).not.toBe(searchKey('wsp_B', { status: 'active', projectId: null }, 'zebra'))
    expect(a).not.toBe(searchKey('wsp_A', { status: 'archived', projectId: null }, 'zebra'))
  })
})
