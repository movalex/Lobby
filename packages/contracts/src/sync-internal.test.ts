// Contract tests of sync-internal.ts (spike B contracts step C0): a zod round trip for every request,
// response and error body of the api <-> sync internal routes, and the id rules of A1.
import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'
import {
  FILE_REFS_MAX_IDS,
  FileRefsQuery,
  FileRefsResponse,
  fileRefsPath,
  LobbyElementsSnapshot,
  parseFileRefsIds,
  SYNC_INTERNAL_ERROR_CODES,
  SYNC_INTERNAL_ERROR_STATUS,
  SyncInternalErrorBody,
  WorkshopStateBody,
  workshopStatePath,
} from './sync-internal.ts'

const roundTrip = (schema: ZodType, sample: unknown) => {
  const first = schema.parse(sample)
  expect(schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first)
  expect(first).toEqual(sample)
}
const ver = (n: number) => `ver_${String(n).padStart(10, '0')}`

describe('api <-> sync internal contracts (A1, A2, §2.4.6)', () => {
  it('A1 file-refs: request ids, the response and its three lists', () => {
    expect(FileRefsQuery.parse({ ids: `${ver(1)},${ver(2)}` })).toEqual({ ids: [ver(1), ver(2)] })
    expect(
      parseFileRefsIds(Array.from({ length: FILE_REFS_MAX_IDS }, (_, i) => ver(i)).join(',')),
    ).toHaveLength(100)
    for (const bad of [
      '',
      null,
      Array.from({ length: FILE_REFS_MAX_IDS + 1 }, (_, i) => ver(i)).join(','),
      `${ver(1)}.p2`,
      'ast_0123456789',
      `${ver(1)},,${ver(2)}`,
    ])
      expect(parseFileRefsIds(bad), String(bad).slice(0, 40)).toBeNull()
    expect(fileRefsPath('b-1', [ver(1), ver(2)])).toBe(
      `/internal/boards/b-1/file-refs?ids=${ver(1)},${ver(2)}`,
    )
    roundTrip(FileRefsResponse, {
      ok: [
        {
          versionId: ver(1),
          assetId: 'ast_0123456789',
          kind: 'pdf',
          name: 'deck.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 123_456,
          pageCount: 12,
        },
        {
          versionId: ver(2),
          assetId: 'ast_9876543210',
          kind: 'image',
          name: 'a.png',
          mimeType: 'image/png',
          sizeBytes: 1,
          pageCount: null,
        },
      ],
      foreign: [ver(3)],
      missing: [ver(4)],
    })
    roundTrip(FileRefsResponse, { ok: [], foreign: [], missing: [] })
    expect(FileRefsResponse.safeParse({ ok: [], foreign: [], missing: [], extra: 1 }).success).toBe(false)
  })

  it('A2 workshop-state: the GET answer and the POST body are one shape', () => {
    roundTrip(WorkshopStateBody, { voteOpen: true, anonymous: false })
    roundTrip(WorkshopStateBody, { voteOpen: false, anonymous: false })
    expect(WorkshopStateBody.safeParse({ voteOpen: 'yes', anonymous: false }).success).toBe(false)
    expect(workshopStatePath('b-1')).toBe('/internal/boards/b-1/workshop-state')
  })

  it('the lobby-elements snapshot envelope', () => {
    roundTrip(LobbyElementsSnapshot, {
      format: 'lobby-elements',
      schema: 1,
      clock: 42,
      elements: [{ id: 'a', type: 'rectangle' }],
      doc: { workshop: { hideNoteAuthors: false, hideCursors: false } },
    })
    expect(
      LobbyElementsSnapshot.safeParse({ format: 'tldraw', schema: 1, clock: 0, elements: [], doc: {} })
        .success,
    ).toBe(false)
  })

  it('every error body, with its status', () => {
    for (const code of SYNC_INTERNAL_ERROR_CODES)
      roundTrip(SyncInternalErrorBody, { error: { code, message: 'x' } })
    expect(SYNC_INTERNAL_ERROR_STATUS).toEqual({
      'bad-secret': 401,
      'bad-request': 400,
      'board-not-found': 404,
      unavailable: 503,
    })
    expect(SyncInternalErrorBody.safeParse({ error: { code: 'nope', message: 'x' } }).success).toBe(false)
  })
})
