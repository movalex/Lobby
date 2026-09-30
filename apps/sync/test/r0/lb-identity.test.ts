// Bridge release R0 gate (docs/EXCALIDRAW-MIGRATION.md §5.9 step 2, §5.10): R0 serves a converted board
// from its tldraw tables and NEVER writes, trims or alters any lb_* table. The board file here holds every
// lb_* table (lb_meta, lb_elements, lb_doc, lb_deleted, lb_source and one roll-forward's lb_prev_1_*),
// with rows. After R0 served it (socket edits and deletes, every internal board route), backed it up
// (periodic, before idle eviction, on demand, run-all), trimmed it ("Recently deleted" trims, tombstone
// pruning), switched maintenance on and off, crashed and restarted, each lb_* table has the same schema
// SQL and the same row digest, every lb_* index and AUTOINCREMENT counter is unchanged, and the table
// list is the same. `dr_deleted_*` change only by R0's own rows.
import { join } from 'node:path'
import { draftroomSchema } from '@draftroom/canvas-schema'
import type { TLRecord } from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { inspectBoardDb, readManifest } from '../../src/backup/backup.ts'
import { boardDbPath, RoomRegistry } from '../../src/rooms.ts'
import { geo, note, RoomClient, until } from '../deleted/fixtures.ts'
import { useProtocolHarness } from '../harness/fixture.ts'
import { geoShape, noteShape } from '../harness/records.ts'
import { callInternal } from '../harness/tickets.ts'
import { runAllOverHttp } from './run-all-http.ts'
import {
  ALL_LB_TABLES,
  lbState,
  markConverted,
  seedTldrawBoard,
  tableState,
  tablesOf,
  tempDir,
} from './support.ts'

describe('a converted board in the room registry', () => {
  it('keeps every lb_* table byte-identical while served, trimmed, backed up, evicted and reopened', async () => {
    const dataDir = tempDir()
    const boardId = 'b-lbident01'
    const path = seedTldrawBoard(dataDir, boardId, [
      geo('g1') as TLRecord,
      note('n1', 'first') as TLRecord,
      note('n2', 'second') as TLRecord,
    ])
    markConverted(path)
    const before = lbState(path)
    expect(Object.keys(before.lb)).toEqual([...ALL_LB_TABLES])
    expect(before.lbSequences).toEqual([{ name: 'lb_deleted', seq: 1 }])
    const tables = tablesOf(path)
    const deletedBefore = tableState(path, 'dr_deleted_records')

    const backups = join(dataDir, 'backups')
    const open = () =>
      new RoomRegistry({
        dataDir,
        schema: draftroomSchema,
        idleEvictMs: 50,
        backup: { dir: backups, intervalMs: 60_000, evictBackupMinOpenMs: 0 },
        // tiny limits: every delete below trims "Recently deleted"
        deleted: { retainRecent: 1, hardCap: 2, perPush: 10, trimEvery: 1 },
      })
    let reg = open()
    try {
      const room = reg.getOrCreate(boardId)
      const a = new RoomClient(room, 'usr_a')
      await a.connect()
      for (let i = 0; i < 6; i++) expect(await a.put(note(`x${i}`, `note ${i}`) as TLRecord)).toBe('commit')
      for (let i = 0; i < 6; i++) expect(await a.remove(`shape:x${i}`)).toBe('commit')
      await a.remove('shape:n1')
      await new Promise((r) => setImmediate(r)) // the scheduled trims run
      expect(reg.listDeleted(boardId).total).toBeGreaterThan(0)
      expect(reg.restoreDeleted(boardId, ['shape:n1']).restored).toContain('shape:n1')
      reg.scanRecords(
        boardId,
        () => {},
        () => {},
      )
      await reg.backupNow(boardId)
      await reg.backupFresh(boardId)
      await reg.runBackupPass()
      room.closeSession(a.sessionId)
      // idle eviction: backup before close, tombstone prune flushed on close
      await until(() => !reg.has(boardId), 10_000)
    } finally {
      reg.closeAll()
    }
    // closed, not open: run-all's read-only path, then the room again after a "restart"
    reg = open()
    try {
      await reg.backupFresh(boardId)
      expect(reg.snapshot(boardId)?.documents.some((d) => d.state.id === 'shape:n1')).toBe(true)
    } finally {
      reg.closeAll()
    }

    expect(lbState(path)).toEqual(before)
    expect(tablesOf(path)).toEqual(tables)
    // R0 did manage its own "Recently deleted" (captured, trimmed, restored)
    expect(tableState(path, 'dr_deleted_records')).not.toEqual(deletedBefore)
    // every backup copied the lb_* tables whole
    const manifest = readManifest(backups, boardId)
    expect(manifest?.backups.length).toBeGreaterThanOrEqual(3)
    for (const b of manifest?.backups ?? []) {
      const copy = join(backups, boardId, b.file)
      expect(lbState(copy).lb).toEqual(before.lb)
      expect(b.format).toBeUndefined() // a converted board is backed up as the tldraw board R0 serves
      expect(inspectBoardDb(copy).recordsSha256).toBe(b.recordsSha256)
    }
  })
})

