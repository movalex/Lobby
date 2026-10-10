// Wave M (M7-6): the offsite status says since when a board's local backup has been waiting to go up
// (OffsiteBoardStatus.pendingSince: the oldest waiting copy's time), so the deep health check can report
// `backup` once that is over an hour. Null when nothing waits; set while uploads fail; cleared once they go up.
import { mkdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ElementBackups } from '../../src/backup/element-backups.ts'
import { OffsiteBackups } from '../../src/backup/offsite.ts'
import { backupSigningKey } from '../../src/backup/signing.ts'
import { deepHealthReasons } from '../../src/health.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { excalidrawEdit, makeBornAfterFile } from '../migrate/board-files.ts'
import { flakyStore, type TempData, tempData } from './offsite-fixtures.ts'

const B = 'b-pending0001'
const t0 = Date.UTC(2026, 9, 10, 9, 0)

let data: TempData
beforeEach(() => {
  data = tempData('dr-pending-')
  mkdirSync(data.rooms, { recursive: true })
  makeBornAfterFile(boardDbPath(data.rooms, B))
})
afterEach(() => data.cleanup())

describe('M7-6: OffsiteBoardStatus.pendingSince', () => {
  it('is the oldest waiting copy while uploads fail, an hour of it is `backup`, and it clears once they go up', async () => {
    let now = t0
    const clock = () => new Date(now)
    const store = flakyStore(data.blobs)
    const offsite = new OffsiteBackups({
      store,
      localRoot: data.backups,
      signingKey: backupSigningKey(TEST_INTERNAL_SECRET),
      now: clock,
    })
    const eb = new ElementBackups({
      roomsDir: data.rooms,
      backupsDir: data.backups,
      now: clock,
      disk: { freeRatio: () => 0.9 },
    })
    const first = await eb.backupFresh(B)
    await offsite.syncBoard(B)
    const st = () => offsite.status().boards.find((b) => b.boardId === B)
    expect(st()).toMatchObject({ pending: 0, pendingSince: null, failures: 0 })

    // the store fails from now on: two more backups wait
    store.failPut = () => true
    now += 60_000
    excalidrawEdit(boardDbPath(data.rooms, B), 'r1', ['pos'], (e) => {
      e.x = 1
    })
    const second = await eb.backupFresh(B)
    await offsite.syncBoard(B)
    expect(second.file).not.toBe(first.file)
    expect(st()).toMatchObject({ pending: 1, pendingSince: second.createdAt, failures: 1 })
    now += 61 * 60_000
    excalidrawEdit(boardDbPath(data.rooms, B), 'r1', ['pos'], (e) => {
      e.x = 2
    })
    await eb.backupFresh(B)
    await offsite.syncBoard(B)
    // still the oldest waiting copy's time, now over an hour ago
    expect(st()).toMatchObject({ pending: 2, pendingSince: second.createdAt })
    const facts = (failures: number) => ({
      diskFreeRatio: 0.9,
      backups: {
        store: 'fs' as const,
        boards: [{ ...(st() as NonNullable<ReturnType<typeof st>>), failures }],
      },
      loopP99Ms: 5,
      accessRound: null,
      now,
    })
    expect(deepHealthReasons(facts(0))).toEqual(['backup']) // the hour alone
    // the store is back: everything goes up, nothing waits
    store.failPut = () => false
    await offsite.syncBoard(B)
    expect(st()).toMatchObject({ pending: 0, pendingSince: null, failures: 0 })
    expect(deepHealthReasons(facts(0))).toEqual([])
  })
})
