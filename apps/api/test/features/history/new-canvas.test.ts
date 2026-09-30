// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.5, §5.9 step 4, §5.10): the api understands what
// the Excalidraw build leaves behind, and says so instead of failing.
//   - a v2 checkpoint row (migration 0022 body_version 2) is listed with `newCanvas` ("Made on the new
//     canvas. Preview and restore it when Lobby is back on the new canvas."); previewing or restoring
//     it answers 409 NEW_CANVAS with that message, before anything is read or saved; a v2 body behind a row that says v1 is refused
//     the same way (never restored as an empty board);
//   - the `engine_migration` reason is accepted, listed and kept by retention like a safety checkpoint;
//   - a board born on the new canvas (boards.new_canvas) carries `newCanvas` in every board answer and
//     cannot be duplicated, exported or checkpointed (409 NEW_CANVAS); the automatic checkpoints skip it
//     without asking sync; sync's own 409 `new-canvas` gives the same answer;
//   - an archive exported from the new canvas is refused on import with a clear message;
//   - tldraw boards and v1 checkpoints answer exactly as before (no new field).
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  NEW_CANVAS_ARCHIVE_MESSAGE,
  NEW_CANVAS_BOARD_MESSAGE,
  NEW_CANVAS_CHECKPOINT_MESSAGE,
} from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { checkpointServices } from '../../../src/features/history/index.ts'
import { planRetention } from '../../../src/features/history/retention.ts'
import { snapshotStorageKey } from '../../../src/features/history/snapshot-store.ts'
import {
  createHttpSyncInternalClient,
  SyncNewCanvasBoard,
  SyncUnavailable,
} from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from './helpers.ts'

let api: TestApi
let sync: FakeSync
let bob: Client
let boardId: string
/** Boards the fake sync refuses the way R0's sync refuses a board born on the new canvas. */
const refusedBySync = new Set<string>()
const saved = { ...checkpointSettings }

