// WS3 (wave S): the review viewer's thread logic: a version's threads in the file's order, the anchor a new time,
// page or spot comment gets, the spot math, the page markers and which spot pins show.
import type { CommentThread } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  mediaAnchor,
  SPOT_SHOWN_MS,
  spotAt,
  spotStyle,
  spotsShown,
  threadsOfAsset,
  threadsOfVersion,
  threadsPerPage,
} from './model.ts'

const AST = 'ast_0123456789ab'
const V1 = 'ver_0123456789ab'
const V2 = 'ver_abcdefghij01'
const who = { id: 'usr_0123456789ab', name: 'Ana (guest)', color: '#336699' }

function thread(id: string, over: Partial<CommentThread> & { at?: { timeMs?: number; page?: number } } = {}) {
  const { at, ...rest } = over
  return {
    id,
    boardId: 'b1',
    anchor: { kind: 'asset', shapeId: 'shape:card', assetId: AST, versionId: V1, ...at },
    status: 'open',
    createdBy: who,
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    visibility: 'everyone',
    comments: [
      {
        id: `cmt_${id}`,
        threadId: id,
        author: who,
        body: 'Note',
        mentions: [],
        createdAt: '2026-10-16T10:00:00.000Z',
        editedAt: null,
      },
    ],
    ...rest,
  } as CommentThread
}

describe('the threads of a version', () => {
  it('only asset threads of that version, by time then page then age; resolved only when asked', () => {
    const list = [
      thread('thr_late', { at: { timeMs: 4_000 } }),
      thread('thr_early', { at: { timeMs: 1_000 } }),
      thread('thr_v2', {
        anchor: { kind: 'asset', shapeId: 'shape:card', assetId: AST, versionId: V2, timeMs: 10 },
      }),
      thread('thr_point', { anchor: { kind: 'point', x: 1, y: 2 } }),
      thread('thr_done', { at: { timeMs: 2_000 }, status: 'resolved' }),
      thread('thr_other', {
        anchor: { kind: 'asset', shapeId: 'shape:x', assetId: 'ast_zzzzzzzzzzzz', versionId: V1 },
      }),
    ]
    expect(threadsOfVersion(list, { assetId: AST, versionId: V1 }).map((t) => t.id)).toEqual([
      'thr_early',
      'thr_late',
    ])
    expect(
      threadsOfVersion(list, { assetId: AST, versionId: V1 }, { resolved: true }).map((t) => t.id),
    ).toEqual(['thr_early', 'thr_done', 'thr_late'])
    expect(threadsOfVersion(list, { assetId: AST, versionId: V2 }).map((t) => t.id)).toEqual(['thr_v2'])
    expect(
      threadsOfAsset(list, AST)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['thr_done', 'thr_early', 'thr_late', 'thr_v2'].sort())
  })

  it('page markers count the open threads per page', () => {
    const list = threadsOfVersion(
      [
        thread('thr_a', { at: { page: 3 } }),
        thread('thr_b', { at: { page: 3 } }),
        thread('thr_c', { at: { page: 1 } }),
        thread('thr_d', { at: { page: 1 }, status: 'resolved' }),
      ],
      { assetId: AST, versionId: V1 },
      { resolved: true },
    )
    expect([...threadsPerPage(list)].sort()).toEqual([
      [1, 1],
      [3, 2],
    ])
  })
})

describe('new comments', () => {
  it('the anchor names the card, the version and the place (rounded)', () => {
    const file = { elementId: 'card', assetId: AST, versionId: V1 }
    expect(mediaAnchor(file, { timeMs: 12_400.6 })).toEqual({
      kind: 'asset',
      shapeId: 'shape:card',
      assetId: AST,
      versionId: V1,
      timeMs: 12_401,
    })
    expect(mediaAnchor(file, { page: 3 })).toEqual({
      kind: 'asset',
      shapeId: 'shape:card',
      assetId: AST,
      versionId: V1,
      page: 3,
    })
    expect(mediaAnchor(file, {})).toEqual({
      kind: 'asset',
      shapeId: 'shape:card',
      assetId: AST,
      versionId: V1,
    })
  })

  it('a spot from a click on the picture: (u, v) in [0, 1], 4 decimals; outside the box none', () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 }
    expect(spotAt(rect, 300, 150)).toEqual({ u: 0.5, v: 0.5 })
    expect(spotAt(rect, 100, 50)).toEqual({ u: 0, v: 0 })
    expect(spotAt(rect, 500, 250)).toEqual({ u: 1, v: 1 })
    expect(spotAt(rect, 101, 51)).toEqual({ u: 0.0025, v: 0.005 })
    expect(spotAt(rect, 99, 100)).toBeNull()
    expect(spotAt({ ...rect, width: 0 }, 100, 50)).toBeNull()
    expect(spotStyle({ u: 0.25, v: 0.75 })).toEqual({ left: '25%', top: '75%' })
  })

  it('spot pins: on a video near the playhead, on a PDF on its page, on an image the ones with neither', () => {
    const list = threadsOfVersion(
      [
        thread('thr_t', { at: { timeMs: 2_000 }, spot: { u: 0.1, v: 0.1 } }),
        thread('thr_p', { at: { page: 2 }, spot: { u: 0.2, v: 0.2 } }),
        thread('thr_i', { spot: { u: 0.3, v: 0.3 } }),
        thread('thr_n', { at: { timeMs: 2_000 } }),
      ],
      { assetId: AST, versionId: V1 },
    )
    expect(spotsShown(list, { ms: 2_000 + SPOT_SHOWN_MS }).map((t) => t.id)).toEqual(['thr_t'])
    expect(spotsShown(list, { ms: 2_000 + SPOT_SHOWN_MS + 1 })).toEqual([])
    expect(spotsShown(list, { page: 2 }).map((t) => t.id)).toEqual(['thr_p'])
    expect(spotsShown(list, {}).map((t) => t.id)).toEqual(['thr_i'])
  })
})
