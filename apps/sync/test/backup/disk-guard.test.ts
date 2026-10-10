// Wave M (M7-4, CAP-DISK): the disk can never fill from backups. With a fake statfs (disk.ts DiskProbe):
//  - at 15 % free (under 20 %), every board's local copies are pruned to the newest one the offsite store holds,
//    no new local copy is made, and one `[disk] low` line is logged (one `[disk] ok` once it is back);
//  - a run-all held copy is dropped locally only once the offsite store holds it (its entry is kept as
//    offsite-only, so run-all's recent-set check still sees the set);
//  - DRAFTROOM_BACKUP_KEEP's keep=4 is honoured;
//  - the restore tools still find every offsite copy afterwards (the drill over the store).
// The rooms' DISK notice at 10 % and lobby_disk_free_ratio are in test/element-room/disk-notice.test.ts.
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createFsBlobStore } from '@draftroom/blob-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readManifest } from '../../src/backup/backup.ts'
import { runRestoreDrill, storeBackupSource } from '../../src/backup/drill.ts'
import { ElementBackups } from '../../src/backup/element-backups.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { createRunAll, RecentHeldSetError } from '../../src/backup/run-all.ts'
import { backupSigningKey } from '../../src/backup/signing.ts'
import { DISK_LOW_RATIO, type DiskProbe } from '../../src/disk.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { excalidrawEdit, makeBornAfterFile } from '../migrate/board-files.ts'
import { type TempData, tempData } from './offsite-fixtures.ts'

const BOARDS = ['b-disk-one01', 'b-disk-two02'] as const
const DAY = 86_400_000
const t0 = Date.UTC(2026, 9, 10, 9, 0)
const key = backupSigningKey(TEST_INTERNAL_SECRET)

let data: TempData
beforeEach(() => {
  data = tempData('dr-disk-')
})
afterEach(() => data.cleanup())

/** A fake statfs: the free share is whatever the test says. */
function fakeDisk(free: number) {
  const d = { free }
  const probe: DiskProbe = { freeRatio: () => d.free }
  return { d, probe }
}

function setup(opts: { keep?: number; free?: number } = {}) {
  mkdirSync(data.rooms, { recursive: true })
  for (const b of BOARDS) makeBornAfterFile(boardDbPath(data.rooms, b))
  let now = t0
  const clock = () => new Date(now)
  const disk = fakeDisk(opts.free ?? 0.9)
  const store = createFsBlobStore(data.blobs)
  const offsite = new OffsiteBackups({ store, localRoot: data.backups, signingKey: key, now: clock })
  const logs: string[] = []
  const eb = new ElementBackups({
    roomsDir: data.rooms,
    backupsDir: data.backups,
    now: clock,
    disk: disk.probe,
    offsite: { stored: (b, f) => offsite.storedKey(b, f) !== null },
    ...(opts.keep ? { keep: opts.keep } : {}),
    log: (...a) => logs.push(a.map(String).join(' ')),
  })
  const touchAll = () => {
    for (const b of BOARDS)
      excalidrawEdit(boardDbPath(data.rooms, b), 'r1', ['pos'], (e) => {
        e.x = Number(e.x ?? 0) + 1
      })
  }
  /** one minute later: every board edited, a pass, and the offsite copy of what it wrote */
  const round = async () => {
    now += 60_000
    touchAll()
    const r = await eb.runPass()
    for (const b of BOARDS) await offsite.syncBoard(b)
    return r
  }
  const localFiles = (b: string) =>
    existsSync(join(data.backups, b))
      ? readdirSync(join(data.backups, b)).filter((f) => f.endsWith('.sqlite'))
      : []
  return {
    eb,
    offsite,
    store,
    disk: disk.d,
    logs,
    round,
    touchAll,
    localFiles,
    setNow: (t: number) => {
      now = t
    },
    now: () => now,
  }
}

