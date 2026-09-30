// Bridge release R0, verifier findings on the api (docs/EXCALIDRAW-MIGRATION.md §5.9 step 2, §5.10):
//   - the "unchanged" check of an automatic checkpoint compares with the newest tldraw (v1) checkpoint
//     only: a v2 row with no content hash whose clock happens to equal the board's must not make R0 skip
//     a real checkpoint of edits made during the rollback (verifier, dedupe);
//   - a sync answer that is not a tldraw snapshot (the Excalidraw sync's `lobby-elements` one, while the
//     api and sync deploys of a rollback overlap) is refused as SYNC_UNAVAILABLE, never read as an
//     empty board: no empty checkpoint, duplicate or export (verifier, mixed). On the Excalidraw branch the
//     api reads the `lobby-elements` answer too (sync-internal.ts boardSnapshotOf), so these tests use an
//     answer of neither format, and check that the `lobby-elements` one is read;
//   - a board born on the new canvas gets no connection ticket (409 NEW_CANVAS), so R0's sync never
//     creates tldraw tables for one that has no sync file yet (verifier, born-after without a file).
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { NEW_CANVAS_BOARD_MESSAGE } from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { checkpointServices } from '../../../src/features/history/index.ts'
import { snapshotStorageKey } from '../../../src/features/history/snapshot-store.ts'
import { createHttpSyncInternalClient, SyncUnavailable } from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from './helpers.ts'

let api: TestApi
let sync: FakeSync
let bob: Client
let boardId: string
/** Boards for which the fake sync answers in a format of neither canvas (never read as an empty board). */
const newFormat = new Set<string>()
const saved = { ...checkpointSettings }

/** An answer of neither canvas format (a newer engine's, say). */
const OTHER_SNAPSHOT = { format: 'lobby-elements-v9', clock: 7, items: [{ id: 'r1' }] }

const LOBBY_SNAPSHOT = {
  format: 'lobby-elements',
  schema: 1,
  clock: 7,
  elements: [{ id: 'r1', type: 'rectangle' }],
  doc: {},
}

beforeEach(async () => {
  Object.assign(checkpointSettings, { tickMs: 0, pruneEveryMs: 0 })
  sync = createFakeSync()
  const snapshot = sync.snapshot
  sync.snapshot = async (id) => {
    if (newFormat.has(id)) return structuredClone(OTHER_SNAPSHOT) as never
    return snapshot(id)
  }
  newFormat.clear()
  api = await createTestApi({ deps: { syncInternal: sync } })
  await api.login('alice') // owns Dev Studio
  bob = await api.login('bob')
  boardId = await createBoard(bob, DEV_STUDIO, 'Pitch')
  sync.setBoard(boardId, [...baseRecords(), noteRec('n1', 'hello')])
})
afterEach(async () => {
  Object.assign(checkpointSettings, saved)
  await api.close()
})

const code = (res: { json(): unknown }) => (res.json() as { error?: { code?: string } }).error?.code
const snapshotCount = async () =>
  (
    await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_snapshots WHERE board_id = $1', [
      boardId,
    ])
  ).n

describe('the unchanged check of an automatic checkpoint', () => {
  it('ignores a newer v2 checkpoint (no content hash, the same clock) and saves the tldraw one', async () => {
    const id = newId('snp')
    const key = snapshotStorageKey(boardId, id)
    const body = JSON.stringify({
      format: 'lobby-checkpoint',
      version: 2,
      boardId,
      clock: 42,
      elements: [],
      doc: {},
    })
    await api.blobs.put(key, Buffer.from(body), {
      contentType: 'application/json',
      contentLength: body.length,
    })
    // the fake board's tldraw documentClock is 42 (helpers.ts setBoard)
    await api.db.query(
      `INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, reason, created_by, created_at,
         document_clock, record_count, size_bytes, storage_key, content_hash, body_version)
       VALUES ($1, $2, $3, 'Hourly checkpoint', 'auto', 'hourly', NULL, $6, 42, 1, $4, $5, NULL, 2)`,
      [id, DEV_STUDIO, boardId, body.length, key, new Date(api.clock.now().getTime() - 60_000)],
    )
    const service = checkpointServices.get(api.app)
    const outcome = await service?.capture(boardId, 'hourly')
    expect(outcome?.status).toBe('saved')
    // and a second capture of the same tldraw content is unchanged (compared with that v1 checkpoint)
    expect(await service?.capture(boardId, 'hourly')).toEqual({ status: 'unchanged' })
  })
})

describe('a snapshot answer of neither canvas format', () => {
  it('is refused as SYNC_UNAVAILABLE: no empty checkpoint, duplicate or export', async () => {
    newFormat.add(boardId)
    const before = await snapshotCount()
    const save = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'x' })
    expect([save.statusCode, code(save)]).toEqual([503, 'SYNC_UNAVAILABLE'])
    const dup = await bob.req('POST', `/api/boards/${boardId}/duplicate`, {})
    expect([dup.statusCode, code(dup)]).toEqual([503, 'SYNC_UNAVAILABLE'])
    const exp = await bob.req('GET', `/api/boards/${boardId}/export`)
    expect([exp.statusCode, code(exp)]).toEqual([503, 'SYNC_UNAVAILABLE'])
    await expect(checkpointServices.get(api.app)?.capture(boardId, 'hourly')).rejects.toBeInstanceOf(
      SyncUnavailable,
    )
    expect(await snapshotCount()).toBe(before)
    expect(sync.seeds).toEqual([])
    // back on a tldraw sync, everything works again
    newFormat.clear()
    expect((await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'x' })).statusCode).toBe(201)
  })

  it('the HTTP client refuses a 200 answer of neither format, and reads the lobby-elements one', async () => {
    let answer: unknown = OTHER_SNAPSHOT
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const client = createHttpSyncInternalClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        secret: 's'.repeat(40),
      })
      await expect(client.snapshot('b-lobby0001')).rejects.toBeInstanceOf(SyncUnavailable)
      answer = LOBBY_SNAPSHOT
      await expect(client.snapshot('b-lobby0001')).resolves.toEqual(LOBBY_SNAPSHOT)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})

describe('a board born on the new canvas', () => {
  it('gets no connection ticket (409 NEW_CANVAS); other boards still do', async () => {
    await api.db.query('UPDATE boards SET new_canvas = true WHERE id = $1', [boardId])
    const refused = await bob.req('POST', `/api/boards/${boardId}/ticket`)
    expect([refused.statusCode, code(refused)]).toEqual([409, 'NEW_CANVAS'])
    expect((refused.json() as { error: { message: string } }).error.message).toBe(NEW_CANVAS_BOARD_MESSAGE)
    const other = await createBoard(bob, DEV_STUDIO, 'Other')
    expect((await bob.req('POST', `/api/boards/${other}/ticket`)).statusCode).toBe(200)
    // no access still answers 404, whatever the board is (no probing)
    const carol = await api.login('carol')
    expect((await carol.req('POST', `/api/boards/${boardId}/ticket`)).statusCode).toBe(404)
  })
})