beforeEach(async () => {
  Object.assign(checkpointSettings, { tickMs: 0, pruneEveryMs: 0 })
  sync = createFakeSync()
  const snapshot = sync.snapshot
  sync.snapshot = async (id) => {
    if (refusedBySync.has(id)) throw new SyncNewCanvasBoard()
    return snapshot(id)
  }
  refusedBySync.clear()
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
const message = (res: { json(): unknown }) => (res.json() as { error?: { message?: string } }).error?.message

/** A checkpoint row as the Excalidraw build writes one (v2 body in the blob store). */
async function v2Checkpoint(
  opts: { reason?: 'engine_migration' | 'hourly' | null; bodyVersion?: 1 | 2 } = {},
) {
  const id = newId('snp')
  const key = snapshotStorageKey(boardId, id)
  const body = JSON.stringify({
    format: 'lobby-checkpoint',
    version: 2,
    boardId,
    clock: 3,
    schema: 1,
    elements: [{ id: 'r1', type: 'rectangle' }],
    doc: {},
  })
  await api.blobs.put(key, Buffer.from(body), { contentType: 'application/json', contentLength: body.length })
  const reason = opts.reason === undefined ? 'engine_migration' : opts.reason
  await api.db.query(
    `INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, reason, created_by, created_at,
       document_clock, record_count, size_bytes, storage_key, body_version)
     VALUES ($1, $2, $3, 'Moved to the new canvas', $4, $5, $6, now(), 3, 1, $7, $8, $9)`,
    [
      id,
      DEV_STUDIO,
      boardId,
      reason ? 'auto' : 'manual',
      reason,
      reason ? null : bob.userId,
      body.length,
      key,
      opts.bodyVersion ?? 2,
    ],
  )
  return id
}

const list = async () => {
  const res = await bob.req('GET', `/api/boards/${boardId}/snapshots`)
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as { snapshots: Array<Record<string, unknown>> }).snapshots
}
const boardCount = async () => (await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')).n

describe('checkpoints made on the new canvas (v2)', () => {
  it('are listed with newCanvas and the engine_migration reason; v1 checkpoints carry no new field', async () => {
    const v1 = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'Draft' })
    expect(v1.statusCode, v1.body).toBe(201)
    expect(v1.json()).not.toHaveProperty('newCanvas')
    const v2 = await v2Checkpoint()
    const rows = await list()
    expect(rows.map((r) => [r.id, r.reason, r.newCanvas])).toEqual(
      expect.arrayContaining([
        [v2, 'engine_migration', true],
        [v1.json().id, null, undefined],
      ]),
    )
    expect(rows.find((r) => r.id === v1.json().id)).not.toHaveProperty('newCanvas')
    expect(NEW_CANVAS_CHECKPOINT_MESSAGE).toBe(
      'Made on the new canvas. Preview and restore it when Lobby is back on the new canvas.',
    )
  })

  it('refuse preview and restore with 409 NEW_CANVAS and the message, before anything is saved', async () => {
    const v2 = await v2Checkpoint({ reason: null })
    const preview = await bob.req('GET', `/api/snapshots/${v2}/content`)
    expect(preview.statusCode).toBe(409)
    expect(code(preview)).toBe('NEW_CANVAS')
    expect(message(preview)).toBe(NEW_CANVAS_CHECKPOINT_MESSAGE)
    const boards = await boardCount()
    const snapshotsBefore = (await list()).length
    const restore = await bob.req('POST', `/api/snapshots/${v2}/restore-as-new`, {})
    expect(restore.statusCode).toBe(409)
    expect(code(restore)).toBe('NEW_CANVAS')
    expect(message(restore)).toBe(NEW_CANVAS_CHECKPOINT_MESSAGE)
    expect(await boardCount()).toBe(boards)
    expect((await list()).length).toBe(snapshotsBefore) // no before_restore checkpoint either
    expect(sync.seeds).toEqual([])
  })

  it('refuse a v2 body even behind a row that says v1 (never restored as an empty board)', async () => {
    const hidden = await v2Checkpoint({ reason: null, bodyVersion: 1 })
    expect((await list()).find((r) => r.id === hidden)).not.toHaveProperty('newCanvas')
    const preview = await bob.req('GET', `/api/snapshots/${hidden}/content`)
    expect([preview.statusCode, code(preview)]).toEqual([409, 'NEW_CANVAS'])
    const restore = await bob.req('POST', `/api/snapshots/${hidden}/restore-as-new`, {})
    expect([restore.statusCode, code(restore)]).toEqual([409, 'NEW_CANVAS'])
    expect(sync.seeds).toEqual([])
  })

  it('can still be deleted by an owner, and a v1 checkpoint still previews and restores', async () => {
    const v2 = await v2Checkpoint({ reason: null })
    expect((await bob.req('DELETE', `/api/snapshots/${v2}`)).statusCode).toBe(204)
    const v1 = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'Draft' })
    const id = v1.json().id as string
    expect((await bob.req('GET', `/api/snapshots/${id}/content`)).statusCode).toBe(200)
    const restored = await bob.req('POST', `/api/snapshots/${id}/restore-as-new`, {})
    expect(restored.statusCode, restored.body).toBe(201)
  })

  it('engine_migration checkpoints are kept like the other safety checkpoints', () => {
    const at = new Date('2026-09-29T10:59:00Z')
    const plan = planRetention(
      [
        { id: 'snp_a', reason: 'engine_migration', createdAt: new Date('2026-09-29T10:05:00Z') },
        { id: 'snp_b', reason: 'hourly', createdAt: new Date('2026-09-29T10:50:00Z') },
        { id: 'snp_c', reason: 'hourly', createdAt: new Date('2026-09-29T10:10:00Z') },
      ],
      at,
    )
    expect(plan.keep.sort()).toEqual(['snp_a', 'snp_b'])
    expect(plan.remove).toEqual(['snp_c'])
  })
})

