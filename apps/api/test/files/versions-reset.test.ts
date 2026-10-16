// Wave S, WS2 (docs/WAVE-S-CONTRACTS.md §3.1): the upload of a new version runs WS1's review reset
// (features/review/hooks.ts resetForNewVersion) inside its own transaction, after the version row is inserted, with
// the uploader as the actor; the items it returns go out as REVIEW_ITEM_EVENT after COMMIT, and a reset that throws
// rolls the whole upload back (no row, no blob). WS1's store is mocked here: these tests hold the call, not the reset.

import { ASSET_VERSION_EVENT, REVIEW_ITEM_EVENT, type ReviewItem } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { SUPERSEDES_HEADER } from '@draftroom/dev-assets'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventHub } from '../../src/events/hub.ts'
import type { NewVersionReset } from '../../src/features/review/hooks.ts'
import { originalKey } from '../../src/files/blobs.ts'
import { recordEvents, upload } from '../features/history/helpers.ts'
import { createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../helpers.ts'

const calls: { reset: NewVersionReset; versionRow: unknown }[] = []
let answer: (reset: NewVersionReset) => ReviewItem[] = () => []

vi.mock('../../src/features/review/hooks.ts', async (importOriginal) => ({
  // WS1's other hooks as they are (the review feature configures them at start-up)
  ...(await importOriginal<typeof import('../../src/features/review/hooks.ts')>()),
  resetForNewVersion: async (tx: Queryable, reset: NewVersionReset) => {
    // the new version is already a row of this transaction
    const row = await tx.maybeOne('SELECT id, supersedes FROM asset_versions WHERE id = $1', [
      reset.versionId,
    ])
    calls.push({ reset, versionRow: row })
    return answer(reset)
  },
}))

let api: TestApi | undefined
beforeEach(() => {
  calls.length = 0
  answer = () => []
})
afterEach(async () => {
  await api?.close()
  api = undefined
})

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function world() {
  const hub = new EventHub()
  api = await createTestApi({ deps: { events: hub } })
  const t = api
  const alice = await t.login('alice', 'Alice')
  const board = await createBoard(alice, DEV_STUDIO, 'Cuts')
  const v1 = await upload(t, alice, board, 'cut.png')
  const supersede = (versionId: string) =>
    t.app.inject({
      method: 'POST',
      url: `/api/boards/${board}/assets`,
      payload: PNG,
      headers: {
        origin: ORIGIN,
        'content-type': 'image/png',
        'x-file-name': 'cut-2.png',
        cookie: alice.cookie,
        [SUPERSEDES_HEADER]: versionId,
      },
    })
  return { t, hub, alice, board, v1, supersede }
}

describe('the review reset of a new version', () => {
  it('runs in the upload’s transaction with the uploader; its items are published after COMMIT', async () => {
    const w = await world()
    expect(calls).toEqual([]) // a fresh upload resets nothing
    const item = {
      id: 'rvi_0123456789abcdefghij',
      boardId: w.board,
      elementId: 'card-1',
    } as unknown as ReviewItem
    answer = () => [item]
    const got = recordEvents(w.hub, w.board)
    const res = await w.supersede(w.v1.versionId)
    expect(res.statusCode, res.body).toBe(201)
    const v2 = res.json() as { versionId: string; assetId: string }
    expect(calls).toEqual([
      {
        reset: {
          workspaceId: DEV_STUDIO,
          boardId: w.board,
          assetId: w.v1.assetId,
          versionId: v2.versionId,
          actorId: w.alice.userId,
        },
        versionRow: { id: v2.versionId, supersedes: w.v1.versionId },
      },
    ])
    expect(got).toEqual([
      { type: ASSET_VERSION_EVENT, data: { assetId: w.v1.assetId, versionId: v2.versionId } },
      { type: REVIEW_ITEM_EVENT, data: { item } },
    ])
  })

  it('a reset that fails rolls the upload back: no row, no blob, no event', async () => {
    const w = await world()
    answer = () => {
      throw new Error('review store down')
    }
    const got = recordEvents(w.hub, w.board)
    const before = await w.t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')
    const res = await w.supersede(w.v1.versionId)
    expect(res.statusCode).toBe(500)
    const after = await w.t.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')
    expect(after.n).toBe(before.n)
    expect(got).toEqual([])
    const v2 = calls[0]?.reset.versionId ?? ''
    expect(await w.t.blobs.head(originalKey(w.v1.assetId, v2))).toBeNull()
  })
})
