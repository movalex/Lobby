// "Recently deleted" retention on `lb_deleted` (docs/EXCALIDRAW-MIGRATION.md §2.6: the same limits and
// trim rules as today's store, apps/sync/src/deleted/store.ts): the most recent rows of any room session,
// plus everything the current room session deleted, up to the hard cap; whole batches, oldest first; a
// converted board's tldraw batch numbers (which overlap the room's clocks) never make a newer row go.
// In-process on the room's BoardStore (room/store.ts).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DELETED_LIMITS } from '../../src/deleted/store.ts'
import { BoardStore, LB_DELETED_LIMITS } from '../../src/room/store.ts'
import { rect } from './support/elements.ts'

let dirs: string[] = []
let stores: BoardStore[] = []
afterEach(() => {
  for (const s of stores) s.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
  stores = []
})

function board(): BoardStore {
  const d = mkdtempSync(join(tmpdir(), 'dr-lbdel-'))
  dirs.push(d)
  const s = new BoardStore(join(d, 'board.sqlite'))
  stores.push(s)
  return s
}

/** Appends one batch of `n` rows (ids `<tag>-<i>`) by `session`. */
function batch(s: BoardStore, b: number, n: number, session: string, tag = `b${b}`): void {
  for (let i = 0; i < n; i++)
    s.insertDeleted({
      batch: b,
      el: rect(`${tag}-${i}`, { isDeleted: true }) as never,
      deletedBy: 'usr',
      deletedByName: 'U',
      deletedAt: 1,
      session,
    })
}
const ids = (s: BoardStore) =>
  (s.db.prepare('SELECT element_id FROM lb_deleted ORDER BY seq').all() as { element_id: string }[]).map(
    (r) => r.element_id,
  )

describe('lb_deleted retention', () => {
  it("has today's limits", () => {
    expect(LB_DELETED_LIMITS).toEqual({
      retainRecent: DELETED_LIMITS.retainRecent,
      hardCap: DELETED_LIMITS.hardCap,
      trimEvery: DELETED_LIMITS.trimEvery,
    })
  })

  it("keeps the newest rows of any session and all of the current session's, up to the cap", () => {
    const s = board()
    for (let b = 1; b <= 8; b++) batch(s, b, 1, 'old') // an earlier room session
    for (let b = 9; b <= 12; b++) batch(s, b, 1, 'cur')
    // the 5 newest: b12..b9 (cur) and b8 (old); older rows of other sessions go
    expect(s.trimDeleted({ retainRecent: 5, hardCap: 100 }, 'cur')).toBe(7)
    expect(ids(s)).toEqual(['b8-0', 'b9-0', 'b10-0', 'b11-0', 'b12-0'])
    // the current session's rows stay beyond retainRecent, until the hard cap
    for (let b = 13; b <= 20; b++) batch(s, b, 1, 'cur')
    expect(s.trimDeleted({ retainRecent: 2, hardCap: 100 }, 'cur')).toBe(1) // only b8 (old)
    expect(s.deletedCount()).toBe(12)
    expect(s.trimDeleted({ retainRecent: 2, hardCap: 10 }, 'cur')).toBe(2)
    expect(ids(s)[0]).toBe('b11-0')
    // another session opening: the earlier one's rows are "old" now
    expect(s.trimDeleted({ retainRecent: 3, hardCap: 10 }, 'next')).toBe(7)
    expect(ids(s)).toEqual(['b18-0', 'b19-0', 'b20-0'])
  })

  it('drops whole batches only: a batch straddling a limit is kept', () => {
    const s = board()
    batch(s, 1, 3, 'old')
    batch(s, 2, 4, 'old') // the 3rd newest row falls inside it
    batch(s, 3, 2, 'old')
    expect(s.trimDeleted({ retainRecent: 3, hardCap: 5 }, 'cur')).toBe(3)
    expect(ids(s)).toEqual(['b2-0', 'b2-1', 'b2-2', 'b2-3', 'b3-0', 'b3-1'])
  })

  it("a converted board's batch numbers overlapping the room's never drop a newer row", () => {
    const s = board()
    // converted rows (origin 'converted' in the real file) keep tldraw's batches 1..4
    for (let b = 1; b <= 4; b++) batch(s, b, 2, 'tldraw-session', `tl${b}`)
    // the room's own rows after the conversion: batch = the push's clock, 2..4 again
    for (let b = 2; b <= 4; b++) batch(s, b, 1, 'cur', `lb${b}`)
    batch(s, 5, 1, 'cur', 'lb5')
    // by batch number, "older than batch 3" would take lb2 (a newer row); by insertion order it never does
    expect(s.trimDeleted({ retainRecent: 3, hardCap: 5 }, 'cur')).toBe(6)
    expect(ids(s)).toEqual(['tl4-0', 'tl4-1', 'lb2-0', 'lb3-0', 'lb4-0', 'lb5-0'])
  })
})
