// End to end over real HTTP: this API process talking to a real sync server (apps/sync) for
// checkpoints, restore-as-new, duplicate, export/import and "Recently deleted".
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSyncServer, type SyncServer } from '../../../../sync/src/app.ts'
import { arrow, arrowBinding, geo, note, RoomClient } from '../../../../sync/test/deleted/fixtures.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
  TICKET_SECRET,
} from '../../helpers.ts'

let syncDir: string
let sync: SyncServer
let api: TestApi
let bob: Client
let boardId: string

beforeEach(async () => {
  syncDir = mkdtempSync(join(tmpdir(), 'dr-history-sync-'))
  sync = createSyncServer(
    {
      host: '127.0.0.1',
      port: 0,
      dataDir: syncDir,
      idleEvictMs: 60_000,
      textLeaseMs: 5_000,
      ticketSecret: TICKET_SECRET,
      internalSecret: INTERNAL_SECRET,
      apiInternalUrl: 'http://127.0.0.1:9',
      accessRecheckMs: 60_000,
    },
    { log: () => {} },
  )
  const { port } = await sync.listen()
  api = await createTestApi({ env: { DRAFTROOM_SYNC_INTERNAL_URL: `http://127.0.0.1:${port}` } })
  await api.login('owner')
  bob = await api.login('bob')
  boardId = await createBoard(bob, DEV_STUDIO, 'Live board')
})
afterEach(async () => {
  await api.close()
  await sync.close()
  rmSync(syncDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

const shapeIds = (boardId: string) =>
  (sync.registry.snapshot(boardId)?.documents ?? [])
    .map((d) => d.state)
    .filter((s) => s.typeName === 'shape')
    .map((s) => s.id)
    .sort()

describe('history against a real sync server', () => {
  it('checkpoint -> edits -> recently deleted restore -> restore-as-new -> duplicate -> export/import', async () => {
    const room = sync.registry.getOrCreate(boardId)
    const c = new RoomClient(room, bob.userId, { name: 'bob' })
    await c.connect()
    const A = note('A', 'Idea A')
    const B = geo('B', { x: 400, index: 'a2' as never })
    const ar = arrow('ar', { index: 'a3' as never })
    const bind = arrowBinding('b', ar.id, B.id, 'end')
    expect(await c.put(A, B, ar, bind)).toBe('commit')

    const saved = await bob.req('POST', `/api/boards/${boardId}/snapshots`, { name: 'Three shapes' })
    expect(saved.statusCode).toBe(201)
    expect(saved.json().recordCount).toBe(2 + 3 + 1) // document + page + shapes + binding

    // after the checkpoint: B is deleted (tldraw deletes its binding in the same push)
    expect(await c.push({ [B.id]: ['remove'], [bind.id]: ['remove'] })).toBe('commit')
    const listed = await bob.req('GET', `/api/boards/${boardId}/deleted`)
    expect(listed.statusCode).toBe(200)
    expect(listed.json().entries).toMatchObject([
      { shapeId: B.id, type: 'geo', deletedBy: { id: bob.userId, name: 'bob' } },
    ])

    const restored = await bob.req('POST', `/api/boards/${boardId}/deleted/restore`, { ids: [B.id] })
    expect(restored.json()).toEqual({ restored: [B.id], skipped: [], bindings: 1, reparented: 0 })
    expect(room.getRecord(B.id)).toEqual(B)
    expect(room.getRecord(bind.id)).toEqual(bind)

    // then A is deleted; the checkpoint restores as a new board with everything as it was
    await c.remove(A.id)
    const fromCheckpoint = await bob.req('POST', `/api/snapshots/${saved.json().id}/restore-as-new`, {})
    expect(fromCheckpoint.statusCode).toBe(201)
    const restoredBoard = fromCheckpoint.json().board.id
    expect(shapeIds(restoredBoard)).toEqual([A.id, ar.id, B.id].sort())
    expect(shapeIds(boardId)).toEqual([ar.id, B.id].sort()) // the original is unchanged by it

    // duplicate copies the live board
    const dup = await bob.req('POST', `/api/boards/${boardId}/duplicate`, {})
    expect(dup.statusCode).toBe(201)
    expect(shapeIds(dup.json().board.id)).toEqual([ar.id, B.id].sort())

    // export + import: same content under fresh ids, the connector still bound
    const archive = (await bob.req('GET', `/api/boards/${boardId}/export`)).json()
    const imported = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import`, archive)
    expect(imported.statusCode).toBe(201)
    const snap = sync.registry.snapshot(imported.json().board.id)
    const records = (snap?.documents ?? []).map((d) => d.state)
    const shapes = records.filter((r) => r.typeName === 'shape')
    expect(shapes).toHaveLength(2)
    expect(shapes.some((s) => s.id === B.id || s.id === ar.id)).toBe(false)
    const bindings = records.filter((r) => r.typeName === 'binding') as unknown as {
      fromId: string
      toId: string
    }[]
    expect(bindings).toHaveLength(1)
    expect(new Set(shapes.map((s) => s.id))).toEqual(new Set([bindings[0]?.fromId, bindings[0]?.toId]))
  })

  it('a board whose canvas is still empty duplicates into an empty board', async () => {
    const dup = await bob.req('POST', `/api/boards/${boardId}/duplicate`, { title: 'Blank copy' })
    expect(dup.statusCode).toBe(201)
    expect(shapeIds(dup.json().board.id)).toEqual([])
  })
})
