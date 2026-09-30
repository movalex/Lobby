// CR 2F-2 (engine-switch.ts `prepareBoard`, `serverWrite`; room/server-write.ts) through the real server
// process: a server-authored write into an OPEN room goes through the room's queue and drain like a push
// (its own clock in the batch, stamped as the server's, re-snaps included), reaches every session in the
// batch's `changes` frame, is acked to nobody, and answers its caller only after the COMMIT. A refused or
// contract-breaking write, or a failed COMMIT, changes nothing. `prepareBoard` opens a board after its
// conversion. Driven through the room's test-only routes (room/test-routes.ts, DRAFTROOM_TEST_HOOKS=1):
// the api's own routes (room-internal/**, wave 2F) exist only on engine/excalidraw.

import { join } from 'node:path'
import { indexKeyBetween } from '@draftroom/canvas-schema/engine'
import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import { boardDbPath } from '../../src/rooms.ts'
import { callInternal } from '../harness/tickets.ts'
import { fixtureRecords, readDb, seedBoardRecords } from '../migrate/board-files.ts'
import type { RawClient } from './support/client.ts'
import { arrow, bindArrow, type El, label, note, rect, withLabel } from './support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

interface Answer {
  status: number
  body: { clock?: number; wrote?: number; ready?: boolean; error?: { code: string } }
}
const call = async (st: ElementStack, path: string, body: unknown): Promise<Answer> => {
  const res = await callInternal(st.server.url, 'POST', path, { body })
  return { status: res.status, body: (await res.json()) as Answer['body'] }
}
const serverWrite = (st: ElementStack, boardId: string, body: unknown) =>
  call(st, `/internal/test/boards/${boardId}/server-write`, body)
const prepare = (st: ElementStack, boardId: string) =>
  call(st, `/internal/test/boards/${boardId}/prepare`, {})

/** A fresh index key above every element `c` holds. */
const topKey = (c: RawClient, n = 1): string[] => {
  let lo =
    [...c.confirmed.values()]
      .map((e) => e.index as string)
      .sort()
      .at(-1) ?? null
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    lo = indexKeyBetween(lo, null)
    out.push(lo)
  }
  return out
}
const opIds = (c: RawClient, clock: number) =>
  (c.of('changes').find((f) => f.clock === clock)?.ops ?? [])
    .map((o) => (o.k === 'c' ? o.el.id : o.id))
    .sort()
/** Every frame queued before this answer has arrived (the socket is ordered). */
const barrier = async (c: RawClient, n: number) => {
  c.send({ type: 'ping', n })
  await c.until(() => c.of('pong').some((p) => p.n === n), `pong ${n}`)
}
const dbRow = (path: string, id: string) =>
  readDb(
    path,
    (db) =>
      db
        .prepare(
          'SELECT clock, deleted, deleted_clock, deleted_at, gclock, version FROM lb_elements WHERE id = ?',
        )
        .get(id) as
        | {
            clock: number
            deleted: number
            deleted_clock: number | null
            deleted_at: number | null
            gclock: string
          }
        | undefined,
  )

