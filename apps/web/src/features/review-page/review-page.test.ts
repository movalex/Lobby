// Wave S (WS4): the client review page's pure parts in Node: the items it lists and their order, the buttons by
// permission and status, which threads belong to an item, the picture cache key and scale, the sticky progress words, the
// review client's answers (including the conflict and newer-version bodies), the live item merge, and the landing path.
import type { CommentThread, GetReviewResponse, ReviewItem, ReviewRound } from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_REVIEW, getReview, ReviewRequestError, setReviewStatus } from './client.ts'
import { withItem } from './data.ts'
import { landingPathFor } from './landing.ts'
import {
  type ElementFacts,
  entryLabel,
  entryPillText,
  entryStanding,
  entryStatus,
  frameCacheKey,
  neighbours,
  pageEntries,
  pictureScale,
  progressDetail,
  progressText,
  resolvedCount,
  roundLabel,
  statusButtons,
  threadsFor,
} from './model.ts'
import { previewDerivative } from './picture.ts'

const item = (n: number, over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: `rvi_item${String(n).padStart(10, '0')}`,
  boardId: 'b-board123',
  elementId: `el${n}`,
  kind: 'frame',
  assetId: null,
  label: `Item ${n}`,
  position: null,
  roundId: null,
  status: 'pending',
  statusSeq: 0,
  statusBy: null,
  statusAt: null,
  statusVersionId: null,
  createdAt: '2026-10-10T10:00:00.000Z',
  removedAt: null,
  ...over,
})

const at = (x: number, y: number, over: Partial<ElementFacts> = {}): ElementFacts => ({
  type: 'frame',
  frameName: '',
  file: null,
  bounds: { x, y, width: 400, height: 300 },
  ...over,
})

describe('which items the page lists, in which order', () => {
  const facts = (m: Record<string, ElementFacts | null>) => (id: string) => m[id] ?? null

  it('the editor’s position first, then frames in presentation order, then the rest in reading order', () => {
    const items = [
      item(1, { elementId: 'a' }),
      item(2, { elementId: 'b' }),
      item(3, { elementId: 'c', kind: 'file', assetId: 'ast_asset0000001' }),
      item(4, { elementId: 'd', position: 0 }),
      item(5, { elementId: 'e', kind: 'file', assetId: 'ast_asset0000002' }),
    ]
    const entries = pageEntries(
      { items, openRoundId: null },
      facts({
        a: at(900, 0),
        b: at(0, 0),
        c: at(0, 600, { type: 'image' }),
        d: at(2000, 2000),
        e: at(0, 100, { type: 'image' }),
      }),
      (id) => (id === 'a' ? 0 : id === 'b' ? 1 : null), // a is the first slide, b the second
    )
    // d (position 0), a, b (slides), then e (y 100) before c (y 600): reading order
    expect(entries.map((e) => e.item.elementId)).toEqual(['d', 'a', 'b', 'e', 'c'])
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2, 3, 4])
  })

  it('an open round lists its items only; with none in it (or no round) every live item', () => {
    const items = [
      item(1, { elementId: 'a', roundId: 'rvr_round00000001' }),
      item(2, { elementId: 'b', roundId: null }),
      item(3, { elementId: 'c', removedAt: '2026-10-11T00:00:00.000Z' }),
    ]
    const f = facts({ a: at(0, 0), b: at(0, 400), c: at(0, 800) })
    expect(pageEntries({ items, openRoundId: 'rvr_round00000001' }, f).map((e) => e.item.elementId)).toEqual([
      'a',
    ])
    expect(pageEntries({ items, openRoundId: 'rvr_other0000001' }, f).map((e) => e.item.elementId)).toEqual([
      'a',
      'b',
    ])
    expect(pageEntries({ items, openRoundId: null }, f).map((e) => e.item.elementId)).toEqual(['a', 'b'])
  })

  it('leaves out an item whose element is gone, and names an item by its label, else the canvas name', () => {
    const entries = pageEntries(
      { items: [item(1, { elementId: 'gone' }), item(2, { elementId: 'b', label: ' ' })], openRoundId: null },
      facts({ b: at(0, 0, { frameName: 'Hero frame' }) }),
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.label).toBe('Hero frame')
    expect(entryLabel(item(1, { label: 'Key art' }), null)).toBe('Key art')
    expect(entryLabel(item(1, { label: '' }), null)).toBe('Untitled item')
  })
})

