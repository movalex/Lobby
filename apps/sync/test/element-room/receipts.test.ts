// CONTRACTS_REV 11 (wave C, C2: W5-ENG-2, push receipts) through the REAL sync server process: a push with a
// receipt id (`rid`) that writes leaves a row in the board file's lb_receipts with its COMMIT; a `receipts`
// query is answered after the room's next COMMIT with the named receipts of the asking user and the clock
// from which its receipts are complete. The table is made on every open (a file from before rev 11 gets it),
// survives a SIGKILL, is per user, keeps a ring per user, and never touches a rev-10 client's frames.
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CONTRACTS_REV, MAX_RECEIPT_IDS, type Receipts } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { lbFileFacts } from '../../src/r0/lb-files.ts'
import { RECEIPTS } from '../../src/room/schema.ts'
import { boardDbPath } from '../../src/rooms.ts'
import type { RawClient } from './support/client.ts'
import { note, rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const T = 120_000

let reqs = 0
/** Sends a `receipts` query and waits for its answer. */
async function ask(c: RawClient, ids: string[]): Promise<Receipts> {
  const req = ++reqs
  c.send({ type: 'receipts', req, ids })
  await c.until(() => c.of('receipts').some((r) => r.req === req), `receipts ${req}`)
  return c.of('receipts').find((r) => r.req === req) as Receipts
}

let seqs = 1000
/** Sends a push with a receipt id (raw: the support client sends none); resolves with its ack. */
function pushRid(c: RawClient, rid: string, ops: unknown[], base = c.clock) {
  const seq = ++seqs
  c.send({ type: 'push', seq, base, ops, rid })
  return c.ackOf(seq)
}
const move = (c: RawClient, id: string, x: number) => ({
  k: 'p',
  id,
  pv: c.confirmed.get(id)?.version ?? 1,
  g: { pos: { x, y: 0 } },
})

describe('push receipts (CONTRACTS_REV 11, W5-ENG-2)', () => {
  it(
    'the room says rev 11 or later; a push with a receipt id that wrote is answered landed at its clock; others are not',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: CONTRACTS_REV })
      expect(CONTRACTS_REV).toBeGreaterThanOrEqual(11) // 12 since wave L (the laser): receipts are unchanged
      await a.create([rect('r1')])
      const landed = await pushRid(a, 'pg1.1', [move(a, 'r1', 40)])
      expect(landed.r[0]).toMatchObject({ ok: true })
      // a push that wrote nothing (its only op refused GONE) leaves no receipt: the client sends it again
      const refused = await pushRid(a, 'pg1.2', [{ k: 'p', id: 'nope', pv: 1, g: { pos: { x: 1, y: 1 } } }])
      expect(refused.r[0]).toMatchObject({ ok: false, code: 'GONE' })
      const r = await ask(a, ['pg1.1', 'pg1.2', 'pg1.3'])
      expect(r).toEqual({ type: 'receipts', req: r.req, landed: { 'pg1.1': landed.clock }, from: 0 })
      expect(a.schemaErrors).toEqual([])
    },
    T,
  )

  it(
    "a query is ordered after the session's earlier pushes and answered after their COMMIT",
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create([rect('r1')])
      // push and query back to back, no wait for the ack: the answer already names the push
      const ack = pushRid(a, 'pg2.1', [move(a, 'r1', 70)])
      const r = await ask(a, ['pg2.1'])
      expect(r.landed).toEqual({ 'pg2.1': (await ack).clock })
      const types = a.received.map((m) => m.type)
      expect(types.lastIndexOf('ack')).toBeLessThan(types.lastIndexOf('receipts'))
    },
    T,
  )

  it(
    'the push lost with its ack: after a reconnect the new socket learns it landed (the case counting could not decide)',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice', tab: 'tab-a' })
      const watcher = await st.client({ boardId: b, user: 'bob' })
      await a.create([rect('r1')])
      await watcher.untilClock(a.clock)
      const clock = a.clock
      // the push goes out and the socket dies before its ack is read
      a.send({ type: 'push', seq: 77, base: clock, ops: [move(a, 'r1', 90)], rid: 'pg3.77' })
      await watcher.until(() => watcher.confirmed.get('r1')?.x === 90, 'the push committed')
      a.terminate()
      // two other writes meanwhile: the counting rule could not tell this push's fate
      await watcher.push([move(watcher, 'r1', 91)])
      await watcher.push([move(watcher, 'r1', 92)])
      const again = await st.client({ boardId: b, user: 'alice', tab: 'tab-a', since: clock, epoch: a.epoch })
      const r = await ask(again, ['pg3.77', 'pg3.78'])
      expect(Object.keys(r.landed)).toEqual(['pg3.77'])
      expect(r.landed['pg3.77']).toBeGreaterThan(clock)
      expect(r.from).toBe(0)
    },
    T,
  )

  it(
    "receipts are per user: another user's query never sees them",
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      const m = await st.client({ boardId: b, user: 'mallory' })
      await a.create([rect('r1')])
      await pushRid(a, 'pg4.1', [move(a, 'r1', 5)])
      expect((await ask(m, ['pg4.1'])).landed).toEqual({})
      expect(Object.keys((await ask(a, ['pg4.1'])).landed)).toEqual(['pg4.1'])
    },
    T,
  )

  it(
    'they survive a SIGKILL and a restart (the table is in the board file, written with the COMMIT)',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create([rect('r1')])
      const ack = await pushRid(a, 'pg5.1', [move(a, 'r1', 12)])
      await st.server.kill('SIGKILL')
      await st.server.restart()
      const again = await st.client({ boardId: b, user: 'alice' })
      expect((await ask(again, ['pg5.1'])).landed).toEqual({ 'pg5.1': ack.clock })
    },
    T,
  )

  it(
    'a board file from before rev 11 gets the table with its first receipt, in that write; an open alone changes nothing',
    async () => {
      const dataDir = h.dataDir()
      const st = await h.stack({ dataDir })
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create([rect('r1')]) // no receipt id: no table (the file as a rev-10 room leaves it)
      a.close()
      await st.server.kill('SIGKILL')
      const path = boardDbPath(join(dataDir, 'rooms'), b)
      const facts = () => {
        const db = new DatabaseSync(path, { readOnly: true })
        try {
          const f = lbFileFacts(db)
          const tables = (
            db
              .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'lb_receipts%' ORDER BY name")
              .all() as {
              name: string
            }[]
          ).map((r) => r.name)
          return { clock: f.documentClock, sha: f.recordsSha256, tables }
        } finally {
          db.close()
        }
      }
      const before = facts()
      expect(before.tables).toEqual([])
      // a room opens the file and answers a query: nothing landed, and the file is as it was (the backup
      // drill's live check: the same clock must mean the same records)
      await st.server.restart()
      const reader = await st.client({ boardId: b, user: 'alice' })
      expect(await ask(reader, ['pg6.0'])).toMatchObject({ landed: {}, from: 0 })
      reader.close()
      await st.server.kill('SIGKILL')
      expect(facts()).toEqual(before)
      // the first push with a receipt id makes the table in its own batch: the clock moves with it
      await st.server.restart()
      const again = await st.client({ boardId: b, user: 'alice' })
      const ack = await pushRid(again, 'pg6.1', [move(again, 'r1', 3)])
      expect(Object.keys((await ask(again, ['pg6.1'])).landed)).toEqual(['pg6.1'])
      again.close()
      await st.server.kill('SIGKILL')
      const after = facts()
      expect(after.tables).toEqual(['lb_receipts', 'lb_receipts_clock'])
      expect(after.clock).toBe(ack.clock)
      expect(after.sha).not.toBe(before.sha)
      // it survives the restart, and another open changes nothing
      await st.server.restart()
      const third = await st.client({ boardId: b, user: 'alice' })
      expect((await ask(third, ['pg6.1'])).landed).toEqual({ 'pg6.1': ack.clock })
      third.close()
      await st.server.kill('SIGKILL')
      expect(facts()).toEqual(after)
    },
    T,
  )

  it(
    "a user's ring keeps its newest receipts; the answer says from which clock they are complete",
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      await a.create([note('n1')])
      const clocks: number[] = []
      for (let i = 0; i < RECEIPTS.trimAt; i++) {
        const ack = await pushRid(a, `pg7.${i}`, [move(a, 'n1', i + 1)])
        await a.untilClock(ack.clock)
        clocks.push(ack.clock)
      }
      // the push that reached trimAt trimmed the ring back to perUser
      const oldest = Array.from({ length: MAX_RECEIPT_IDS }, (_, i) => `pg7.${i}`)
      const early = await ask(a, oldest)
      const kept = RECEIPTS.trimAt - RECEIPTS.perUser
      const dropped = clocks[kept - 1] as number
      expect(early.from).toBe(dropped + 1)
      for (let i = 0; i < kept; i++) expect(early.landed[`pg7.${i}`], `pg7.${i}`).toBeUndefined()
      for (let i = kept; i < MAX_RECEIPT_IDS; i++) expect(early.landed[`pg7.${i}`]).toBe(clocks[i])
      const late = await ask(a, [`pg7.${RECEIPTS.trimAt - 1}`])
      expect(late.landed).toEqual({ [`pg7.${RECEIPTS.trimAt - 1}`]: clocks.at(-1) })
    },
    T,
  )

  it(
    'a rev-10 client (no receipt id, no query) is served exactly as before: no receipts frame ever',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const old = await st.client({ boardId: b, user: 'stale' })
      await old.create([rect('r1')])
      await old.push([move(old, 'r1', 8)])
      expect(old.of('receipts')).toEqual([])
      expect(old.schemaErrors).toEqual([])
    },
    T,
  )

  it(
    'more than 10 queries in 10 s close the session 4099 RATE_LIMITED',
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      const a = await st.client({ boardId: b, user: 'alice' })
      for (let i = 0; i < 11; i++) a.send({ type: 'receipts', req: 500 + i, ids: ['x.1'] })
      expect(await a.untilClosed()).toEqual({ code: 4099, reason: 'RATE_LIMITED' })
    },
    T,
  )
})
