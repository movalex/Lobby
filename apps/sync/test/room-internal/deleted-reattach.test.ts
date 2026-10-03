// DEF-W3-1: restoring from "Recently deleted" attaches the connectors that stayed on the board to what
// comes back (room-internal/deleted.ts `reattachments`), against the REAL sync server process with the
// room open (the restore is the room's server write, CR 2F-2, so its rule-7 pass re-snaps them).
//
// When an element goes, the engine (Excalidraw's fixBindingsAfterDeletion) and the room's repair
// (room/invariants.ts) null the end of every live arrow bound to it, and its captured row keeps its
// `boundElements` naming those arrows. Before the fix the restore filtered those names out ("Restored 3
// objects." where "reconnected 1 connection" was meant): the connector stayed loose and had to be redrawn.

import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { RestoreDeletedResponse } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { arrow, bindArrow, type El, frame, note, pathUnit, rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { call, seed } from './support.ts'

const h = useElementHarness()

type Restored = { restored: string[]; skipped: unknown[]; bindings: number; reparented: number }
const del = (id: string, v: number) => ({ k: 'p', id, pv: v, g: { life: { isDeleted: true } } })

/**
 * Frame F holding notes N1 and N2; box B outside; connector A from N1's right side to B's left side, both
 * ends at the binding gap (5 + strokeWidth / 2 = 6 px) off the targets, where the engine leaves them.
 */
function frameBoard(): El[] {
  const F = frame('F', { x: -50, y: -50, width: 600, height: 400, name: 'Ideas' })
  const N1 = note('N1', { x: 0, y: 0, frameId: 'F' })
  const N2 = note('N2', { x: 260, y: 0, frameId: 'F' })
  const B = rect('B', { x: 800, y: 50, width: 100, height: 100 })
  const A = bindArrow(
    arrow('A', {
      x: 206,
      y: 100,
      width: 588,
      height: 0,
      points: [
        [0, 0],
        [588, 0],
      ],
    }),
    N1,
    B,
  )
  return [F, N1, N2, B, A]
}

const start = (a: El | undefined): [number, number] => [
  (a?.x ?? 0) + (a?.points?.[0]?.[0] ?? 0),
  (a?.y ?? 0) + (a?.points?.[0]?.[1] ?? 0),
]

async function restore(st: Awaited<ReturnType<typeof h.stack>>, b: string, ids: string[]) {
  const res = await call<Restored>(st, 'POST', `/internal/boards/${b}/deleted/restore`, { ids })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  RestoreDeletedResponse.parse(res.body)
  return res.body
}

describe('a restore attaches the live connectors that lost an end to what comes back (DEF-W3-1)', () => {
  it('a frame with its notes: the connector gets its note end back, for everyone, where it was', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, frameBoard())).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push(['F', 'N1', 'N2'].map((id) => del(id, v(id))))
    await bob.until(() => ann.confirmed.get('A')?.startBinding === null, 'A loose')
    expect(ann.confirmed.get('A')?.startBinding).toBeNull()
    const before = start(ann.confirmed.get('A'))

    const res = await restore(st, b, ['shape:F'])
    expect([...res.restored].sort()).toEqual(['shape:F', 'shape:N1', 'shape:N2'])
    expect(res).toMatchObject({ bindings: 1, reparented: 0 })

    const snap = await st.snapshot(b)
    expect(checkInvariants(snap.elements)).toEqual([])
    const byId = new Map(snap.elements.map((e) => [e.id, e as El]))
    expect(byId.get('A')?.startBinding).toMatchObject({ elementId: 'N1', mode: 'orbit' })
    expect(byId.get('A')?.endBinding?.elementId).toBe('B')
    expect(byId.get('N1')?.boundElements).toEqual([{ id: 'A', type: 'arrow' }])
    // the re-snap keeps the end where the engine left it (within a pixel)
    const after = start(byId.get('A'))
    expect(Math.abs(after[0] - before[0])).toBeLessThan(1)
    expect(Math.abs(after[1] - before[1])).toBeLessThan(1)
    // both open sessions got it in the write's one change frame
    for (const c of [ann, bob]) {
      await c.until(() => c.confirmed.get('A')?.startBinding?.elementId === 'N1', 'A bound again')
      expect(c.confirmed.get('N1')?.boundElements).toEqual([{ id: 'A', type: 'arrow' }])
      expect(c.confirmed.get('N1')?.isDeleted).toBe(false)
    }
  })

  it('a note whose frame is gone: back on the board where it was, its connector attached again', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, frameBoard())).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([del('N1', v('N1'))])
    await ann.push(['F', 'N2'].map((id) => del(id, v(id))))
    const res = await restore(st, b, ['shape:N1'])
    expect(res).toMatchObject({ restored: ['shape:N1'], bindings: 1, reparented: 1 })
    const snap = await st.snapshot(b)
    expect(checkInvariants(snap.elements)).toEqual([])
    const byId = new Map(snap.elements.map((e) => [e.id, e as El]))
    expect(byId.get('N1')).toMatchObject({ isDeleted: false, frameId: null, x: 0, y: 0 })
    expect(byId.get('A')?.startBinding?.elementId).toBe('N1')
    // the frame comes back without it, and without connectors to attach
    const again = await restore(st, b, ['shape:F'])
    expect(again).toMatchObject({ restored: expect.arrayContaining(['shape:F', 'shape:N2']), bindings: 0 })
  })

  it('leaves alone an end someone dragged away or bound elsewhere since', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const els = frameBoard()
    const N1 = els.find((e) => e.id === 'N1') as El
    const B = els.find((e) => e.id === 'B') as El
    const C = rect('C', { x: 0, y: 500, width: 100, height: 100 })
    // a second connector from N1's bottom to C
    const A2 = bindArrow(
      arrow('A2', {
        x: 100,
        y: 206,
        width: 0,
        height: 288,
        points: [
          [0, 0],
          [0, 288],
        ],
      }),
      N1,
      C,
      [0.5001, 1],
      [0.5001, 0],
    )
    expect((await seed(st, b, [...els, C, A2])).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([del('N1', v('N1'))])
    // A's loose start is dragged 200 px up (its end stays on B); A2's loose start is bound to B
    const moved = { ...(ann.confirmed.get('A') as El) }
    moved.y -= 200
    moved.points = [
      [0, 0],
      [588, 200],
    ]
    moved.height = 200
    await ann.push([{ k: 'p', id: 'A', pv: v('A'), g: { path: pathUnit(moved) } }])
    const [sx, sy] = start(ann.confirmed.get('A'))
    expect(Math.hypot(sx - 206, sy + 100)).toBeLessThan(1) // 100 px above N1 now
    await ann.push([
      {
        k: 'p',
        id: 'A2',
        pv: v('A2'),
        g: { bind: { startBinding: { elementId: 'B', fixedPoint: [0.5001, 1], mode: 'orbit' } } },
      },
    ])
    expect(ann.confirmed.get('A2')?.startBinding?.elementId).toBe('B')
    expect(B.id).toBe('B')

    const res = await restore(st, b, ['shape:N1'])
    expect(res).toMatchObject({ restored: ['shape:N1'], bindings: 0 })
    const snap = await st.snapshot(b)
    expect(checkInvariants(snap.elements)).toEqual([])
    const byId = new Map(snap.elements.map((e) => [e.id, e as El]))
    expect(byId.get('A')?.startBinding).toBeNull()
    expect(byId.get('A2')?.startBinding?.elementId).toBe('B')
    expect(byId.get('N1')?.boundElements ?? null).toBeNull()
  })

  it('a self-loop gets both ends back; a rotated target is measured in its own frame', async () => {
    const st = await h.stack()
    const b = newBoardId()
    // R rotated by 90°: its unrotated box is (0,0)-(200,100), on screen (50,-50)-(150,150)
    const R = rect('R', { x: 0, y: 0, width: 200, height: 100, angle: Math.PI / 2 })
    // a loop from R's on-screen top (100,-56) to its on-screen right (156,50), through (220,-80)
    const L = bindArrow(
      arrow('L', {
        x: 100,
        y: -56,
        width: 120,
        height: 106,
        points: [
          [0, 0],
          [120, -24],
          [56, 106],
        ],
      }),
      R,
      R,
      [0, 0.5001],
      [0.5001, 0],
    )
    expect((await seed(st, b, [R, L])).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    await ann.push([del('R', ann.confirmed.get('R')?.version ?? 1)])
    expect(ann.confirmed.get('L')?.startBinding).toBeNull()
    expect(ann.confirmed.get('L')?.endBinding).toBeNull()
    const res = await restore(st, b, ['shape:R'])
    expect(res).toMatchObject({ restored: ['shape:R'], bindings: 2 })
    const snap = await st.snapshot(b)
    expect(checkInvariants(snap.elements)).toEqual([])
    const L2 = snap.elements.find((e) => e.id === 'L') as El
    expect([L2.startBinding?.elementId, L2.endBinding?.elementId]).toEqual(['R', 'R'])
  })

  it('a stale session’s edit of the connector merges with the server’s attach; a restart keeps both', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, frameBoard())).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push(['F', 'N1', 'N2'].map((id) => del(id, v(id))))
    // bob joins, then stops reading: his copy of A (and his base) are from before the restore
    const bob = await st.client({ boardId: b, user: 'bob' })
    const staleVersion = bob.confirmed.get('A')?.version ?? 1
    const staleBase = bob.clock
    await restore(st, b, ['shape:F'])
    await ann.until(() => ann.confirmed.get('A')?.startBinding?.elementId === 'N1', 'A bound again')
    // bob recolours A from his old copy: another group, so it merges and the attach stays
    const ack = await bob.pushNow(
      [{ k: 'p', id: 'A', pv: staleVersion, g: { style: { strokeColor: '#e03131' } } }],
      { base: staleBase },
    ).ack
    expect(ack.r).toEqual([expect.objectContaining({ id: 'A', ok: true })])
    await ann.until(() => ann.confirmed.get('A')?.strokeColor === '#e03131', 'the recolour')
    expect(ann.confirmed.get('A')?.startBinding?.elementId).toBe('N1')

    // a crash and a restart: the board file has both
    ann.terminate()
    bob.terminate()
    await st.server.kill('SIGKILL')
    await st.server.restart()
    const carol = await st.client({ boardId: b, user: 'carol' })
    const A = carol.confirmed.get('A')
    expect(A?.startBinding?.elementId).toBe('N1')
    expect(A?.strokeColor).toBe('#e03131')
    expect(carol.confirmed.get('N1')?.boundElements).toEqual([{ id: 'A', type: 'arrow' }])
    expect(checkInvariants((await st.snapshot(b)).elements)).toEqual([])
  })
})
