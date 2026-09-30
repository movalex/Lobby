// "Recently deleted" on the Excalidraw engine (wave 2F, room-internal/deleted.ts), against the REAL sync
// server process: the list read from `lb_deleted`, and the restore as one server write (the room closed:
// until CR 2F-2 lands, a write to an open board answers 503 and is retried after the room's eviction).

import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { ListDeletedResponse, RestoreDeletedResponse } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { arrow, bindArrow, type El, rect, text } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { call, sampleBoard, seed, whenEvicted } from './support.ts'

const h = useElementHarness()

type Entry = {
  shapeId: string
  type: string
  label: string
  deletedAt: string
  deletedBy: { id: string; name: string }
  childCount: number
}
type List = { entries: Entry[]; total: number; limit: number }
type Restored = {
  restored: string[]
  skipped: { id: string; reason: string }[]
  bindings: number
  reparented: number
}

const del = (id: string, v: number) => ({ k: 'p', id, pv: v, g: { life: { isDeleted: true } } })

/** The sample board plus an arrow from R to T; returns the stack, the board and an editor client. */
async function boardWithDeletions() {
  const st = await h.stack({ env: { IDLE_EVICT_MS: '200' } })
  const b = newBoardId()
  const els = sampleBoard()
  const R = els.find((e) => e.id === 'R') as El
  const T = els.find((e) => e.id === 'T') as El
  const A = bindArrow(
    arrow('A', {
      x: 1100,
      y: 100,
      points: [
        [0, 0],
        [0, 600],
      ],
    }),
    R,
    T,
  )
  expect((await seed(st, b, [...els, A])).status).toBe(201)
  const c = await st.client({ boardId: b, user: 'ann' })
  const v = (id: string) => c.confirmed.get(id)?.version ?? 1
  // one push: the frame with what it holds; then the box (its label goes with it; A's start unbinds)
  await c.push(['F', 'N1', 'N1.t', 'N2', 'N2.t'].map((id) => del(id, v(id))))
  await c.push([del('R', v('R'))])
  return { st, b, c }
}