describe('server writes into an open room (CR 2F-2)', () => {
  it('reach every session in one changes frame at their own clock, acked to nobody; a reconnect catches them up', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const a = await st.client({ boardId, user: 'alice' })
    const b = await st.client({ boardId, user: 'bob' })
    await a.create([rect('r1')])
    await b.untilClock(a.clock)
    const held = new Map(b.confirmed)
    const since = b.clock
    const epoch = b.epoch
    const acks = [a.of('ack').length, b.of('ack').length]
    const [ni, li] = topKey(a, 2)
    const n1 = withLabel(
      note('n1', { index: ni }),
      label('n1.t', 'n1', { index: li, text: 'from the server' }),
    )
    const n1t = label('n1.t', 'n1', { index: li, text: 'from the server', originalText: 'from the server' })
    const w = await serverWrite(st, boardId, {
      put: [n1, n1t],
      doc: { startView: { x: 1, y: 2, w: 100, h: 50 } },
    })
    expect(w).toEqual({ status: 200, body: { clock: since + 1, wrote: 2 } })
    // the answer came after the COMMIT: the snapshot already has it
    const snap = await st.snapshot(boardId)
    expect(snap.clock).toBe(since + 1)
    for (const c of [a, b]) {
      await c.untilClock(since + 1)
      expect(opIds(c, since + 1)).toEqual(['n1', 'n1.t'])
      expect(c.of('changes').find((f) => f.clock === since + 1)?.doc).toEqual({
        set: { startView: { x: 1, y: 2, w: 100, h: 50 } },
      })
      expect(await c.hash()).toBe(await hashElements(snap.elements))
      expect(c.schemaErrors).toEqual([])
    }
    await barrier(a, 1)
    await barrier(b, 2)
    expect([a.of('ack').length, b.of('ack').length]).toEqual(acks)
    expect(snap.elements.find((e) => e.id === 'n1')).toMatchObject({ version: 2, index: ni })
    // a reconnect with since and epoch gets the server write in its catch-up
    b.close()
    const b2 = await st.client({ boardId, user: 'bob', tab: 'bob-2', since, epoch, confirmed: held })
    expect(b2.welcome?.reset).toBe(false)
    expect(b2.welcome?.catchUp?.map((o) => (o.k === 'c' ? o.el.id : o.id)).sort()).toEqual(['n1', 'n1.t'])
    expect(b2.welcome?.doc).toMatchObject({ startView: { x: 1, y: 2, w: 100, h: 50 } })
    expect(await b2.hash()).toBe(await hashElements(snap.elements))
  })

  it("take the batch's next clock between pushes, keep the stored group clocks, stamp the changed ones, and name the server as the writer (a text push on an older base is STALE)", async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const dataDir = st.server.dataDir
    const path = boardDbPath(join(dataDir, 'rooms'), boardId)
    const a = await st.client({ boardId, user: 'alice' })
    const lbl = label('r1.t', 'r1')
    await a.create([withLabel(rect('r1'), lbl), lbl])
    const styled = await a.push([
      { k: 'p', id: 'r1.t', pv: a.confirmed.get('r1.t')?.version, g: { style: { strokeColor: '#e03131' } } },
    ])
    const base = a.clock
    expect(JSON.parse(dbRow(path, 'r1.t')?.gclock ?? '{}')).toMatchObject({ style: styled.clock })
    // a push and a server write in flight together: separate clocks, both applied
    const push = a.pushNow([{ k: 'c', el: rect('r2', { x: 400 }) }])
    const stored = JSON.parse(JSON.stringify(a.confirmed.get('r1.t'))) as El
    const w = await serverWrite(st, boardId, {
      put: [{ ...stored, text: 'Lobby wrote this', originalText: 'Lobby wrote this' }],
    })
    const ack = await push.ack
    expect(w.status).toBe(200)
    expect(new Set([ack.clock, w.body.clock]).size).toBe(2)
    await a.untilClock(Math.max(ack.clock, w.body.clock as number))
    expect(a.confirmed.get('r1.t')?.originalText).toBe('Lobby wrote this')
    const g = JSON.parse(dbRow(path, 'r1.t')?.gclock ?? '{}')
    expect(g.style).toBe(styled.clock) // kept (the write's own gclock was empty)
    expect(g.text).toBe(w.body.clock) // stamped
    // Alice's text write on a base from before the server's: someone else wrote the text since
    const stale = await a.push(
      [
        {
          k: 'p',
          id: 'r1.t',
          pv: a.confirmed.get('r1.t')?.version,
          g: { text: { originalText: 'mine' }, layout: { text: 'mine' } },
        },
      ],
      { base },
    )
    expect(stale.r[0]).toMatchObject({ ok: false, code: 'STALE' })
    const fresh = await a.push([
      {
        k: 'p',
        id: 'r1.t',
        pv: a.confirmed.get('r1.t')?.version,
        g: { text: { originalText: 'mine' }, layout: { text: 'mine' } },
      },
    ])
    expect(fresh.r[0]).toMatchObject({ ok: true })
    expect(await a.hash()).toBe(await hashElements((await st.snapshot(boardId)).elements))
    expect(a.schemaErrors).toEqual([])
  })

  it('a refused write (its throw), a contract break or a failed COMMIT changes nothing; the room keeps serving', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const a = await st.client({ boardId, user: 'alice' })
    const b = await st.client({ boardId, user: 'bob' })
    const lbl = label('r2.t', 'r2')
    await a.create([rect('r1'), withLabel(rect('r2'), lbl), lbl])
    await b.untilClock(a.clock)
    const before = await st.snapshot(boardId)
    const frames = b.of('changes').length
    const [k1] = topKey(a)
    const r3 = rect('r3', { index: k1 })
    const r1 = a.confirmed.get('r1') as El
    const r2 = a.confirmed.get('r2') as El
    const cases: [unknown, number, string][] = [
      [{ put: [r3], fail: 'throw' }, 409, 'test-refused'],
      [{ put: [r3], fail: 'bad-clock' }, 500, 'INTERNAL'],
      [{ put: [r3, rect('r4', { index: indexKeyBetween(k1, null) })], fail: 'unreported' }, 500, 'INTERNAL'],
      [{ put: [r3], fail: 'async' }, 500, 'INTERNAL'],
      [{ put: [r1], fail: 'stale-version' }, 500, 'INTERNAL'],
      [{ put: [rect('r5', { index: r1.index })] }, 500, 'INTERNAL'], // the index of a live element
      [{ put: [label('r2.t2', 'r2', { index: indexKeyBetween(null, r2.index) })] }, 500, 'INTERNAL'], // below its container
      [{ put: [{ ...r3, strokeWidth: 'wide' }] }, 500, 'INTERNAL'], // not a valid element
      [{ put: [rect('r6', { index: null })] }, 500, 'INTERNAL'], // no index
      [{ put: [r3], doc: { startView: { x: 'left' } } }, 500, 'INTERNAL'], // a doc value its key refuses
      [{ put: [r3], doc: { nonsense: 1 } }, 500, 'INTERNAL'], // an unknown doc key
    ]
    for (const [body, status, code] of cases) {
      const w = await serverWrite(st, boardId, body)
      expect([w.status, w.body.error?.code], JSON.stringify(body).slice(0, 120)).toEqual([status, code])
      expect(await st.snapshot(boardId)).toEqual(before)
    }
    await barrier(b, 1)
    expect(b.of('changes').length).toBe(frames)
    // a failed COMMIT: 503, nothing stored, every session resyncs (as for a push)
    await st.failCommit(boardId, 1)
    const failed = await serverWrite(st, boardId, { put: [r3] })
    expect([failed.status, failed.body.error?.code]).toEqual([503, 'unavailable'])
    expect(await a.untilClosed()).toMatchObject({ code: 4000, reason: 'RECONNECT' })
    expect(await st.snapshot(boardId)).toEqual(before)
    // the caches are intact: the same write lands, and a push after it
    const c = await st.client({ boardId, user: 'carol' })
    const ok = await serverWrite(st, boardId, { put: [r3] })
    expect(ok.status).toBe(200)
    await c.untilClock(ok.body.clock as number)
    const pushed = await c.create([rect('r7')])
    expect(pushed.r[0]).toMatchObject({ ok: true })
    expect(await c.hash()).toBe(await hashElements((await st.snapshot(boardId)).elements))
  })

  it('a deletion gets its tombstone and a "Recently deleted" row by Lobby; a revival clears the tombstone', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const path = boardDbPath(join(st.server.dataDir, 'rooms'), boardId)
    const a = await st.client({ boardId, user: 'alice' })
    await a.create([rect('r1'), rect('r2')])
    const del = await serverWrite(st, boardId, { delete: ['r1'] })
    expect(del.status).toBe(200)
    await a.untilClock(del.body.clock as number)
    expect(a.confirmed.get('r1')?.isDeleted).toBe(true)
    expect(dbRow(path, 'r1')).toMatchObject({ deleted: 1, deleted_clock: del.body.clock })
    expect(dbRow(path, 'r1')?.deleted_at).toBeGreaterThan(0)
    const rows = readDb(path, (db) => db.prepare('SELECT * FROM lb_deleted').all()) as Record<
      string,
      unknown
    >[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      batch: del.body.clock,
      element_id: 'r1',
      deleted_by: 'lobby-server',
      deleted_by_name: 'Lobby',
      origin: 'live',
    })
    const rev = await serverWrite(st, boardId, { revive: ['r1'] })
    await a.untilClock(rev.body.clock as number)
    expect(a.confirmed.get('r1')?.isDeleted).toBe(false)
    expect(dbRow(path, 'r1')).toMatchObject({ deleted: 0, deleted_clock: null, deleted_at: null })
    // a push that deletes is still captured with the session's name
    const pushDel = await a.push([
      { k: 'p', id: 'r2', pv: a.confirmed.get('r2')?.version, g: { life: { isDeleted: true } } },
    ])
    expect(pushDel.r[0]).toMatchObject({ ok: true })
    const rows2 = readDb(path, (db) =>
      db.prepare('SELECT element_id, deleted_by, epoch FROM lb_deleted ORDER BY seq').all(),
    )
    expect(rows2).toEqual([
      { element_id: 'r1', deleted_by: 'lobby-server', epoch: rows[0]?.epoch },
      { element_id: 'r2', deleted_by: 'alice', epoch: rows[0]?.epoch },
    ])
    expect(await a.hash()).toBe(await hashElements((await st.snapshot(boardId)).elements))
  })

  it('rule 7: a server write that moves a bound target re-snaps its arrow in the same clock and frame', async () => {
    const st = await h.stack()
    const boardId = newBoardId()
    const a = await st.client({ boardId, user: 'alice' })
    const X = rect('X', { x: 0, y: 0, width: 200, height: 100 })
    const Y = rect('Y', { x: 400, y: 0, width: 200, height: 100 })
    const A = arrow('A', {
      x: 205,
      y: 50,
      width: 190,
      height: 0,
      points: [
        [0, 0],
        [190, 0],
      ],
    })
    bindArrow(A, X, Y)
    await a.create([X, Y, A])
    const arrowBefore = JSON.parse(JSON.stringify(a.confirmed.get('A'))) as El
    const moved = { ...(a.confirmed.get('Y') as El), y: 300 }
    const w = await serverWrite(st, boardId, { put: [moved] })
    expect(w.status).toBe(200)
    await a.untilClock(w.body.clock as number)
    expect(opIds(a, w.body.clock as number)).toEqual(['A', 'Y'])
    const arrowAfter = a.confirmed.get('A') as El
    expect(arrowAfter.version).toBeGreaterThan(arrowBefore.version)
    expect(arrowAfter.points).not.toEqual(arrowBefore.points)
    const snap = await st.snapshot(boardId)
    expect(await a.hash()).toBe(await hashElements(snap.elements))
    expect(a.schemaErrors).toEqual([])
  })
})

