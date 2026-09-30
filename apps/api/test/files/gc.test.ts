// UPL-1: the collector of uploaded files nothing references any more (src/files/gc.ts). Report-first:
// it marks versions unreferenced, clears the mark as soon as a pass sees a reference again, and deletes
// (original, previews, rows, with an audit event) only in delete mode after 30 days unreferenced.
// Every reference source is exercised, plus restore-after-mark, a race with a new reference, and an
// unreadable board. The sync server is a fake whose canvases are plain record lists; its answer follows
// the same rule as apps/sync/src/http/asset-refs.ts (the sync tests cover the real endpoint).

import type { AssetGcReport, WorkspaceStorage } from '@draftroom/contracts'
import { newId as newDbId } from '@draftroom/db'
import type { AssetVersionMeta } from '@draftroom/dev-assets'
import { newId } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { snapshotStorageKey } from '../../src/features/history/snapshot-store.ts'
import { derivativeKey, originalKey } from '../../src/files/blobs.ts'
import { type AssetGcDeps, collectWorkspace, createAssetGc, type GcPassMode } from '../../src/files/gc.ts'
import { type VersionRef, versionsInRecords } from '../../src/files/gc-refs.ts'
import { SyncUnavailable } from '../../src/sync-internal.ts'
import { guestLink, joinAsGuest } from '../features/guests/support.ts'
import {
  baseRecords,
  createFakeSync,
  fileCardRec,
  imageAssetRec,
  imageRec,
  type Rec,
  upload,
} from '../features/history/helpers.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../helpers.ts'

const DAY = 86_400_000

/** The fake sync server plus the asset-refs endpoint and a "Recently deleted" per board. */
function gcSync() {
  const base = createFakeSync()
  const deleted = new Map<string, VersionRef[]>()
  const failing = new Set<string>()
  let calls = 0
  const sync = Object.assign(base, {
    deleted,
    failing,
    /** Called before each answer with the running call count (to change the world mid-pass). */
    onAssetRefs: null as null | ((boardId: string, call: number) => Promise<void> | void),
    /** Boards whose file also holds the new canvas's tables (converted; R0's sync says so). */
    converted: new Set<string>(),
    async assetRefs(boardId: string) {
      calls++
      await sync.onAssetRefs?.(boardId, calls)
      if (failing.has(boardId)) throw new SyncUnavailable('sync unreachable: test')
      return {
        boardId,
        exists: base.boards.has(boardId),
        canvas: versionsInRecords(base.records(boardId)),
        deleted: deleted.get(boardId) ?? [],
        unusedAssetRecords: [],
        ...(sync.converted.has(boardId) ? { newCanvasTables: true } : {}),
      }
    },
  })
  return sync
}
type GcSync = ReturnType<typeof gcSync>

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

const silent = { info: () => {}, warn: () => {} }

interface World {
  api: TestApi
  sync: GcSync
  alice: Client
  bob: Client
  board: string
  deps: AssetGcDeps
  collect(mode?: GcPassMode): ReturnType<typeof collectWorkspace>
  marks(): Promise<Record<string, Date | null>>
}

async function world(env: Record<string, string> = {}): Promise<World> {
  const sync = gcSync()
  api = await createTestApi({ deps: { syncInternal: sync }, env })
  const a = api
  const alice = await a.login('alice')
  const bob = await a.login('bob')
  const board = await createBoard(alice, DEV_STUDIO, 'Mood board')
  const deps: AssetGcDeps = {
    db: a.db,
    blobs: a.blobs,
    sync,
    dataRoot: a.config.dataDir,
    now: a.clock.now,
    log: silent,
  }
  return {
    api: a,
    sync,
    alice,
    bob,
    board,
    deps,
    collect: (mode = 'report') => collectWorkspace(deps, DEV_STUDIO, mode),
    async marks() {
      const rows = await a.db.query<{ id: string; unreferenced_since: Date | null }>(
        'SELECT id, unreferenced_since FROM asset_versions WHERE workspace_id = $1',
        [DEV_STUDIO],
      )
      return Object.fromEntries(rows.rows.map((r) => [r.id, r.unreferenced_since]))
    },
  }
}