describe('boards born on the new canvas', () => {
  const markNewCanvas = () => api.db.query('UPDATE boards SET new_canvas = true WHERE id = $1', [boardId])

  it('carry newCanvas in every board answer; other boards do not', async () => {
    const other = await createBoard(bob, DEV_STUDIO, 'Other')
    await markNewCanvas()
    const one = await bob.req('GET', `/api/boards/${boardId}`)
    expect(one.statusCode, one.body).toBe(200)
    expect(JSON.stringify(one.json())).toContain('"newCanvas":true')
    const listed = await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)
    expect(listed.statusCode, listed.body).toBe(200)
    const boards = (listed.json() as { boards: Array<{ id: string; newCanvas?: boolean }> }).boards
    expect(boards.find((b) => b.id === boardId)?.newCanvas).toBe(true)
    expect(boards.find((b) => b.id === other)).not.toHaveProperty('newCanvas')
    expect(NEW_CANVAS_BOARD_MESSAGE).toBe(
      'This board was made on the new canvas. It opens again when Lobby is back on the new canvas.',
    )
  })

  it('cannot be duplicated, exported or checkpointed (409 NEW_CANVAS), without asking sync', async () => {
    await markNewCanvas()
    sync.snapshots.length = 0
    for (const [method, url, body] of [
      ['POST', `/api/boards/${boardId}/duplicate`, {}],
      ['GET', `/api/boards/${boardId}/export`, undefined],
      ['POST', `/api/boards/${boardId}/snapshots`, { name: 'x' }],
    ] as const) {
      const res = await bob.req(method, url, body)
      expect({ url, status: res.statusCode, code: code(res) }).toEqual({
        url,
        status: 409,
        code: 'NEW_CANVAS',
      })
      expect(message(res)).toBe(NEW_CANVAS_BOARD_MESSAGE)
    }
    expect(sync.snapshots).toEqual([])
  })

  it('the automatic checkpoints skip them and keep them pending, without asking sync', async () => {
    await markNewCanvas()
    const service = checkpointServices.get(api.app)
    sync.snapshots.length = 0
    expect(await service?.capture(boardId, 'hourly')).toEqual({ status: 'skipped', why: 'new-canvas' })
    await service?.sessionEnded(boardId, api.clock.now())
    await service?.idle()
    await service?.runDue()
    expect(sync.snapshots).toEqual([])
    const state = await api.db.one<{ dirty: boolean; retry_at: Date | null }>(
      'SELECT dirty_since IS NOT NULL AS dirty, retry_at FROM board_checkpoint_state WHERE board_id = $1',
      [boardId],
    )
    expect(state.dirty).toBe(true)
    expect(state.retry_at?.getTime()).toBeGreaterThan(api.clock.now().getTime())
  })

  it('a board the sync server refuses as new-canvas gets the same answer, even when not marked', async () => {
    refusedBySync.add(boardId)
    for (const [method, url, body] of [
      ['POST', `/api/boards/${boardId}/duplicate`, {}],
      ['GET', `/api/boards/${boardId}/export`, undefined],
      ['POST', `/api/boards/${boardId}/snapshots`, { name: 'x' }],
    ] as const) {
      const res = await bob.req(method, url, body)
      expect({ url, status: res.statusCode, code: code(res) }).toEqual({
        url,
        status: 409,
        code: 'NEW_CANVAS',
      })
    }
    expect(await checkpointServices.get(api.app)?.capture(boardId, 'hourly')).toEqual({
      status: 'skipped',
      why: 'new-canvas',
    })
  })
})

describe('archives exported from the new canvas', () => {
  it('are refused on import with a clear message; a v1 archive still imports', async () => {
    const res = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import`, {
      format: 'lobby-board',
      version: 2,
      engine: 'excalidraw',
      engineVersion: '0.18.0-1118751',
      schema: 1,
      exportedAt: new Date().toISOString(),
      elements: [],
      doc: {},
      assets: [],
    })
    expect(res.statusCode).toBe(400)
    expect(code(res)).toBe('NEW_CANVAS_ARCHIVE')
    expect(message(res)).toBe(NEW_CANVAS_ARCHIVE_MESSAGE)
    const exported = await bob.req('GET', `/api/boards/${boardId}/export`)
    expect(exported.statusCode, exported.body).toBe(200)
    const imported = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import`, exported.json())
    expect(imported.statusCode, imported.body).toBe(201)
  })
})

describe('the HTTP sync client', () => {
  it('turns sync’s 409 new-canvas into SyncNewCanvasBoard (a SyncUnavailable) and other failures into SyncUnavailable', async () => {
    const server = createServer((req, res) => {
      const refused = req.url?.includes('b-refused')
      res.writeHead(refused ? 409 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: refused ? 'new-canvas' : 'SHUTTING_DOWN', message: 'x' } }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const client = createHttpSyncInternalClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        secret: 's'.repeat(40),
      })
      for (const call of [
        () => client.snapshot('b-refused1'),
        () => client.boardText?.('b-refused1'),
        () => client.assetRefs?.('b-refused1'),
        () => client.placeNotes?.('b-refused1', {}),
      ]) {
        const e = await call()?.then(
          () => null,
          (err: unknown) => err,
        )
        expect(e).toBeInstanceOf(SyncNewCanvasBoard)
        expect(e).toBeInstanceOf(SyncUnavailable)
        expect((e as SyncUnavailable).status).toBe(409)
      }
      const other = await client.snapshot('b-other001').then(
        () => null,
        (err: unknown) => err,
      )
      expect(other).toBeInstanceOf(SyncUnavailable)
      expect(other).not.toBeInstanceOf(SyncNewCanvasBoard)
      expect((other as SyncUnavailable).status).toBe(503)
    } finally {
      await new Promise((r) => server.close(r))
    }
  })
})
