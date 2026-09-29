// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.6, §7.5 step 4): the backups POST
// /internal/backups/run-all writes (the cut-over's final set, whose offsite key the runbook stores and the
// conversion records as converted_from.backupKey) are kept 90 days, locally and offsite, whatever the
// count-based retention says. Before, they were ordinary entries: 12 newer backups of the board on the
// same UTC day (about 3 hours of edits at the 15-minute interval) removed the object from the store
// (verifier, final-backup-retention).
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createFsBlobStore } from '@draftroom/blob-store'
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupBoard, readManifest } from '../../src/backup/backup.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { applyRetention, type OffsiteManifest, offsiteKeys } from '../../src/backup/offsite-manifest.ts'
import { createRunAll, RUN_ALL_HOLD_DAYS, type RunAllReport } from '../../src/backup/run-all.ts'
import { backupSigningKey } from '../../src/backup/signing.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { readJsonObject, type TempData, tempData } from '../backup/offsite-fixtures.ts'
import { useProtocolHarness } from '../harness/fixture.ts'
import { geoShape, noteShape } from '../harness/records.ts'
import { callInternal, TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { markConverted, seedTldrawBoard } from './support.ts'

const DAY = 86_400_000
const BOARD = 'b-hold-0001'
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 5, h, m))

describe('the retention rules keep a held backup outside their count', () => {
  it('applyRetention: held entries stay, and the newest 12 ordinary ones are still kept', () => {
    const held = { file: 'held', createdAt: at(0).toISOString(), holdUntil: at(0 + 1).toISOString() }
    const later = Array.from({ length: 20 }, (_, i) => ({
      file: `b${String(i).padStart(2, '0')}`,
      createdAt: at(1, i).toISOString(),
    }))
    const now = at(0, 59)
    const { keep, drop } = applyRetention([held, ...later], now)
    expect(keep.map((e) => e.file)).toEqual(['held', ...later.slice(-12).map((e) => e.file)])
    expect(drop).toHaveLength(8)
    // once the hold has passed, it is an ordinary (old) backup again
    const after = applyRetention([held, ...later], at(2))
    expect(after.keep.map((e) => e.file)).not.toContain('held')
  })

  it('a malformed holdUntil holds nothing', () => {
    const e = { file: 'x', createdAt: at(0).toISOString(), holdUntil: 'soon' }
    const newer = Array.from({ length: 12 }, (_, i) => ({ file: `n${i}`, createdAt: at(1, i).toISOString() }))
    expect(applyRetention([e, ...newer], at(2)).drop.map((d) => d.file)).toEqual(['x'])
  })
})

