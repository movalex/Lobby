// Wave S, WS1 (docs/WAVE-S-CONTRACTS.md §2): the web side of review status. The pure model (what may be marked, the
// order, the badge's place, the words), the live client (same origin, the revision header, the api's codes and the
// conflict bodies), the board page's store (events and answers applied, a removed item dropped, the round state), and
// the feature contributing nothing with its switch off.
import type { GetReviewResponse, NotificationItem, ReviewEvent, ReviewItem } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasElement } from '../../canvas/api/index.ts'
import type { BoardEvents } from '../events.ts'
import {
  closeReviewRound,
  getReview,
  ReviewRequestError,
  resetReviewAvailability,
  reviewAvailable,
  setReviewStatus,
} from './client.ts'
import { boardChipText, reviewNotificationText } from './copy.ts'
import { reviewFeature } from './index.tsx'
import {
  badgeAnchor,
  defaultLabel,
  eventLine,
  filterRows,
  markableOf,
  orderItems,
  pillLine,
  progressText,
} from './model.ts'
import { type ReviewClient, ReviewStore } from './store.ts'

const B = 'b-pitch0001'
const AST = 'ast_0123456789abcdefghij'
const VER = 'ver_0123456789abcdefghij'

const el = (over: Record<string, unknown>): CanvasElement =>
  ({
    id: 'e1',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    angle: 0,
    groupIds: [],
    frameId: null,
    locked: false,
    isDeleted: false,
    ...over,
  }) as unknown as CanvasElement

const file = (over: Record<string, unknown> = {}) =>
  el({
    id: 'card-1',
    type: 'image',
    fileId: VER,
    customData: {
      lobby: {
        file: {
          assetId: AST,
          versionId: VER,
          kind: 'video',
          name: 'Trailer cut 3.mov',
          mimeType: 'video/mp4',
          sizeBytes: 9,
        },
      },
    },
    ...over,
  })

const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: 'rvi_0123456789abcdefghij',
  boardId: B,
  elementId: 'frame-1',
  kind: 'frame',
  assetId: null,
  label: 'Key art B',
  position: null,
  roundId: null,
  status: 'pending',
  statusSeq: 0,
  statusBy: null,
  statusAt: null,
  statusVersionId: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  removedAt: null,
  ...over,
})

describe('what may be marked', () => {
  it('a frame (its name), a file card and an image (the file name); never a placed PDF page, a shape or a deleted one', () => {
    expect(markableOf(el({ id: 'f1', type: 'frame', name: '  Hero   frame ' }))).toEqual({
      elementId: 'f1',
      kind: 'frame',
      label: 'Hero frame',
    })
    expect(markableOf(el({ id: 'f2', type: 'frame', name: null }))?.label).toBe('Frame')
    expect(markableOf(file())).toEqual({
      elementId: 'card-1',
      kind: 'file',
      assetId: AST,
      versionId: VER,
      label: 'Trailer cut 3.mov',
    })
    const image = file({
      customData: {
        lobby: { file: { assetId: AST, versionId: VER, kind: 'image', name: '', mimeType: 'image/png' } },
      },
    })
    expect(markableOf(image)?.label).toBe('Image')
    expect(markableOf(file({ fileId: `${VER}.p3` }))).toBeNull()
    expect(markableOf(el({ type: 'rectangle' }))).toBeNull()
    expect(markableOf(el({ id: 'f3', type: 'frame', isDeleted: true }))).toBeNull()
    expect(markableOf(undefined)).toBeNull()
  })

  it('a label is cut to 120 characters (code points)', () => {
    expect([...defaultLabel('😀'.repeat(130), 'x')]).toHaveLength(120)
  })
})

describe('the panel order, the filters and the badge', () => {
  it('position first, then presentation order, then reading order; deleted elements last', () => {
    const items = [
      item({ id: 'rvi_a000000000', elementId: 'a' }),
      item({ id: 'rvi_b000000000', elementId: 'b' }),
      item({ id: 'rvi_c000000000', elementId: 'c', position: 0 }),
      item({ id: 'rvi_d000000000', elementId: 'd' }),
      item({ id: 'rvi_e000000000', elementId: 'gone' }),
      item({ id: 'rvi_f000000000', elementId: 'f', removedAt: '2026-10-16T10:00:00.000Z' }),
    ]
    const bounds: Record<string, { x: number; y: number; width: number; height: number }> = {
      a: { x: 500, y: 0, width: 1, height: 1 },
      b: { x: 0, y: 0, width: 1, height: 1 },
      d: { x: 0, y: 900, width: 1, height: 1 },
    }
    const rows = orderItems(items, {
      bounds: (id) => bounds[id] ?? null,
      presentIndex: (id) => (id === 'd' ? 1 : null),
      alive: (id) => id !== 'gone',
    })
    expect(rows.map((r) => r.item.elementId)).toEqual(['c', 'd', 'b', 'a', 'gone'])
    expect(rows.at(-1)?.orphaned).toBe(true)
    expect(filterRows(rows, 'pending')).toHaveLength(5)
    expect(filterRows(rows, 'approved')).toEqual([])
    expect(progressText([item({ status: 'approved' }), item(), item({ removedAt: 'x' })])).toBe(
      '1 of 2 approved',
    )
  })

  it('a frame’s pill sits above its name at the top-left; a file’s under its bottom-left corner', () => {
    const id = (p: { x: number; y: number }) => p
    expect(badgeAnchor('frame', { x: 10, y: 100, width: 50, height: 50 }, id)).toEqual({ x: 10, y: 52 })
    expect(badgeAnchor('file', { x: 10, y: 100, width: 50, height: 50 }, id)).toEqual({ x: 10, y: 154 })
  })
})