describe('progress, round and navigation words', () => {
  it('"3 of 7 approved" and what is left', () => {
    const entries = [
      { item: item(1, { status: 'approved' }) },
      { item: item(2, { status: 'approved' }) },
      { item: item(3, { status: 'changes_requested' }) },
      { item: item(4) },
    ]
    expect(progressText(entries)).toBe('2 of 4 approved')
    expect(progressDetail(entries)).toBe('1 with changes requested · 1 awaiting review')
    expect(progressDetail([{ item: item(1, { status: 'approved' }) }])).toBe('')
  })

  it('a file item against its card: "Approved v2 · v3 is newer"; a replaced file is "File replaced: review again"', () => {
    const AST = 'ast_0123456789abcdefghij'
    const V1 = 'ver_v1v1v1v1v1v1v1v1v1v1'
    const V2 = 'ver_v2v2v2v2v2v2v2v2v2v2'
    const file = (assetId: string, versionId: string) => ({
      assetId,
      versionId,
      kind: 'image' as const,
      name: 'a.png',
    })
    const approved = item(1, {
      kind: 'file',
      assetId: AST,
      status: 'approved',
      statusSeq: 1,
      statusVersionId: V1,
      statusBy: { id: null, name: 'Ana', kind: 'guest', external: false },
    })
    // the card shows v2 now: the approval was about v1 (numbers from the version list)
    const shownV2 = { item: approved, file: file(AST, V2) }
    expect(entryStanding(shownV2)).toEqual({ kind: 'other', statusN: null, shownN: null })
    expect(entryPillText(approved, { kind: 'other', statusN: 1, shownN: 2 })).toBe(
      'Approved v1 · v2 is newer · Ana (guest)',
    )
    expect(entryStatus(shownV2)).toBe('approved')
    // the card shows another file: never the old "Approved"; it counts and answers as awaiting review
    const replaced = { item: approved, file: file('ast_freshfreshfreshfresh', 'ver_freshfreshfreshfresh') }
    expect(entryStanding(replaced)).toEqual({ kind: 'replaced' })
    expect(entryPillText(approved, entryStanding(replaced))).toBe('File replaced: review again')
    expect(entryStatus(replaced)).toBe('pending')
    expect(progressText([replaced, { item: item(2, { status: 'approved' }) }])).toBe('1 of 2 approved')
    expect(progressDetail([replaced])).toBe('1 awaiting review')
    expect(statusButtons({ setStatus: true }, entryStatus(replaced)).map((b) => b.status)).toEqual([
      'approved',
      'changes_requested',
    ])
    // the version shown: as before
    expect(entryPillText(approved, entryStanding({ item: approved, file: file(AST, V1) }))).toBe(
      'Approved · Ana (guest)',
    )
  })

  it('the round line shows only an open round', () => {
    const round = (closedAt: string | null): ReviewRound => ({
      id: 'rvr_round00000001',
      boardId: 'b-board123',
      number: 2,
      title: 'Round 2',
      openedBy: null,
      openedAt: '2026-10-14T09:00:00.000Z',
      closedAt,
      checkpointId: null,
    })
    expect(roundLabel({ rounds: [round(null)], openRoundId: 'rvr_round00000001' })).toBe('Round 2')
    expect(
      roundLabel({ rounds: [round('2026-10-20T09:00:00.000Z')], openRoundId: 'rvr_round00000001' }),
    ).toBeNull()
    expect(roundLabel({ rounds: [round(null)], openRoundId: null })).toBeNull()
  })

  it('previous and next stop at the ends', () => {
    expect(neighbours(0, 3)).toEqual({ prev: null, next: 1 })
    expect(neighbours(1, 3)).toEqual({ prev: 0, next: 2 })
    expect(neighbours(2, 3)).toEqual({ prev: 1, next: null })
    expect(neighbours(0, 1)).toEqual({ prev: null, next: null })
  })
})

describe('the buttons a person gets', () => {
  it('none without the right to answer; otherwise approve (confirmed) and request changes (with a note)', () => {
    expect(statusButtons({ setStatus: false }, 'pending')).toEqual([])
    expect(statusButtons({ setStatus: true }, 'pending').map((b) => [b.status, b.confirm, b.note])).toEqual([
      ['approved', true, false],
      ['changes_requested', false, true],
    ])
    expect(statusButtons({ setStatus: true }, 'approved').map((b) => b.status)).toEqual([
      'changes_requested',
      'pending',
    ])
    expect(statusButtons({ setStatus: true }, 'changes_requested').map((b) => b.status)).toEqual([
      'approved',
      'pending',
    ])
  })
})

const thread = (
  id: string,
  anchor: CommentThread['anchor'],
  over: Partial<CommentThread> = {},
): CommentThread =>
  ({
    id,
    boardId: 'b-board123',
    anchor,
    status: 'open',
    visibility: 'everyone',
    createdAt: `2026-10-11T10:0${id.length % 10}:00.000Z`,
    updatedAt: '2026-10-11T10:00:00.000Z',
    createdBy: { id: 'usr_x', name: 'x', color: '#000000' },
    comments: [
      {
        id: `cmt_${id}`,
        threadId: id,
        author: { id: 'usr_x', name: 'x', color: '#000000' },
        body: 'hi',
        mentions: [],
        createdAt: '2026-10-11T10:00:00.000Z',
        editedAt: null,
      },
    ],
    ...over,
  }) as unknown as CommentThread