describe('a converted board in the real sync process', () => {
  const h = useProtocolHarness()

  it('keeps every lb_* table byte-identical through sockets, internal routes, maintenance, run-all and a crash', async () => {
    const dataDir = h.dataDir()
    const boardId = 'b-lbident02'
    const rooms = join(dataDir, 'rooms')
    const path = seedTldrawBoard(rooms, boardId, [noteShape('n1', 'hello') as unknown as TLRecord])
    markConverted(path)
    const before = lbState(path)
    const tables = tablesOf(path)
    const server = await h.server({
      dataDir,
      env: { DRAFTROOM_BACKUP_INTERVAL_MS: '1000', DRAFTROOM_BACKUP_STORE: 'fs', IDLE_EVICT_MS: '300' },
    })

    const a = await h.connected(server, { boardId, user: 'usr_alice' })
    a.put(geoShape('g1'), geoShape('g2', { x: 200 }))
    await a.waitForAcked()
    a.remove('shape:g2')
    a.update('shape:n1', (s) => ({ ...s, x: 50 }))
    await a.waitForAcked()

    const get = (p: string) => callInternal(server.url, 'GET', `/internal/boards/${boardId}${p}`)
    expect((await get('/snapshot')).status).toBe(200)
    expect((await get('/text')).status).toBe(200)
    expect((await get('/asset-refs')).status).toBe(200)
    expect((await get('/deleted')).status).toBe(200)
    const restored = await callInternal(server.url, 'POST', `/internal/boards/${boardId}/deleted/restore`, {
      body: { ids: ['shape:g2'] },
    })
    expect(restored.status).toBe(200)
    const placed = await callInternal(server.url, 'POST', `/internal/boards/${boardId}/place-notes`, {
      body: {
        sessionId: 'pbs_0000000001',
        anonymous: true,
        frame: { id: 'shape:frame1', pageId: 'page:page', x: 0, y: 400, w: 400, h: 300, name: 'Ideas' },
        notes: [{ id: 'pnt_0000000001', text: 'idea', color: 'yellow', authorId: null }],
        authors: [],
      },
    })
    expect(placed.status).toBe(200)

    const on = await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: true } })
    expect(await on.json()).toEqual({ maintenance: true, closedSockets: 1 })
    expect((await runAllOverHttp(server.url)).ok).toBe(true)
    await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: false } })

    // a second session edits, the process crashes with the room open, restarts and serves again
    const b = await h.connected(server, { boardId, user: 'usr_bob' })
    b.put(geoShape('g3', { x: 400 }))
    await b.waitForAcked()
    await new Promise((r) => setTimeout(r, 1_500)) // a periodic backup pass
    await server.kill('SIGKILL')
    b.dispose()
    await server.restart()
    const c = await h.connected(server, { boardId, user: 'usr_carol' })
    expect(c.get('shape:g3')).toBeDefined()
    c.remove('shape:g3')
    await c.waitForAcked()
    c.dispose()
    await new Promise((r) => setTimeout(r, 1_000)) // idle eviction (backup first)
    await server.kill('SIGINT')

    expect(lbState(path)).toEqual(before)
    expect(tablesOf(path)).toEqual(tables)
    const manifest = readManifest(join(dataDir, 'backups'), boardId)
    for (const entry of manifest?.backups ?? [])
      expect(lbState(join(dataDir, 'backups', boardId, entry.file)).lb).toEqual(before.lb)
    expect(boardDbPath(rooms, boardId)).toBe(path)
  })
})