const card = (m: AssetVersionMeta, id = `c${m.versionId.slice(-6)}`): Rec[] => [
  ...baseRecords(),
  fileCardRec(id, m.assetId, m.versionId),
]
const image = (m: AssetVersionMeta, id = `i${m.versionId.slice(-6)}`): Rec[] => [
  ...baseRecords(),
  imageAssetRec(id, m.assetId, m.versionId),
  imageRec(`s${id}`, id),
]

async function exists(w: World, key: string) {
  return (await w.api.blobs.head(key)) !== null
}

async function addPreview(w: World, m: AssetVersionMeta, bytes = 100) {
  const id = newId('drv')
  const key = derivativeKey(m.assetId, m.versionId, id, 'webp')
  await w.api.blobs.put(key, Buffer.alloc(bytes, 2), { contentType: 'image/webp', contentLength: bytes })
  await w.api.db.query(
    `INSERT INTO asset_derivatives (id, version_id, position, role, page, width, height, mime_type, bytes, blob_key)
     VALUES ($1, $2, 0, 'thumb', NULL, 10, 10, 'image/webp', $3, $4)`,
    [id, m.versionId, bytes, key],
  )
  return key
}

describe('marking (report mode)', () => {
  it('leaves uploads in flight alone, marks an unreferenced one after 7 days, and report mode never deletes', async () => {
    const w = await world()
    const m = await upload(w.api, w.alice, w.board, 'orphan.png')
    let r = await w.collect()
    expect(r).toMatchObject({ complete: true, marked: 0 })
    expect((await w.marks())[m.versionId]).toBeNull()

    w.api.clock.advance(8 * DAY)
    r = await w.collect()
    expect(r).toMatchObject({ complete: true, marked: 1, cleared: 0, deleted: { versions: 0, bytes: 0 } })
    const markedAt = (await w.marks())[m.versionId]
    expect(Math.abs((markedAt?.getTime() ?? 0) - w.api.clock.now().getTime())).toBeLessThan(5_000)

    // 40 days unreferenced, several report passes: still there, bytes and all.
    for (let i = 0; i < 4; i++) {
      w.api.clock.advance(10 * DAY)
      await w.collect()
    }
    expect((await w.marks())[m.versionId]).toEqual(markedAt) // the mark keeps its first date
    expect(await exists(w, originalKey(m.assetId, m.versionId))).toBe(true)
    const alice = await w.api.login('alice') // sessions last 30 days
    expect(
      (await alice.req('GET', `/files/${m.assetId}/${m.versionId}/original?board=${w.board}`)).statusCode,
    ).toBe(200)
  })

  it('every reference source keeps a version; only versions no source names are marked', async () => {
    const w = await world()
    const { api: a, alice, sync } = w
    const other = await createBoard(alice, DEV_STUDIO, 'Another board')
    const vault = await createBoard(alice, DEV_STUDIO, 'Checkpointed')
    const source = await createBoard(alice, DEV_STUDIO, 'Copied')
    const binned = await createBoard(alice, DEV_STUDIO, 'Binned')

    const onCanvas = await upload(a, alice, w.board, 'card.pdf')
    const shownElsewhere = await upload(a, alice, w.board, 'photo.png')
    const inDeleted = await upload(a, alice, w.board, 'deleted.png')
    const inCheckpoint = await upload(a, alice, vault, 'old.png')
    const linked = await upload(a, alice, source, 'copied.png')
    const onTrashedBoard = await upload(a, alice, binned, 'binned.png')
    const leftBehind = await upload(a, alice, w.board, 'left-behind.png') // asset record, no shape
    const nothing = await upload(a, alice, w.board, 'nothing.png')

    sync.setBoard(w.board, [
      ...card(onCanvas),
      imageAssetRec('stale', leftBehind.assetId, leftBehind.versionId), // no shape uses it
    ])
    sync.setBoard(other, image(shownElsewhere)) // any board of the workspace counts
    sync.deleted.set(w.board, [{ assetId: inDeleted.assetId, versionId: inDeleted.versionId }])
    // A checkpoint names it; the canvas no longer does.
    sync.setBoard(vault, image(inCheckpoint))
    expect((await alice.req('POST', `/api/boards/${vault}/snapshots`, { name: 'Before' })).statusCode).toBe(
      201,
    )
    sync.setBoard(vault, baseRecords())
    // A copy (board_asset_links); then neither canvas shows it.
    sync.setBoard(source, card(linked))
    const dup = await alice.req('POST', `/api/boards/${source}/duplicate`, {})
    expect(dup.statusCode, dup.body).toBe(201)
    const copyId = (dup.json() as { board: { id: string } }).board.id
    sync.setBoard(source, baseRecords())
    sync.setBoard(copyId, baseRecords())
    // A trashed board keeps its files (it can be restored).
    expect((await alice.req('POST', `/api/boards/${binned}/trash`)).statusCode).toBe(200)

    a.clock.advance(8 * DAY)
    const r = await w.collect()
    expect(r).toMatchObject({ complete: true, marked: 2, boardsFailed: 0, checkpointsFailed: 0 })
    expect(r?.boardsScanned).toBe(6)
    const marks = await w.marks()
    for (const kept of [onCanvas, shownElsewhere, inDeleted, inCheckpoint, linked, onTrashedBoard])
      expect(marks[kept.versionId], kept.name).toBeNull()
    expect(marks[leftBehind.versionId]).not.toBeNull()
    expect(marks[nothing.versionId]).not.toBeNull()

    // The checkpoint body was read once and remembered.
    const scans = await a.db.query('SELECT snapshot_id FROM asset_gc_snapshot_scans')
    expect(scans.rowCount).toBe(1)
    const reads = vi.spyOn(a.blobs, 'get')
    await w.collect()
    expect(reads.mock.calls.filter(([k]) => String(k).startsWith('snapshots/'))).toEqual([])
  })

  it('clears the mark as soon as a pass sees the version referenced again, and the 30 days start over', async () => {
    const w = await world()
    const m = await upload(w.api, w.alice, w.board, 'back.png')
    w.api.clock.advance(8 * DAY)
    await w.collect('delete')
    expect((await w.marks())[m.versionId]).not.toBeNull()

    // Restored from "Recently deleted" (or undone) 20 days later: referenced again.
    w.api.clock.advance(20 * DAY)
    w.sync.setBoard(w.board, image(m))
    const r = await w.collect('delete')
    expect(r).toMatchObject({ cleared: 1, marked: 0, deleted: { versions: 0 } })
    expect((await w.marks())[m.versionId]).toBeNull()

    // Removed again: a new mark, and the grace period counts from it.
    w.sync.setBoard(w.board, baseRecords())
    w.api.clock.advance(1 * DAY)
    await w.collect('delete')
    w.api.clock.advance(20 * DAY)
    expect((await w.collect('delete'))?.deleted.versions).toBe(0)
    w.api.clock.advance(11 * DAY)
    expect((await w.collect('delete'))?.deleted.versions).toBe(1)
  })
})