describe('prepareBoard, and server writes to a board with no open room', () => {
  it('a tldraw board is converted first (one job) and then written; a board without a file is false / 404', async () => {
    const dataDir = h.dataDir()
    const boardId = newBoardId()
    seedBoardRecords(join(dataDir, 'rooms'), boardId, fixtureRecords('kitchen-sink'))
    const st = await h.stack({ dataDir })
    expect(await prepare(st, boardId)).toEqual({ status: 200, body: { ready: true } })
    const snap = await st.snapshot(boardId)
    const top =
      snap.elements
        .map((e) => e.index as string)
        .sort()
        .at(-1) ?? null
    const w = await serverWrite(st, boardId, {
      put: [rect('lobby-r', { index: indexKeyBetween(top, null) })],
    })
    expect(w.status).toBe(200)
    const a = await st.client({ boardId, user: 'alice' })
    expect(a.received[0]?.type).toBe('welcome') // no PREPARING: already converted
    expect(a.confirmed.get('lobby-r')).toBeTruthy()
    const status = (await (await callInternal(st.server.url, 'GET', '/internal/migrate/status')).json()) as {
      boards: { boardId: string; kind: string; state: string }[]
    }
    expect(status.boards.filter((x) => x.boardId === boardId).map((x) => [x.kind, x.state])).toEqual([
      ['convert', 'done'],
    ])
    const none = newBoardId()
    expect(await prepare(st, none)).toEqual({ status: 200, body: { ready: false } })
    const nw = await serverWrite(st, none, { put: [rect('x', { index: 'a0' })] })
    expect([nw.status, nw.body.error?.code]).toEqual([404, 'board-not-found'])
  })

  it('a board whose room is closed is opened, written and served; a board that cannot be prepared is 503', async () => {
    const dataDir = h.dataDir()
    const boardId = newBoardId()
    const st = await h.stack({ dataDir })
    const a = await st.client({ boardId, user: 'alice' })
    await a.create([rect('r1')])
    const [k] = topKey(a)
    a.close()
    await st.server.restart() // no room is open now
    const w = await serverWrite(st, boardId, { put: [rect('r2', { index: k })] })
    expect(w.status).toBe(200)
    const b = await st.client({ boardId, user: 'bob' })
    expect([...b.confirmed.keys()].sort()).toEqual(['r1', 'r2'])
    expect(await b.hash()).toBe(await hashElements((await st.snapshot(boardId)).elements))
    // a tldraw board whose conversion fails (a 4 MB test heap cap): 503 unavailable, nothing written
    const bad = newBoardId()
    const dataDir2 = h.dataDir()
    seedBoardRecords(join(dataDir2, 'rooms'), bad, fixtureRecords('kitchen-sink'))
    const st2 = await h.stack({ dataDir: dataDir2, env: { DRAFTROOM_TEST_MIGRATE_CAP_MB: '4' } })
    const p = await prepare(st2, bad)
    expect([p.status, p.body.error?.code]).toEqual([503, 'unavailable'])
    const bw = await serverWrite(st2, bad, { put: [rect('x', { index: 'a0' })] })
    expect([bw.status, bw.body.error?.code]).toEqual([503, 'unavailable'])
  })
})