describe('M7-4: the backup-pass guard at low disk', () => {
  it(`at 15 % free (under ${DISK_LOW_RATIO * 100} %): local copies are pruned to one per board, the newest offsite one, and no new local copy is made`, async () => {
    const t = setup()
    for (let i = 0; i < 5; i++) expect((await t.round()).backedUp).toEqual([...BOARDS].sort())
    for (const b of BOARDS) {
      expect(t.localFiles(b)).toHaveLength(5)
      expect(readManifest(data.backups, b)?.backups).toHaveLength(5)
    }
    const newest = Object.fromEntries(
      BOARDS.map((b) => [b, readManifest(data.backups, b)?.backups.at(-1)?.file]),
    )

    t.disk.free = 0.15
    const low = await t.round() // the boards moved again: a pass at 20 %+ would back them up
    expect(low.lowDisk).toBe(true)
    expect(low.backedUp).toEqual([])
    expect(low.pruned).toHaveLength(8)
    for (const b of BOARDS) {
      expect(t.localFiles(b)).toEqual([newest[b]])
      expect(readManifest(data.backups, b)?.backups.map((e) => e.file)).toEqual([newest[b]])
    }
    expect(t.logs.filter((l) => l.startsWith('[disk] low'))).toEqual([
      '[disk] low: 15% free (under 20%): local backups pruned to the newest offsite copy per board, no new local copy until it is above again',
    ])
    // still low: nothing new, nothing more pruned, no second line
    const again = await t.round()
    expect(again).toMatchObject({ backedUp: [], pruned: [], lowDisk: true })
    expect(t.logs.filter((l) => l.startsWith('[disk]'))).toHaveLength(1)
    for (const b of BOARDS) expect(t.localFiles(b)).toHaveLength(1)

    // the restore tools still find every offsite copy (the drill over the store)
    const drill = await runRestoreDrill({
      dataDir: data.root,
      source: storeBackupSource(t.store, { signingKey: key }),
    })
    expect(drill.ok).toBe(true)
    expect(drill.boards.map((b) => b.boardId).sort()).toEqual([...BOARDS].sort())

    // back above 20 %: backups resume, and say so once
    t.disk.free = 0.5
    expect((await t.round()).backedUp).toEqual([...BOARDS].sort())
    expect(t.logs.filter((l) => l.startsWith('[disk] ok'))).toEqual([
      '[disk] ok: 50% free; local backups resume',
    ])
  })

  it('a copy newer than the newest offsite one (still waiting to go up) stays; with nothing offsite, the newest local one', async () => {
    const t = setup()
    await t.round()
    await t.round()
    // a third backup that has not gone offsite yet (the store is behind)
    t.setNow(t.now() + 60_000)
    t.touchAll()
    await t.eb.runPass()
    const [board] = BOARDS
    const files = readManifest(data.backups, board)?.backups.map((e) => e.file) ?? []
    expect(files).toHaveLength(3)
    t.disk.free = 0.1
    await t.eb.runPass()
    // the newest offsite (the second) and the one waiting (the third) stay
    expect(readManifest(data.backups, board)?.backups.map((e) => e.file)).toEqual(files.slice(1))

    // offsite off: the newest local copy only
    const off = new ElementBackups({
      roomsDir: data.rooms,
      backupsDir: data.backups,
      disk: { freeRatio: () => 0.1 },
    })
    await off.runPass()
    expect(readManifest(data.backups, board)?.backups.map((e) => e.file)).toEqual(files.slice(2))
  })
})

describe('M7-4: run-all held copies', () => {
  it('a held local copy is dropped only once the offsite store holds it; run-all still sees the recent set', async () => {
    const t = setup()
    const runAll = createRunAll({
      registry: t.eb,
      // offsite OFF for the run itself: its held copies are local only at first
      backups: { status: () => ({ store: 'off' }) as never, copyOffsite: async () => null },
      backupsDir: () => data.backups,
      now: () => new Date(t.now()),
    })
    const report = await runAll.run()
    expect(report.ok).toBe(true)
    const held = Object.fromEntries(report.boards.map((b) => [b.boardId, b.file as string]))
    // the pass: nothing offsite yet, so every held copy stays
    t.setNow(t.now() + 60_000)
    expect((await t.eb.runPass()).pruned).toEqual([])
    for (const b of BOARDS) expect(t.localFiles(b)).toContain(held[b])
    // a second run within 30 minutes is refused: the recent held set exists
    expect(() => runAll.request()).toThrow(RecentHeldSetError)

    // the offsite store holds the first board's held copy now (not yet the second's)
    const [first, second] = BOARDS
    await t.offsite.syncBoard(first)
    const r = await t.eb.runPass()
    expect(r.pruned).toEqual([held[first]])
    expect(t.localFiles(first)).not.toContain(held[first])
    expect(t.localFiles(second)).toContain(held[second])
    const m = readManifest(data.backups, first)
    expect(m?.backups.map((e) => e.file)).not.toContain(held[first])
    expect(m?.offsiteOnly?.map((e) => e.file)).toEqual([held[first]])
    expect(m?.offsiteOnly?.[0]?.holdUntil).toBe(new Date(t0 + 90 * DAY).toISOString())
    // still refused: the dropped copy is listed as offsite-only, the set is still recent and whole
    expect(() => runAll.request()).toThrow(RecentHeldSetError)

    // a held copy offsite does not hold is kept even at low disk (the hold's only copy)
    t.disk.free = 0.05
    await t.eb.runPass()
    expect(t.localFiles(second)).toContain(held[second])
    // the drill over the store finds the first board's held copy
    const drill = await runRestoreDrill({
      dataDir: data.root,
      source: storeBackupSource(t.store, { signingKey: key }),
      boardIds: [first],
    })
    expect(drill.ok).toBe(true)
  })

  it('an offsite-only entry is forgotten once its hold ends', async () => {
    const t = setup()
    const [first] = BOARDS
    const made = await t.eb.backupFresh(first, { holdUntil: new Date(t0 + DAY) })
    await t.offsite.syncBoard(first)
    await t.eb.runPass()
    expect(readManifest(data.backups, first)?.offsiteOnly?.map((e) => e.file)).toEqual([made.file])
    t.setNow(t0 + 2 * DAY)
    t.touchAll()
    await t.eb.runPass()
    expect(readManifest(data.backups, first)?.offsiteOnly).toBeUndefined()
  })
})

describe('M7-4: DRAFTROOM_BACKUP_KEEP', () => {
  it('keep=4 is honoured (the newest 4 ordinary copies per board)', async () => {
    const t = setup({ keep: 4 })
    for (let i = 0; i < 6; i++) await t.round()
    for (const b of BOARDS) {
      expect(readManifest(data.backups, b)?.backups).toHaveLength(4)
      expect(t.localFiles(b)).toHaveLength(4)
    }
  })

  it('without it, 12 (as before)', async () => {
    const t = setup()
    for (let i = 0; i < 13; i++) await t.round()
    expect(readManifest(data.backups, BOARDS[0])?.backups).toHaveLength(12)
  })
})