describe('recently deleted (Excalidraw engine)', () => {
  it('lists each deleted object once, newest first, with what it held', async () => {
    const { st, b } = await boardWithDeletions()
    const list = await call<List>(st, 'GET', `/internal/boards/${b}/deleted`)
    expect(list.status).toBe(200)
    ListDeletedResponse.parse(list.body) // what the api proxies (history sync-deleted.ts)
    expect(list.body.total).toBe(2)
    expect(list.body.limit).toBe(2000)
    expect(list.body.entries.map((e) => [e.shapeId, e.type, e.label, e.childCount])).toEqual([
      ['shape:R', 'geo', 'box', 0],
      ['shape:F', 'frame', 'Ideas', 2],
    ])
    expect(list.body.entries[0]?.deletedBy).toEqual({ id: 'ann', name: 'ann-name' })
    expect(Number.isNaN(Date.parse(list.body.entries[0]?.deletedAt ?? ''))).toBe(false)
    const one = await call<List>(st, 'GET', `/internal/boards/${b}/deleted?limit=1`)
    expect(one.body).toMatchObject({ total: 2, limit: 1 })
    expect(one.body.entries).toHaveLength(1)
  })

  it('restores an entry with its content once the room is closed; the board stays consistent', async () => {
    const { st, b, c } = await boardWithDeletions()
    // while the room is open, the write waits for CR 2F-2 (a 503 the api retries)
    const open = await call(st, 'POST', `/internal/boards/${b}/deleted/restore`, { ids: ['shape:F'] })
    expect(open.status).toBe(503)
    c.close()
    const res = await whenEvicted(() =>
      call<Restored>(st, 'POST', `/internal/boards/${b}/deleted/restore`, {
        ids: ['shape:F', 'shape:R', 'shape:T', 'shape:nope'],
      }),
    )
    expect(res.status).toBe(200)
    RestoreDeletedResponse.parse(res.body)
    expect([...res.body.restored].sort()).toEqual(['shape:F', 'shape:N1', 'shape:N2', 'shape:R'])
    expect(res.body.skipped).toEqual([
      { id: 'shape:T', reason: 'exists' },
      { id: 'shape:nope', reason: 'not-found' },
    ])
    expect(res.body).toMatchObject({ bindings: 0, reparented: 0 })
    const snap = await st.snapshot(b)
    const live = snap.elements.filter((e) => !e.isDeleted)
    expect(live.map((e) => e.id).sort()).toEqual(['A', 'F', 'N1', 'N1.t', 'N2', 'N2.t', 'R', 'R.t', 'T'])
    expect(checkInvariants(snap.elements)).toEqual([])
    const byId = new Map(live.map((e) => [e.id, e as El]))
    expect(byId.get('N1')?.frameId).toBe('F')
    // R's arrow was unbound when R went: it is not listed on R again
    expect(byId.get('R')?.boundElements).toEqual([{ id: 'R.t', type: 'text' }])
    // the list no longer offers what is back
    const list = await call<List>(st, 'GET', `/internal/boards/${b}/deleted`)
    expect(list.body.entries).toEqual([])
    // a reader gets the restored board (the next room open reads the file)
    const reader = await st.client({ boardId: b, user: 'reader' })
    expect(reader.confirmed.get('N2.t')?.isDeleted).toBe(false)
  })

  it('reattaches an arrow’s ends to what is on the board, and moves out of a frame that is gone', async () => {
    const st = await h.stack({ env: { IDLE_EVICT_MS: '200' } })
    const b = newBoardId()
    const R = rect('R2', { x: 0, y: 0, frameId: null })
    const T = text('T2', { x: 400, y: 0 })
    const A = bindArrow(
      arrow('A2', {
        x: 100,
        y: 50,
        points: [
          [0, 0],
          [300, 0],
        ],
      }),
      R,
      T,
    )
    const inner = rect('in', { x: 20, y: 20 })
    const frameEl = {
      ...(await import('../element-room/support/elements.ts')).frame('F2', { x: -500, y: -500 }),
    }
    inner.frameId = 'F2'
    expect((await seed(st, b, [R, T, A, frameEl, inner])).status).toBe(201)
    const c = await st.client({ boardId: b, user: 'ann' })
    const v = (id: string) => c.confirmed.get(id)?.version ?? 1
    await c.push([del('A2', v('A2'))])
    await c.push([del('in', v('in'))])
    await c.push([del('F2', v('F2'))])
    c.close()
    const res = await whenEvicted(() =>
      call<Restored>(st, 'POST', `/internal/boards/${b}/deleted/restore`, { ids: ['shape:A2', 'shape:in'] }),
    )
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ bindings: 2, reparented: 1 })
    const snap = await st.snapshot(b)
    expect(checkInvariants(snap.elements)).toEqual([])
    const byId = new Map(snap.elements.map((e) => [e.id, e as El]))
    expect(byId.get('A2')?.startBinding?.elementId).toBe('R2')
    expect(byId.get('A2')?.endBinding?.elementId).toBe('T2')
    expect(byId.get('R2')?.boundElements).toEqual([{ id: 'A2', type: 'arrow' }])
    expect(byId.get('in')?.frameId).toBeNull()
  })

  it('refuses malformed requests', async () => {
    const st = await h.stack()
    const b = newBoardId()
    await seed(st, b, sampleBoard())
    expect((await call(st, 'POST', `/internal/boards/${b}/deleted/restore`, { ids: [] })).status).toBe(400)
    expect((await call(st, 'POST', `/internal/boards/${b}/deleted/restore`, { ids: ['F'] })).status).toBe(400)
    expect((await call(st, 'GET', `/internal/boards/${b}/deleted?limit=0`)).status).toBe(400)
    expect(
      (await call(st, 'POST', `/internal/boards/${newBoardId()}/deleted/restore`, { ids: ['shape:x'] }))
        .status,
    ).toBe(404)
    const empty = await call<List>(st, 'GET', `/internal/boards/${newBoardId()}/deleted`)
    expect(empty.body).toEqual({ entries: [], total: 0, limit: 2000 })
  })
})
