// Wave D, D2: the receipt gap (the wave C review's minor on C2-1), through the REAL sync server process.
// A push's receipt is written in a SAVEPOINT of its own, so a failed receipt write rolls back only the
// receipt and the push still COMMITs. Before, the next `receipts` query found that receipt absent with
// `from` at or below the push's base + 1, and the client took the push for one that never landed: it sent
// it again over whatever was written after it. Now the room keeps the gap (per user, the highest clock whose
// receipt is missing) as a marker row in the file and in memory, and every answer's `from` is past it, so
// the client counts for that push instead (as before rev 11).
//
// The failure is real SQLite: a trigger on lb_receipts, added through a second connection to the board file
// (WAL), aborts the receipt INSERT.
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Receipts } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import type { CoreEvent } from '../../../web/src/canvas/sync/core/engine.ts'
import type { SceneElement } from '../../../web/src/canvas/sync/types.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { callInternal } from '../harness/tickets.ts'
import { headless, sleep, startProxy } from '../verifier-v1/support.ts'
import type { RawClient } from './support/client.ts'
import { rect } from './support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const T = 120_000

let reqs = 0
async function ask(c: RawClient, ids: string[]): Promise<Receipts> {
  const req = ++reqs
  c.send({ type: 'receipts', req, ids })
  await c.until(() => c.of('receipts').some((r) => r.req === req), `receipts ${req}`)
  return c.of('receipts').find((r) => r.req === req) as Receipts
}

let seqs = 2000
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

/** Runs `sql` on the board file through a second connection (the server keeps its own open). */
function onFile(dataDir: string, boardId: string, sql: string): void {
  const db = new DatabaseSync(boardDbPath(join(dataDir, 'rooms'), boardId))
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(sql)
  } finally {
    db.close()
  }
}
/** Receipt rows fail; marker rows (`rid` = '') still go in. */
const FAIL_RECEIPTS = `CREATE TRIGGER d2_fail_receipts BEFORE INSERT ON lb_receipts WHEN NEW.rid <> ''
  BEGIN SELECT RAISE(ABORT, 'd2: injected receipt failure'); END`
/** Every write to lb_receipts fails, marker rows too. */
const FAIL_ALL = `CREATE TRIGGER d2_fail_all_i BEFORE INSERT ON lb_receipts
  BEGIN SELECT RAISE(ABORT, 'd2: injected receipt failure'); END;
  CREATE TRIGGER d2_fail_all_u BEFORE UPDATE ON lb_receipts
  BEGIN SELECT RAISE(ABORT, 'd2: injected receipt failure'); END`

async function metric(st: ElementStack, line: string): Promise<number> {
  const text = await (await callInternal(st.server.url, 'GET', '/internal/metrics')).text()
  const hit = text.split('\n').find((l) => l.startsWith(`${line} `))
  return hit ? Number(hit.slice(line.length + 1)) : 0
}

/** alice's board with r1, and one receipt recorded (the table exists) */
async function board(st: ElementStack, b: string) {
  const a = await st.client({ boardId: b, user: 'alice', tab: 'tab-a' })
  await a.create([rect('r1')])
  const first = await pushRid(a, 'gp.1', [move(a, 'r1', 10)])
  expect(first.r[0]).toMatchObject({ ok: true })
  await a.untilClock(first.clock)
  expect((await ask(a, ['gp.1'])).landed).toEqual({ 'gp.1': first.clock })
  return a
}

