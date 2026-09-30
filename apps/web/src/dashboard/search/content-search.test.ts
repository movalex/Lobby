import { createDeepLinkString, parseDeepLinkString, type TLPageId, type TLShapeId } from 'tldraw'
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

  it('builds the same deep link as tldraw, and it round-trips', () => {
    for (const ids of [
      ['shape:abc123'],
      ['shape:with.dots'],
      ['shape:ünï cødé/?&#'],
      ['shape:a', 'shape:b'],
    ]) {
      const ours = shapesDeepLink(ids)
      expect(ours).toBe(createDeepLinkString({ type: 'shapes', shapeIds: ids as TLShapeId[] }))
      expect(parseDeepLinkString(ours)).toEqual({ type: 'shapes', shapeIds: ids })
    }
  })

  it('opens shapes zoomed with ?d= and comments with ?thread=', () => {
    expect(hitHref('b-board1', { kind: 'note', objectId: 'shape:n1' })).toBe('/b/b-board1?d=sn1')
    expect(hitHref('b-board1', { kind: 'frame', objectId: 'shape:a.b' })).toBe('/b/b-board1?d=sa%252Eb')
    const url = new URL(hitHref('b-board1', { kind: 'frame', objectId: 'shape:a.b' }), 'http://x')
    expect(parseDeepLinkString(url.searchParams.get('d') ?? '')).toEqual({
      type: 'shapes',
      shapeIds: ['shape:a.b'],
    })
    expect(hitHref('b-board1', { kind: 'comment', objectId: 'thr_AAAAAAAAAAAA' })).toBe(
      '/b/b-board1?thread=thr_AAAAAAAAAAAA',
    )
    expect(hitHref('b-board1', { kind: 'resolved-comment', objectId: 'thr_AAAAAAAAAAAA' })).toBe(
      '/b/b-board1?thread=thr_AAAAAAAAAAAA',
    )
  })

  it('on the new canvas: ?el=<element id> (dots kept, the new board page also reads ?d=)', () => {
    // this build's default is the tldraw board page's link
    expect(HIT_LINK_FORMAT).toBe('d')
    expect(hitHref('b-board1', { kind: 'note', objectId: 'shape:n1' }, 'el')).toBe('/b/b-board1?el=n1')
    const href = hitHref('b-board1', { kind: 'frame', objectId: 'shape:a.b' }, 'el')
    expect(href).toBe('/b/b-board1?el=a.b')
    expect(readDeepLink(new URL(href, 'http://x').toString())).toEqual({ kind: 'elements', ids: ['a.b'] })
    expect(hitHref('b-board1', { kind: 'note', objectId: 'shape:bad id' }, 'el')).toBe('/b/b-board1')
    expect(hitHref('b-board1', { kind: 'comment', objectId: 'thr_AAAAAAAAAAAA' }, 'el')).toBe(
      '/b/b-board1?thread=thr_AAAAAAAAAAAA',
    )
  })

  it('the legacy link reader agrees with tldraw’s own deep-link strings', () => {
    for (const ids of [
      ['shape:abc123'],
      ['shape:with.dots'],
      ['shape:ünï cødé/?&#'],
      ['shape:a', 'shape:b'],
    ]) {
      const theirs = createDeepLinkString({ type: 'shapes', shapeIds: ids as TLShapeId[] })
      expect(parseLegacyDeepLink(theirs)).toEqual({
        kind: 'legacy-shapes',
        parts: ids.map((id) => id.replace(/^shape:/, '')),
      })
    }
    const view = createDeepLinkString({
      type: 'viewport',
      bounds: { x: -10.4, y: 20, w: 300, h: 200 },
      pageId: 'page:two' as TLPageId,
    })
    expect(parseLegacyDeepLink(view)).toEqual({
      kind: 'legacy-view',
      bounds: { x: -10, y: 20, w: 300, h: 200 },
      pageId: 'page:two',
    })
    const page = createDeepLinkString({ type: 'page', pageId: 'page:three' as TLPageId })
    expect(parseLegacyDeepLink(page)).toEqual({ kind: 'legacy-page', pageId: 'page:three' })
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