describe('the words', () => {
  const now = new Date('2026-10-16T12:00:00.000Z')
  it('the pill names the status and who, a guest with "(guest)", an outside account with "External"', () => {
    expect(pillLine(item(), now)).toBe('Awaiting review')
    const guest = item({
      status: 'approved',
      statusBy: { id: null, name: 'Ana', kind: 'guest', external: false },
      statusAt: '2026-10-16T10:00:00.000Z',
    })
    expect(pillLine(guest, now)).toMatch(/^Approved · Ana \(guest\) · /)
    const outside = item({
      status: 'changes_requested',
      statusBy: { id: null, name: 'Pat‮', kind: 'account', external: true },
    })
    expect(pillLine(outside, now)).toBe('Changes requested · Pat · External')
  })

  it('history rows', () => {
    const ev = (over: Partial<ReviewEvent>): ReviewEvent => ({
      id: 'rve_0123456789abcdefghij',
      itemId: null,
      roundId: null,
      kind: 'status',
      status: 'approved',
      previousStatus: 'pending',
      reason: 'set',
      versionId: null,
      threadId: null,
      actor: { id: null, name: 'Ana', kind: 'guest', external: false },
      itemCount: null,
      createdAt: '2026-10-16T10:00:00.000Z',
      seq: 1,
      ...over,
    })
    expect(eventLine(ev({}))).toBe('Approved by Ana (guest)')
    expect(eventLine(ev({ status: 'pending', reason: 'new_version' }))).toBe(
      'Awaiting review: Ana (guest) uploaded a new version',
    )
    expect(eventLine(ev({ kind: 'added', status: null, reason: null }))).toBe(
      'Marked for review by Ana (guest)',
    )
  })

  it('the bell and the board card', () => {
    const n = (review: NotificationItem['review']) => ({ review })
    const status = {
      event: 'status' as const,
      itemId: 'x',
      label: 'Key art B',
      roundTitle: null,
      itemCount: null,
    }
    expect(reviewNotificationText(n({ ...status, status: 'approved', reason: 'set' }))).toBe(
      'approved Key art B',
    )
    expect(reviewNotificationText(n({ ...status, status: 'changes_requested', reason: 'set' }))).toBe(
      'requested changes on Key art B',
    )
    expect(
      reviewNotificationText(n({ ...status, status: 'pending', reason: 'new_version', label: null })),
    ).toBe('uploaded a new version of an item: awaiting review')
    expect(
      reviewNotificationText(
        n({
          event: 'round_opened',
          itemId: null,
          status: null,
          reason: null,
          label: null,
          roundTitle: 'Round 2',
          itemCount: 6,
        }),
      ),
    ).toBe('started Round 2 (6 items)')
    expect(reviewNotificationText(n(null))).toBe('updated a review')
    expect(boardChipText({ pending: 2, changes: 1, approved: 0 })).toBe('2 awaiting · 1 change')
    expect(boardChipText({ pending: 0, changes: 0, approved: 0 })).toBeNull()
    expect(boardChipText(undefined)).toBeNull()
  })
})