describe('which comments belong to an item', () => {
  const frame = { item: item(1, { elementId: 'frame1' }) }
  const file = { item: item(2, { elementId: 'card1', kind: 'file', assetId: 'ast_asset0000001' }) }
  const scope = { members: new Set(['note1']), bounds: { x: 0, y: 0, width: 400, height: 300 } }
  const all = [
    thread('t_pin', { kind: 'shape', shapeId: 'shape:frame1', u: 1, v: 0 }),
    thread('t_note', { kind: 'shape', shapeId: 'shape:note1', u: 0.5, v: 0.5 }),
    thread('t_point', { kind: 'point', x: 100, y: 100 }),
    thread('t_far', { kind: 'point', x: 5000, y: 5000 }),
    thread('t_card', {
      kind: 'asset',
      shapeId: 'shape:card1',
      assetId: 'ast_asset0000001',
      versionId: 'ver_version000001',
    }),
    thread('t_team', { kind: 'shape', shapeId: 'shape:frame1', u: 0, v: 0 }, { visibility: 'team' }),
    thread('t_done', { kind: 'shape', shapeId: 'shape:frame1', u: 0, v: 1 }, { status: 'resolved' }),
    thread('t_other', { kind: 'shape', shapeId: 'shape:elsewhere', u: 0, v: 0 }),
  ]

  it('a frame: its own pins, elements inside it, and points inside its bounds; never internal or resolved ones', () => {
    expect(
      threadsFor(all, frame, scope)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['t_note', 't_pin', 't_point'])
    expect(resolvedCount(all, frame, scope)).toBe(1)
  })

  it('a file: the threads pinned to its card only (never by position)', () => {
    expect(threadsFor(all, file, { members: new Set(), bounds: scope.bounds }).map((t) => t.id)).toEqual([
      't_card',
    ])
  })
})

describe('the picture', () => {
  it('is cached by the frame and everything in it: an edit inside is a new key, one elsewhere is not', () => {
    const a = frameCacheKey('f1', 3, [{ version: 2 }, { version: 5 }], 1)
    expect(frameCacheKey('f1', 3, [{ version: 2 }, { version: 5 }], 1)).toBe(a)
    expect(frameCacheKey('f1', 3, [{ version: 2 }, { version: 6 }], 1)).not.toBe(a)
    expect(frameCacheKey('f1', 4, [{ version: 2 }, { version: 5 }], 1)).not.toBe(a)
    expect(frameCacheKey('f1', 3, [{ version: 2 }, { version: 5 }, { version: 1 }], 1)).not.toBe(a)
    expect(frameCacheKey('f1', 3, [{ version: 2 }, { version: 5 }], 2)).not.toBe(a)
  })

  it('is drawn at the column width × the density, never above 2×', () => {
    expect(pictureScale(390, 1920, 3)).toBe(1) // a big frame on a phone: 1×
    expect(pictureScale(390, 300, 3)).toBe(2) // a small frame: 2× at most
    expect(pictureScale(700, 1000, 1)).toBe(1)
    expect(pictureScale(390, 0, 2)).toBe(1)
  })

  it('a file shows its own preview: an image’s display copy, a video’s poster, a PDF’s cover; nothing before it is ready', () => {
    const d = (id: string, role: string, page: number | null = null) => ({
      id,
      role,
      page,
      width: 10,
      height: 10,
      mimeType: 'image/webp',
      bytes: 1,
      file: 'x',
    })
    const meta = (kind: string, derivatives: unknown[], status = 'ready') =>
      ({ status, kind, derivatives }) as never
    expect(
      previewDerivative(
        meta('image', [d('drv_thumb0000001', 'thumb'), d('drv_disp00000001', 'display')]),
        'image',
      )?.id,
    ).toBe('drv_disp00000001')
    expect(previewDerivative(meta('video', [d('drv_poster000001', 'poster')]), 'video')?.id).toBe(
      'drv_poster000001',
    )
    expect(
      previewDerivative(meta('pdf', [d('drv_page0000001', 'page', 1), d('drv_thumb0000001', 'thumb')]), 'pdf')
        ?.id,
    ).toBe('drv_thumb0000001')
    expect(
      previewDerivative(meta('image', [d('drv_thumb0000001', 'thumb')], 'processing'), 'image'),
    ).toBeNull()
    expect(previewDerivative(meta('other', []), 'other')).toBeNull()
    expect(previewDerivative(null, 'image')).toBeNull()
  })
})