describe('the receipt gap (wave D2): a push whose receipt was not recorded is never answered "never landed"', () => {
  it(
    'the receipt write fails, the push commits: from is past its clock (the client counts), for this user only, after a restart too',
    async () => {
      const dataDir = h.dataDir()
      const st = await h.stack({ dataDir })
      const b = newBoardId()
      const a = await board(st, b)
      const bob = await st.client({ boardId: b, user: 'bob' })
      onFile(dataDir, b, FAIL_RECEIPTS)
      const base = a.clock
      const ack = await pushRid(a, 'gp.2', [move(a, 'r1', 50)])
      expect(ack.r[0], 'the push itself landed').toMatchObject({ ok: true })
      await bob.until(() => bob.confirmed.get('r1')?.x === 50, 'committed')
      const r = await ask(a, ['gp.1', 'gp.2'])
      expect(r.landed).toEqual({ 'gp.1': expect.any(Number) })
      expect(r.from).toBe(ack.clock + 1)
      // the client's rule (engine.ts onReceipts): an absence is conclusive only when base + 1 >= from
      expect(base + 1 >= r.from, 'the absence is not conclusive').toBe(false)
      expect(await metric(st, 'lobby_receipts_unrecorded_total{gap="file"}')).toBe(1)
      // another user's answer is not moved by alice's gap
      expect((await ask(bob, ['x.1'])).from).toBe(0)
      // the marker is in the file: after a SIGKILL and a restart the answer is the same
      await st.server.kill('SIGKILL')
      await st.server.restart()
      const again = await st.client({ boardId: b, user: 'alice', tab: 'tab-a' })
      const after = await ask(again, ['gp.2'])
      expect(after.landed).toEqual({})
      expect(after.from).toBe(ack.clock + 1)
      // receipts recorded after the gap are answered as before; the gap stays below them
      onFile(dataDir, b, 'DROP TRIGGER d2_fail_receipts')
      const later = await pushRid(again, 'gp.3', [move(again, 'r1', 60)])
      const r3 = await ask(again, ['gp.2', 'gp.3'])
      expect(r3.landed).toEqual({ 'gp.3': later.clock })
      expect(r3.from).toBe(ack.clock + 1)
    },
    T,
  )

  it(
    'the marker cannot be written either: the open room keeps the gap in memory',
    async () => {
      const dataDir = h.dataDir()
      const st = await h.stack({ dataDir })
      const b = newBoardId()
      const a = await board(st, b)
      onFile(dataDir, b, FAIL_ALL)
      const base = a.clock
      const ack = await pushRid(a, 'gp.2', [move(a, 'r1', 70)])
      expect(ack.r[0]).toMatchObject({ ok: true })
      const r = await ask(a, ['gp.2'])
      expect(r.landed).toEqual({})
      expect(r.from).toBe(ack.clock + 1)
      expect(base + 1 >= r.from).toBe(false)
      expect(await metric(st, 'lobby_receipts_unrecorded_total{gap="memory"}')).toBe(1)
      // a later push of the same user moves the gap with it while the writes keep failing
      const ack2 = await pushRid(a, 'gp.3', [move(a, 'r1', 71)])
      expect((await ask(a, ['gp.3'])).from).toBe(ack2.clock + 1)
    },
    T,
  )

  it(
    'a batch whose COMMIT fails leaves no gap (nothing of it landed: its pushes are answered UNAVAILABLE)',
    async () => {
      const dataDir = h.dataDir()
      const st = await h.stack({ dataDir })
      const b = newBoardId()
      const a = await board(st, b)
      // marker rows may go in: the one this batch writes goes back with its failed COMMIT
      onFile(dataDir, b, FAIL_RECEIPTS)
      await st.failCommit(b, 1)
      const failed = await pushRid(a, 'gp.2', [move(a, 'r1', 80)])
      expect(failed.r[0]).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
      expect(await a.untilClosed()).toMatchObject({ code: 4000, reason: 'RECONNECT' })
      const again = await st.client({ boardId: b, user: 'alice', tab: 'tab-a' })
      const r = await ask(again, ['gp.2'])
      expect(r).toMatchObject({ landed: {}, from: 0 })
      expect(await metric(st, 'lobby_receipts_unrecorded_total{gap="memory"}')).toBe(0)
      expect(await metric(st, 'lobby_receipts_unrecorded_total{gap="file"}')).toBe(0)
    },
    T,
  )

  it(
    'the real engine core: a push that landed with its ack lost and its receipt unrecorded is not sent again over two later writes',
    async () => {
      const dataDir = h.dataDir()
      const st = await h.stack({ dataDir })
      const b = newBoardId()
      const px = await startProxy(st.server.wsUrl)
      const A = headless(px.url, b, 'alice')
      await A.connect()
      const B = await st.client({ boardId: b, user: 'bob' })
      A.edit((m) => m.set('X', rect('X', { x: 0, y: 0 }) as unknown as SceneElement))
      A.core.flush()
      await A.saved()
      await B.until(() => B.confirmed.has('X'), 'B sees X')
      // the create carried a receipt id, so the table exists; from here on receipt rows fail
      onFile(dataDir, b, FAIL_RECEIPTS)
      const events: CoreEvent[] = []
      A.core.on((e) => events.push(e))
      px.dropDown = true // the move's ack (and its changes) are lost
      A.change('X', { x: 111 })
      A.core.flush()
      await B.until(() => (B.confirmed.get('X') as { x?: number } | undefined)?.x === 111, 'A landed')
      for (const x of [222, 333])
        await B.push([{ k: 'p', id: 'X', pv: B.confirmed.get('X')?.version, g: { pos: { x, y: 0 } } }])
      const pushesBefore = A.core.pushLog().length
      px.cutAll()
      px.dropDown = false
      await sleep(50)
      await A.saved(20_000)
      await sleep(200)
      const stored = ((await st.snapshot(b)).elements.find((e) => e.id === 'X') as { x: number }).x
      // before the gap: the absent receipt read as "never landed", and A sent 111 again over B's 333
      expect(stored, 'the later write stands').toBe(333)
      expect(A.core.pushLog().length - pushesBefore, 'nothing sent again').toBe(0)
      // decided by counting (two other writes): the server's copy stands and A is told, as before rev 11
      const superseded = events.flatMap((e) => (e.kind === 'superseded' ? [e.id] : []))
      expect(superseded).toEqual(['X'])
      await A.close()
      B.close()
      await px.close()
    },
    T,
  )
})