describe('the client (live)', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    fetchSpy.mockReset()
    resetReviewAvailability()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => vi.unstubAllGlobals())
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

  it('GET review: same origin, the revision header; a 404 means the routes are not here (reviewAvailable false)', async () => {
    const body: GetReviewResponse = {
      items: [item()],
      rounds: [],
      openRoundId: null,
      can: { setStatus: true, manage: false },
    }
    fetchSpy.mockResolvedValueOnce(answer(200, body))
    expect(await getReview(B)).toEqual(body)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`/api/boards/${B}/review`)
    expect(init.credentials).toBe('same-origin')
    expect((init.headers as Record<string, string>)['x-lobby-client']).toBe('3')
    expect(reviewAvailable()).toBe(true)
    fetchSpy.mockResolvedValueOnce(answer(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } }))
    expect((await getReview(B)).items).toEqual([])
    expect(reviewAvailable()).toBe(false)
    fetchSpy.mockRejectedValueOnce(new TypeError('offline'))
    expect((await getReview(B)).items).toEqual([])
  })

  it('a status write: the body as given; STATUS_CHANGED carries the item, NEWER_VERSION the version', async () => {
    const now = item({ status: 'changes_requested', statusSeq: 3 })
    fetchSpy.mockResolvedValueOnce(
      answer(409, { error: { code: 'STATUS_CHANGED', message: 'Changed.' }, item: now }),
    )
    const e1 = await setReviewStatus(B, now.id, { status: 'approved', fromSeq: 2 }).catch((e: unknown) => e)
    expect(e1).toBeInstanceOf(ReviewRequestError)
    expect((e1 as ReviewRequestError).code).toBe('STATUS_CHANGED')
    expect((e1 as ReviewRequestError).item).toEqual(now)
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ status: 'approved', fromSeq: 2 })
    expect(init.method).toBe('POST')
    fetchSpy.mockResolvedValueOnce(
      answer(409, { error: { code: 'NEWER_VERSION', message: 'Newer.' }, latestVersionId: VER }),
    )
    const e2 = (await setReviewStatus(B, now.id, { status: 'approved' }).catch(
      (e: unknown) => e,
    )) as ReviewRequestError
    expect(e2.latestVersionId).toBe(VER)
    fetchSpy.mockRejectedValueOnce(new TypeError('offline'))
    const e3 = (await closeReviewRound(B, 'rvr_0123456789abcdefghij').catch(
      (e: unknown) => e,
    )) as ReviewRequestError
    expect(e3.code).toBe('unavailable')
  })
})

describe('the store', () => {
  const events = () => {
    const on = new Map<string, (data: unknown) => void>()
    let resync: (() => void) | null = null
    const ev = {
      on: (type: string, fn: (data: unknown) => void) => {
        on.set(type, fn)
        return () => on.delete(type)
      },
      onResync: (fn: () => void) => {
        resync = fn
        return () => {
          resync = null
        }
      },
    } as unknown as BoardEvents
    return { ev, emit: (type: string, data: unknown) => on.get(type)?.(data), resync: () => resync?.() }
  }

  it('loads, applies the board events (a removed item drops), keeps the open round, refetches on reconnect', async () => {
    const first: GetReviewResponse = {
      items: [item()],
      rounds: [],
      openRoundId: null,
      can: { setStatus: true, manage: true },
    }
    const client = { getReview: vi.fn().mockResolvedValue(first) } as unknown as ReviewClient
    const store = new ReviewStore(B, client)
    const e = events()
    const stop = store.start(e.ev)
    await store.refresh()
    expect(store.items()).toHaveLength(1)
    e.emit('review.item', { item: item({ status: 'approved', statusSeq: 1 }) })
    expect(store.itemOf('frame-1')?.status).toBe('approved')
    e.emit('review.item', { item: item({ id: 'rvi_other000000', elementId: 'f2' }) })
    expect(store.items()).toHaveLength(2)
    // another board's event, or a malformed one, changes nothing
    e.emit('review.item', { item: item({ id: 'rvi_x0000000000', boardId: 'b-another001' }) })
    e.emit('review.item', { nope: true })
    expect(store.items()).toHaveLength(2)
    store.popover.set({ itemId: 'rvi_other000000', from: 'badge' })
    e.emit('review.item', {
      item: item({ id: 'rvi_other000000', elementId: 'f2', removedAt: '2026-10-16T11:00:00.000Z' }),
    })
    expect(store.items()).toHaveLength(1)
    expect(store.popover.get()).toBeNull()
    const round = {
      id: 'rvr_0123456789abcdefghij',
      boardId: B,
      number: 1,
      title: 'Round 1',
      openedBy: null,
      openedAt: '2026-10-16T10:00:00.000Z',
      closedAt: null,
      checkpointId: null,
    }
    e.emit('review.round', { round })
    expect(store.openRound()?.id).toBe(round.id)
    e.emit('review.round', { round: { ...round, closedAt: '2026-10-16T12:00:00.000Z' } })
    expect(store.openRound()).toBeNull()
    e.resync()
    await Promise.resolve()
    expect((client.getReview as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2)
    stop()
  })
})

describe('the switch', () => {
  it('off: the feature contributes nothing (the board page is as before wave S)', () => {
    expect(reviewFeature(false)).toEqual({ id: 'review' })
    const on = reviewFeature(true)
    expect(on.panels?.map((p) => p.id)).toEqual(['review'])
    expect(on.overlays?.map((o) => o.id)).toEqual(['review.badges', 'review.popover'])
    expect(on.contextMenu?.map((m) => m.id)).toEqual(['review-mark', 'review-open', 'review-remove'])
  })
})