describe('deleting (delete mode)', () => {
  it('after 30 days unreferenced: original, previews and rows go, with an audit event; the quota is freed', async () => {
    const w = await world()
    const keep = await upload(w.api, w.alice, w.board, 'keep.png')
    const m = await upload(w.api, w.alice, w.board, 'gone.png')
    const preview = await addPreview(w, m, 300)
    w.sync.setBoard(w.board, card(keep))
    w.api.clock.advance(8 * DAY)
    await w.collect('delete')
    w.api.clock.advance(29 * DAY)
    expect((await w.collect('delete'))?.deleted.versions).toBe(0) // 29 days: not yet
    const alice = await w.api.login('alice') // sessions last 30 days
    const before = (
      await alice.req('GET', `/api/workspaces/${DEV_STUDIO}/storage`)
    ).json() as WorkspaceStorage
    expect(before.gc?.eligible).toEqual({ versions: 0, bytes: 0 })
    expect(before.gc?.unreferenced).toEqual({ versions: 1, bytes: m.sizeBytes + 300 })

    w.api.clock.advance(1 * DAY)
    const r = await w.collect('delete')
    expect(r).toMatchObject({ complete: true, deleted: { versions: 1, bytes: m.sizeBytes + 300 } })
    expect(await exists(w, originalKey(m.assetId, m.versionId))).toBe(false)
    expect(await exists(w, preview)).toBe(false)
    for (const table of ['asset_versions', 'asset_derivatives', 'preview_jobs'])
      expect(
        (
          await w.api.db.query(
            `SELECT 1 FROM ${table} WHERE ${table === 'asset_versions' ? 'id' : 'version_id'} = $1`,
            [m.versionId],
          )
        ).rowCount,
        table,
      ).toBe(0)
    expect((await w.api.db.query('SELECT 1 FROM asset_gc_pending_deletes')).rowCount).toBe(0)
    const audit = await w.api.db.one<{
      actor_id: string | null
      target: string
      detail: Record<string, unknown>
    }>("SELECT actor_id, target, detail FROM audit_events WHERE action = 'asset.gc_delete'")
    expect(audit).toMatchObject({
      actor_id: null,
      target: m.versionId,
      detail: {
        assetId: m.assetId,
        boardId: w.board,
        name: 'gone.png',
        kind: 'image',
        bytes: m.sizeBytes + 300,
      },
    })
    // The kept version is untouched; the deleted one is a plain 404.
    expect(await exists(w, originalKey(keep.assetId, keep.versionId))).toBe(true)
    expect(
      (await alice.req('GET', `/files/${m.assetId}/${m.versionId}/original?board=${w.board}`)).statusCode,
    ).toBe(404)
    const after = (await alice.req('GET', `/api/workspaces/${DEV_STUDIO}/storage`)).json() as WorkspaceStorage
    expect(after.usedBytes).toBe(before.usedBytes - m.sizeBytes - 300)
    expect(after.gc?.lastRun?.deleted).toEqual({ versions: 1, bytes: m.sizeBytes + 300 })
  })

  it('an incomplete pass (a board sync cannot read) clears marks but marks and deletes nothing new', async () => {
    const w = await world()
    const other = await createBoard(w.alice, DEV_STUDIO, 'Unreadable')
    const old = await upload(w.api, w.alice, w.board, 'old.png')
    const back = await upload(w.api, w.alice, w.board, 'back.png')
    w.api.clock.advance(8 * DAY)
    await w.collect('delete')
    const fresh = await upload(w.api, w.alice, w.board, 'fresh.png')
    w.api.clock.advance(31 * DAY)
    w.sync.failing.add(other)
    w.sync.setBoard(w.board, card(back))
    const r = await w.collect('delete')
    expect(r).toMatchObject({
      complete: false,
      boardsFailed: 1,
      marked: 0,
      cleared: 1,
      deleted: { versions: 0 },
    })
    const marks = await w.marks()
    expect(marks[old.versionId]).not.toBeNull() // eligible, but kept: the pass could not see everything
    expect(marks[back.versionId]).toBeNull()
    expect(marks[fresh.versionId]).toBeNull() // unreferenced, but not marked by an incomplete pass
    expect(await exists(w, originalKey(old.assetId, old.versionId))).toBe(true)

    // A sync server without the endpoint (an old deploy) is the same: nothing is guessed.
    w.sync.failing.clear()
    const noEndpoint = collectWorkspace({ ...w.deps, sync: {} }, DEV_STUDIO, 'delete')
    expect(await noEndpoint).toMatchObject({ complete: false, deleted: { versions: 0 } })
    expect(await exists(w, originalKey(old.assetId, old.versionId))).toBe(true)
  })

  it('a reference that appears while the pass runs keeps the version (canvas, then a database link)', async () => {
    const w = await world()
    const onCanvas = await upload(w.api, w.alice, w.board, 'pasted-back.png')
    const linked = await upload(w.api, w.alice, w.board, 'linked.png')
    w.api.clock.advance(8 * DAY)
    await w.collect('delete')
    w.api.clock.advance(31 * DAY)
    // The pass reads the one board twice: once to decide, once more right before deleting. Between
    // the two, someone puts one file back on the canvas; after the second read, a copy links the other.
    let reads = 0
    w.sync.onAssetRefs = async () => {
      if (++reads !== 2) return
      w.sync.setBoard(w.board, card(onCanvas))
      await w.api.db.query(
        `INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)`,
        [DEV_STUDIO, w.board, linked.assetId, linked.versionId],
      )
    }
    const r = await w.collect('delete')
    expect(r?.deleted.versions).toBe(0)
    expect(await exists(w, originalKey(onCanvas.assetId, onCanvas.versionId))).toBe(true)
    expect(await exists(w, originalKey(linked.assetId, linked.versionId))).toBe(true)
    expect(reads).toBe(2)
    // The canvas reference cleared its mark at once; the next pass clears the linked one's too.
    w.sync.onAssetRefs = null
    expect(await w.collect('delete')).toMatchObject({ cleared: 1, deleted: { versions: 0 } })
    expect(Object.values(await w.marks())).toEqual([null, null])
  })

  it('an object delete that fails stays pending and the next delete pass retries it', async () => {
    const w = await world()
    const m = await upload(w.api, w.alice, w.board, 'stubborn.png')
    const key = originalKey(m.assetId, m.versionId)
    w.api.clock.advance(8 * DAY)
    await w.collect('delete')
    w.api.clock.advance(31 * DAY)
    const del = vi.spyOn(w.api.blobs, 'delete').mockRejectedValueOnce(new Error('R2 503'))
    expect((await w.collect('delete'))?.deleted.versions).toBe(1)
    expect(await exists(w, key)).toBe(true)
    expect(
      (
        await w.api.db.query<{ attempts: number }>(
          'SELECT attempts FROM asset_gc_pending_deletes WHERE blob_key = $1',
          [key],
        )
      ).rows,
    ).toEqual([{ attempts: 1 }])
    // Report mode never deletes anything, pending objects included.
    await w.collect('report')
    expect(await exists(w, key)).toBe(true)
    await w.collect('delete')
    expect(await exists(w, key)).toBe(false)
    expect((await w.api.db.query('SELECT 1 FROM asset_gc_pending_deletes')).rowCount).toBe(0)
    del.mockRestore()
  })
})