describe('the live review', () => {
  const review = (items: ReviewItem[]): GetReviewResponse => ({ ...EMPTY_REVIEW, items })

  it('puts an item the api sent in place, adds a new one, drops a removed one, and ignores an older answer', () => {
    const base = review([item(1, { statusSeq: 2, status: 'approved' }), item(2)])
    expect(withItem(base, item(2, { status: 'approved', statusSeq: 1 })).items[1]?.status).toBe('approved')
    expect(withItem(base, item(3)).items).toHaveLength(3)
    expect(withItem(base, item(2, { removedAt: '2026-10-12T00:00:00.000Z' })).items.map((i) => i.id)).toEqual(
      [item(1).id],
    )
    // a late answer (seq 1) never undoes a newer status (seq 2)
    expect(withItem(base, item(1, { statusSeq: 1, status: 'pending' }))).toBe(base)
  })
})

describe('the review client (WS1, re-exported)', () => {
  const setReviewFetch = (f: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
    vi.stubGlobal('fetch', f)
  afterEach(() => vi.unstubAllGlobals())
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  it('reads answer empty when the routes are absent or the answer is not the contract', async () => {
    setReviewFetch(async () => json(404, { error: { code: 'NOT_FOUND', message: 'nope' } }))
    expect(await getReview('b-board123')).toEqual(EMPTY_REVIEW)
    setReviewFetch(async () => json(200, { items: 'wrong' }))
    expect(await getReview('b-board123')).toEqual(EMPTY_REVIEW)
    setReviewFetch(async () => {
      throw new Error('offline')
    })
    expect(await getReview('b-board123')).toEqual(EMPTY_REVIEW)
  })

  it('sends the revision header and the same-origin credentials', async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null
    setReviewFetch(async (url, init) => {
      seen = { url: String(url), init }
      return json(200, { items: [], rounds: [], openRoundId: null, can: { setStatus: true, manage: false } })
    })
    const r = await getReview('b-board123')
    expect(r.can.setStatus).toBe(true)
    expect(seen).toMatchObject({ url: '/api/boards/b-board123/review' })
    const headers = (seen as unknown as { init: RequestInit }).init.headers as Record<string, string>
    expect(Object.keys(headers).some((k) => k.toLowerCase().includes('client'))).toBe(true)
    expect((seen as unknown as { init: RequestInit }).init.credentials).toBe('same-origin')
  })

  it('the status write sends exactly the contract’s body and parses the answer', async () => {
    const it1 = item(1, { status: 'approved', statusSeq: 1 })
    let body: unknown
    setReviewFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return json(200, {
        item: it1,
        event: {
          id: 'rve_event000000001',
          itemId: it1.id,
          roundId: null,
          kind: 'status',
          status: 'approved',
          previousStatus: 'pending',
          reason: 'set',
          versionId: null,
          threadId: null,
          actor: { id: null, name: 'Ana', kind: 'guest', external: false },
          itemCount: null,
          createdAt: '2026-10-15T10:00:00.000Z',
          seq: 1,
        },
      })
    })
    const res = await setReviewStatus('b-board123', it1.id, { status: 'approved', fromSeq: 0 })
    expect(body).toEqual({ status: 'approved', fromSeq: 0 })
    expect(res.item.status).toBe('approved')
  })

  it('a 409 STATUS_CHANGED carries the current item, a NEWER_VERSION the version, a 404 its code', async () => {
    const current = item(1, { status: 'changes_requested', statusSeq: 4 })
    setReviewFetch(async () =>
      json(409, { error: { code: 'STATUS_CHANGED', message: 'changed' }, item: current }),
    )
    const changed = await setReviewStatus('b-board123', current.id, { status: 'approved' }).catch((e) => e)
    expect(changed).toBeInstanceOf(ReviewRequestError)
    expect(changed).toMatchObject({ code: 'STATUS_CHANGED', status: 409, item: { statusSeq: 4 } })

    setReviewFetch(async () =>
      json(409, { error: { code: 'NEWER_VERSION', message: 'newer' }, latestVersionId: 'ver_version000002' }),
    )
    const newer = await setReviewStatus('b-board123', current.id, { status: 'approved' }).catch((e) => e)
    expect(newer).toMatchObject({ code: 'NEWER_VERSION', latestVersionId: 'ver_version000002' })

    setReviewFetch(async () => json(404, { error: { code: 'NOT_FOUND', message: 'nope' } }))
    const gone = await setReviewStatus('b-board123', current.id, { status: 'approved' }).catch((e) => e)
    expect(gone).toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })
})

describe('where a link lands', () => {
  it('the review page only for a review landing while the switch is on (on in this build), else the board', () => {
    expect(landingPathFor('b-board123', undefined)).toBe('/b/b-board123')
    expect(landingPathFor('b-board123', 'board')).toBe('/b/b-board123')
    expect(landingPathFor('b-board123', 'review')).toBe('/b/b-board123?view=review')
  })
})
