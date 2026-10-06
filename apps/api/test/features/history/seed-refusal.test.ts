// J4 IMPORT-V1-SYNC-BLOCK, the api's side: the sync server converts a v1 body in a worker with limits and
// answers 413 / 422 when the board is past them (apps/sync/test/room-internal/seed-v1-limits.test.ts). The
// api's sync client reports every failed seed as SyncUnavailable ("seed failed with <status>"), which the
// history routes used to turn into "the board server is not reachable, try again" for a board that will
// never convert. new-board.ts now tells the person what is wrong.
import { afterEach, describe, expect, it } from 'vitest'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { seedRefusal } from '../../../src/features/history/new-board.ts'
import { SyncUnavailable } from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from './helpers.ts'

let api: TestApi | null = null
const saved = { ...checkpointSettings }
afterEach(async () => {
  Object.assign(checkpointSettings, saved)
  await api?.close()
  api = null
})

describe('seedRefusal', () => {
  it('413 is too large, 422 too complex; anything else (and a sync that did not answer) is not a refusal of the content', () => {
    expect(seedRefusal(new SyncUnavailable('seed failed with 413'))).toMatchObject({
      status: 413,
      code: 'IMPORT_TOO_LARGE',
    })
    expect(seedRefusal(new SyncUnavailable('seed failed with 422'))).toMatchObject({
      status: 422,
      code: 'IMPORT_TOO_COMPLEX',
    })
    expect(seedRefusal(new SyncUnavailable('anything', 413))).toMatchObject({ code: 'IMPORT_TOO_LARGE' })
    for (const message of [
      'seed failed with 503',
      'seed failed with 400',
      'sync unreachable: TimeoutError',
      '',
    ])
      expect(seedRefusal(new SyncUnavailable(message)), message).toBeNull()
    expect(seedRefusal(new SyncUnavailable('seed failed with 413: more'))).toBeNull()
  })
})

describe('restoring a v1 checkpoint as a new board when the sync server refuses to convert it', () => {
  async function world() {
    Object.assign(checkpointSettings, { tickMs: 0, pruneEveryMs: 0 })
    const sync: FakeSync = createFakeSync()
    api = await createTestApi({ deps: { syncInternal: sync } })
    await api.login('alice')
    const bob: Client = await api.login('bob')
    const board = await createBoard(bob, DEV_STUDIO, 'Pitch')
    sync.setBoard(board, [...baseRecords(), noteRec('n1', 'Launch plan')])
    const made = await bob.req('POST', `/api/boards/${board}/snapshots`, { name: 'Before' })
    expect(made.statusCode, made.body).toBe(201)
    return { sync, bob, sid: made.json().id as string }
  }

  for (const [status, code, text] of [
    [413, 'IMPORT_TOO_LARGE', /too large to convert/],
    [422, 'IMPORT_TOO_COMPLEX', /takes too long to convert/],
  ] as const) {
    it(`${status}: ${code} with a message that says why, not "not reachable"`, async () => {
      const w = await world()
      w.sync.seed = async () => {
        throw new SyncUnavailable(`seed failed with ${status}`)
      }
      const res = await w.bob.req('POST', `/api/snapshots/${w.sid}/restore-as-new`, {})
      expect(res.statusCode, res.body).toBe(status)
      expect(res.json().error.code).toBe(code)
      expect(res.json().error.message).toMatch(text)
    })
  }

  it('a sync server that is not reachable (or busy: 503) is still 503 SYNC_UNAVAILABLE, to try again', async () => {
    const w = await world()
    w.sync.seed = async () => {
      throw new SyncUnavailable('seed failed with 503')
    }
    const res = await w.bob.req('POST', `/api/snapshots/${w.sid}/restore-as-new`, {})
    expect(res.statusCode, res.body).toBe(503)
    expect(res.json().error.code).toBe('SYNC_UNAVAILABLE')
  })
})