describe('storage routes', () => {
  it('GET /storage: members see used and quota; owners and admins also see the collector; guests and outsiders do not', async () => {
    const w = await world({ DRAFTROOM_WORKSPACE_QUOTA_MB: '100', DRAFTROOM_WORKSPACE_MAX_BOARDS: '500' })
    const m = await upload(w.api, w.alice, w.board, 'one.png')
    await addPreview(w, m, 250)
    const owner = (
      await w.alice.req('GET', `/api/workspaces/${DEV_STUDIO}/storage`)
    ).json() as WorkspaceStorage
    expect(owner).toEqual({
      workspaceId: DEV_STUDIO,
      usedBytes: m.sizeBytes + 250,
      quotaBytes: 100 * 1024 * 1024,
      files: 1,
      maxFiles: 5_000,
      breakdown: { originals: m.sizeBytes, previews: 250, thumbnails: 0 },
      boards: { count: 1, max: 500 },
      gc: {
        mode: 'report',
        graceDays: 30,
        inFlightDays: 7,
        lastRun: null,
        unreferenced: { versions: 0, bytes: 0 },
        eligible: { versions: 0, bytes: 0 },
      },
    })
    const member = await w.bob.req('GET', `/api/workspaces/${DEV_STUDIO}/storage`)
    expect(member.statusCode).toBe(200)
    expect(member.json()).not.toHaveProperty('gc')
    expect((member.json() as WorkspaceStorage).usedBytes).toBe(m.sizeBytes + 250)
    // bob's own workspace is his; Dev Studio's report is not.
    expect((await w.bob.req('GET', `/api/workspaces/${DEV_STUDIO}/storage/gc-report`)).statusCode).toBe(403)
    expect((await w.bob.req('POST', `/api/workspaces/${DEV_STUDIO}/storage/scan`)).statusCode).toBe(403)

    const guest = await joinAsGuest(w.api, (await guestLink(w.alice, w.board, { role: 'editor' })).url, 'Gil')
    expect((await guest.req('GET', `/api/workspaces/${DEV_STUDIO}/storage`)).statusCode).toBe(403)
    const outsider = await w.api.login('olga')
    await w.api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
      outsider.userId,
      DEV_STUDIO,
    ])
    expect((await outsider.req('GET', `/api/workspaces/${DEV_STUDIO}/storage`)).statusCode).toBe(404)
    expect((await w.api.anon('GET', `/api/workspaces/${DEV_STUDIO}/storage`)).statusCode).toBe(401)
  })

  it('POST /scan runs a report-only pass now (even with DRAFTROOM_ASSET_GC=delete), and GET /gc-report lists what it marked', async () => {
    const w = await world({ DRAFTROOM_ASSET_GC: 'delete' })
    const m = await upload(w.api, w.alice, w.board, 'unused.png')
    w.api.clock.advance(8 * DAY)
    const scan = await w.alice.req('POST', `/api/workspaces/${DEV_STUDIO}/storage/scan`)
    expect(scan.statusCode, scan.body).toBe(200)
    const report = scan.json() as AssetGcReport
    expect(report.summary).toMatchObject({
      mode: 'delete',
      unreferenced: { versions: 1, bytes: m.sizeBytes },
      eligible: { versions: 0, bytes: 0 },
      lastRun: { mode: 'report', complete: true, boardsScanned: 1, marked: 1 },
    })
    expect(report.versions).toEqual([
      {
        assetId: m.assetId,
        versionId: m.versionId,
        name: 'unused.png',
        kind: 'image',
        bytes: m.sizeBytes,
        boardId: w.board,
        boardTitle: 'Mood board',
        uploadedAt: expect.any(String),
        unreferencedSince: expect.any(String),
        eligibleAt: expect.any(String),
      },
    ])
    const [entry] = report.versions
    const since = Date.parse(entry?.unreferencedSince ?? '')
    expect(Math.abs(since - w.api.clock.now().getTime())).toBeLessThan(5_000)
    expect(since - Date.parse(entry?.uploadedAt ?? '')).toBeGreaterThanOrEqual(8 * DAY)
    expect(Date.parse(entry?.eligibleAt ?? '')).toBe(since + 30 * DAY)
    expect(report.truncated).toBe(false)

    // Long past the grace period, a manual check still deletes nothing.
    w.api.clock.advance(40 * DAY)
    const alice = await w.api.login('alice') // sessions last 30 days
    const again = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/storage/scan`)
    expect((again.json() as AssetGcReport).summary.eligible).toEqual({ versions: 1, bytes: m.sizeBytes })
    expect(await exists(w, originalKey(m.assetId, m.versionId))).toBe(true)
    const listed = await alice.req('GET', `/api/workspaces/${DEV_STUDIO}/storage/gc-report`)
    expect((listed.json() as AssetGcReport).versions.map((v) => v.versionId)).toEqual([m.versionId])
    // Two checks a minute per workspace.
    expect((await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/storage/scan`)).statusCode).toBe(200)
    const third = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/storage/scan`)
    expect(third.statusCode).toBe(429)
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0)
  })
})

describe('the timer', () => {
  it('runs a pass over every workspace with files after its first delay, then stops cleanly; mode off runs none', async () => {
    const w = await world()
    const m = await upload(w.api, w.alice, w.board, 'timed.png')
    w.api.clock.advance(8 * DAY)
    const off = createAssetGc(w.deps, { mode: 'off', intervalMs: 5, firstRunDelayMs: 1 })
    off.start()
    await new Promise((r) => setTimeout(r, 30))
    expect((await w.marks())[m.versionId]).toBeNull()
    await off.stop()

    const gc = createAssetGc(w.deps, { mode: 'report', intervalMs: 60_000, firstRunDelayMs: 1 })
    gc.start()
    await vi.waitFor(async () => expect((await w.marks())[m.versionId]).not.toBeNull(), { timeout: 5_000 })
    await gc.stop()
    expect(await exists(w, originalKey(m.assetId, m.versionId))).toBe(true)
  })
})

// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.8 "Asset GC", §5.9 step 2): during a rollback R0 meets
// what the Excalidraw build left behind and cannot read. A checkpoint made on the new canvas (a v2 body)
// and a converted board's new-canvas elements can show files R0 cannot see, so the pass is incomplete:
// nothing new is marked or deleted, and no scan row is recorded for the checkpoint (a scan is never
// repeated, so a row saying "no references" would outlive the roll-forward). Verifier: gc-v2.
describe('what the new canvas left behind (bridge release R0)', () => {
  /** A checkpoint row as the Excalidraw build writes one, its v2 body showing `m`. */
  async function v2Checkpoint(w: World, m: AssetVersionMeta, bodyVersion: 1 | 2 = 2) {
    const id = newDbId('snp')
    const key = snapshotStorageKey(w.board, id)
    const body = JSON.stringify({
      format: 'lobby-checkpoint',
      version: 2,
      boardId: w.board,
      clock: 3,
      schema: 1,
      elements: [{ id: 'img1', type: 'image', fileId: m.versionId }],
      doc: {},
    })
    await w.api.blobs.put(key, Buffer.from(body), {
      contentType: 'application/json',
      contentLength: body.length,
    })
    await w.api.db.query(
      `INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, reason, created_by, created_at,
         document_clock, record_count, size_bytes, storage_key, body_version)
       VALUES ($1, $2, $3, 'Moved to the new canvas', 'auto', 'engine_migration', NULL, now(), 3, 1, $4, $5, $6)`,
      [id, DEV_STUDIO, w.board, body.length, key, bodyVersion],
    )
    return id
  }
  const scans = (w: World) => w.api.db.query('SELECT snapshot_id, ref_count FROM asset_gc_snapshot_scans')

  it('a v2 checkpoint (row body_version 2) makes the pass incomplete and is never recorded', async () => {
    const w = await world()
    const m = await upload(w.api, w.alice, w.board, 'excalidraw-era.png')
    w.sync.setBoard(w.board, baseRecords()) // the canvas no longer shows it
    await v2Checkpoint(w, m, 2)
    w.api.clock.advance(8 * DAY)
    const r = await w.collect()
    expect(r).toMatchObject({ complete: false, checkpointsFailed: 1, marked: 0 })
    expect((await scans(w)).rows).toEqual([])
    expect((await w.marks())[m.versionId]).toBeNull()
    w.api.clock.advance(31 * DAY)
    const d = await w.collect('delete')
    expect(d).toMatchObject({ complete: false, deleted: { versions: 0 } })
    expect(await exists(w, originalKey(m.assetId, m.versionId))).toBe(true)
    expect((await scans(w)).rows).toEqual([])
  })

  // The Excalidraw branch's collector reads v2 bodies (gc-refs.ts versionsInCheckpoint): a v2 body behind a
  // row that says v1 shows its image and is recorded. R0 (the tldraw build, on main) counts it as unread.
  it('a v2 checkpoint behind a row that says v1 is read on this branch: its image is kept, the scan recorded', async () => {
    const w = await world()
    const m = await upload(w.api, w.alice, w.board, 'excalidraw-era.png')
    w.sync.setBoard(w.board, baseRecords()) // the canvas no longer shows it
    const id = await v2Checkpoint(w, m, 1)
    w.api.clock.advance(8 * DAY)
    expect(await w.collect()).toMatchObject({ complete: true, checkpointsFailed: 0, marked: 0 })
    expect((await scans(w)).rows).toEqual([{ snapshot_id: id, ref_count: 1 }])
    expect((await w.marks())[m.versionId]).toBeNull()
    w.api.clock.advance(31 * DAY)
    await w.collect('delete')
    expect(await exists(w, originalKey(m.assetId, m.versionId))).toBe(true)
  })

  it('a body that is not JSON still counts as restoring nothing (as before)', async () => {
    const w = await world()
    const m = await upload(w.api, w.alice, w.board, 'plain.png')
    const id = newDbId('snp')
    const key = snapshotStorageKey(w.board, id)
    await w.api.blobs.put(key, Buffer.from('not json'), { contentType: 'application/json', contentLength: 8 })
    await w.api.db.query(
      `INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, created_by, created_at,
         document_clock, record_count, size_bytes, storage_key)
       VALUES ($1, $2, $3, 'Broken', 'manual', $4, now(), 3, 1, 8, $5)`,
      [id, DEV_STUDIO, w.board, w.alice.userId, key],
    )
    w.api.clock.advance(8 * DAY)
    expect(await w.collect()).toMatchObject({ complete: true, checkpointsFailed: 0, marked: 1 })
    expect((await scans(w)).rows).toEqual([{ snapshot_id: id, ref_count: 0 }])
    expect((await w.marks())[m.versionId]).not.toBeNull()
  })

  it("a converted board's refs count, but the pass is incomplete (its new-canvas elements are unread)", async () => {
    const w = await world()
    const shown = await upload(w.api, w.alice, w.board, 'tldraw-side.png')
    const excalidraw = await upload(w.api, w.alice, w.board, 'excalidraw-era.png')
    w.api.clock.advance(8 * DAY)
    await w.collect() // both unreferenced: marked
    w.sync.setBoard(w.board, card(shown))
    w.sync.converted.add(w.board)
    const r = await w.collect()
    expect(r).toMatchObject({ complete: false, boardsFailed: 1, cleared: 1, marked: 0 })
    const marks = await w.marks()
    expect(marks[shown.versionId]).toBeNull() // the tldraw side's refs still clear marks
    w.api.clock.advance(31 * DAY)
    expect(await w.collect('delete')).toMatchObject({ complete: false, deleted: { versions: 0 } })
    expect(await exists(w, originalKey(excalidraw.assetId, excalidraw.versionId))).toBe(true)
  })
})