describe('local and offsite copies of a held backup survive the newer ones', () => {
  let data: TempData
  beforeEach(() => {
    data = tempData('dr-r0-hold-')
    mkdirSync(data.rooms, { recursive: true })
  })
  afterEach(() => data.cleanup())

  it('keeps the run-all backup 90 days while 20 newer backups of the same day come and go', async () => {
    const live = seedTldrawBoard(data.rooms, BOARD, [noteShape('n1', 'x') as unknown as TLRecord])
    let now = at(8)
    const offsite = new OffsiteBackups({
      store: createFsBlobStore(data.blobs),
      localRoot: data.backups,
      signingKey: backupSigningKey(TEST_INTERNAL_SECRET),
      now: () => now,
    })
    const db = new DatabaseSync(live)
    try {
      // run-all through its own code path, against a registry stand-in that backs up this file
      const runAll = createRunAll({
        registry: {
          boardFileIds: () => [BOARD],
          backupFresh: (boardId, opts) =>
            backupBoard({ db, boardId, root: data.backups, now: () => now, holdUntil: opts?.holdUntil }),
        },
        backups: {
          status: () => offsite.status(),
          copyOffsite: async (boardId, file) => {
            await offsite.syncBoard(boardId)
            return offsite.storedKey(boardId, file)
          },
        },
        now: () => now,
      })
      const report: RunAllReport = await runAll.run()
      const row = report.boards[0]
      expect(row?.ok).toBe(true)
      expect(row?.holdUntil).toBe(new Date(at(8).getTime() + RUN_ALL_HOLD_DAYS * DAY).toISOString())
      const finalFile = row?.file as string
      const finalKey = row?.offsiteKey as string
      expect(finalKey).toBe(offsiteKeys.file('backups/sync', BOARD, finalFile))

      // 20 more backups the same day: local keeps 12 ordinary ones, the store its newest 12
      for (let i = 1; i <= 20; i++) {
        now = at(9, i)
        await backupBoard({ db, boardId: BOARD, root: data.backups, now: () => now })
        await offsite.syncBoard(BOARD)
      }
      const local = readManifest(data.backups, BOARD)?.backups ?? []
      expect(local.map((b) => b.file)).toContain(finalFile)
      expect(local.filter((b) => b.file !== finalFile)).toHaveLength(12)
      expect(existsSync(join(data.backups, BOARD, finalFile))).toBe(true)
      const store = createFsBlobStore(data.blobs)
      expect(await store.head(finalKey)).not.toBeNull()
      const manifest = await readJsonObject<OffsiteManifest>(
        store,
        offsiteKeys.manifest('backups/sync', BOARD),
      )
      const listed = manifest?.backups.find((b) => b.file === finalFile)
      expect(listed?.holdUntil).toBe(row?.holdUntil)
      expect(listed?.signature).toBeDefined()
      expect(manifest?.backups).toHaveLength(13)

      // 91 days later the hold is over: the next backup's retention removes it like any old backup
      now = new Date(at(8).getTime() + 91 * DAY)
      await backupBoard({ db, boardId: BOARD, root: data.backups, now: () => now })
      await offsite.syncBoard(BOARD)
      expect(readManifest(data.backups, BOARD)?.backups.map((b) => b.file)).not.toContain(finalFile)
      expect(existsSync(join(data.backups, BOARD, finalFile))).toBe(false)
      expect(await store.head(finalKey)).toBeNull()
    } finally {
      db.close()
      await offsite.stop()
    }
  })
})

describe('in the real sync process', () => {
  const h = useProtocolHarness()

  it('the run-all backup of a converted board is still in the store after 13 newer backups', async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    const conv = seedTldrawBoard(rooms, BOARD, [geoShape('g0') as unknown as TLRecord])
    markConverted(conv)
    const server = await h.server({
      dataDir,
      env: { DRAFTROOM_BACKUP_STORE: 'fs', DRAFTROOM_BACKUP_INTERVAL_MS: '1000' },
    })
    const res = await callInternal(server.url, 'POST', '/internal/backups/run-all')
    const report = (await res.json()) as RunAllReport
    const key = report.boards[0]?.offsiteKey as string
    expect(key).toMatch(new RegExp(`^backups/sync/${BOARD}/`))
    const store = createFsBlobStore(join(dataDir, 'blobs'))

    const a = await h.connected(server, { boardId: BOARD, user: 'usr_alice' })
    const status = async () =>
      (
        (await (await callInternal(server.url, 'GET', '/internal/backups/status')).json()) as {
          boards: Array<{ boardId: string; offsiteCount: number | null }>
        }
      ).boards.find((b) => b.boardId === BOARD)?.offsiteCount ?? 0
    const newest = () => readManifest(join(dataDir, 'backups'), BOARD)?.backups.at(-1)?.file
    let prev = newest()
    for (let i = 1; i <= 13; i++) {
      a.put(geoShape(`e${i}`))
      await a.waitForAcked()
      // the periodic pass (every second) backs the edit up
      const deadline = Date.now() + 10_000
      while (newest() === prev)
        if (Date.now() > deadline) throw new Error(`no backup of edit ${i}`)
        else await new Promise((r) => setTimeout(r, 100))
      prev = newest()
    }
    a.dispose()
    const deadline = Date.now() + 10_000
    while ((await status()) < 13 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    expect(await store.head(key)).not.toBeNull()
    expect(readManifest(join(dataDir, 'backups'), BOARD)?.backups.map((b) => b.file)).toContain(
      report.boards[0]?.file,
    )
    await server.kill('SIGINT')
    expect(existsSync(boardDbPath(rooms, BOARD))).toBe(true)
  })
})
