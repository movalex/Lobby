// The selective restore (wave L, L7-2; room-internal/restore-elements.ts) against the REAL sync server process
// with the room open: a checkpoint's copies of chosen elements written into the live board through the room's
// server write (one SAVEPOINT in the drain, broadcast after COMMIT, re-snapped arrows in the same clock).
//
//  - a live and a deleted element come back with their kept ids (created: null for the re-created one);
//  - a text under a lease is skipped LEASED (a note's label: its container's lease), the rest is written;
//  - a unit with an element locked now is skipped INVALID (a label follows its container's lock): never
//    overwritten nor unlocked by the checkpoint's copy; "Undo restore" leaves a locked element too;
//  - a restored target re-snaps the arrows bound to it in the same clock and frame;
//  - a binding (or a frame) that names something neither on the board nor restored is dropped, and a live
//    target lists a restored arrow again;
//  - over the element cap: 409 element-limit, nothing written;
//  - a failed COMMIT writes nothing; a SIGKILL while a restore is in flight leaves all of it or none of it;
//  - the tldraw tables and dr_deleted_* of a converted board are byte-identical before and after;
//  - "Undo restore" (removeAbsent) takes back what came back, and two restores at once serialize.

import { join } from 'node:path'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { MAX_ITEMS } from '@draftroom/canvas-schema/limits'
import { CONNECT_REV_PARAM, CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { reactionKey } from '@draftroom/canvas-schema/reactions'
import { RestoreElementsAnswer } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { drDeletedDigests, tableDigest } from '../../src/room/migrate/digest.ts'
import { arrow, bindArrow, type El, frame, rect, text } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { fixtureRecords, readDb, seedBoardRecords } from '../migrate/board-files.ts'
import { type Answer, call, noteWithText, sampleBoard, seed } from './support.ts'

const h = useElementHarness()
type Stack = Awaited<ReturnType<typeof h.stack>>
type Restored = { restored: string[]; skipped: { id: string; code: string }[]; clock: number }

/** When the SIGKILL lands after the restore was sent: before it is read, while it is applied, after its COMMIT. */
const KILL_DELAYS_MS = [0, 40, 90, 160, 400]
const ACTOR = { uid: 'usr_restorer001', name: 'Rita' }
const del = (id: string, v: number) => ({ k: 'p', id, pv: v, g: { life: { isDeleted: true } } })
const move = (id: string, v: number, x: number, y: number) => ({ k: 'p', id, pv: v, g: { pos: { x, y } } })
const lock = (id: string, v: number, locked = true) => ({ k: 'p', id, pv: v, g: { meta: { locked } } })

function restoreCall(
  st: Stack,
  b: string,
  ids: string[],
  elements: El[],
  extra: Record<string, unknown> = {},
): Promise<Answer<Restored>> {
  return call<Restored>(st, 'POST', `/internal/boards/${b}/restore-elements`, {
    actor: ACTOR,
    ids,
    elements,
    ...extra,
  })
}
async function restore(st: Stack, b: string, ids: string[], elements: El[], extra = {}) {
  const res = await restoreCall(st, b, ids, elements, extra)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return RestoreElementsAnswer.parse(res.body)
}

/** The board's live elements now: what a checkpoint of it holds (a v2 body). */
async function copies(st: Stack, b: string): Promise<El[]> {
  return structuredClone((await st.snapshot(b)).elements.filter((e) => !(e as El).isDeleted) as El[])
}
/** `ids` with their bound texts or containers, as the api sends them (closure over labels). */
function closure(all: readonly El[], ids: readonly string[]): El[] {
  const byId = new Map(all.map((e) => [e.id, e]))
  const out = new Map<string, El>()
  for (const id of ids) {
    const el = byId.get(id)
    if (!el) continue
    const head = el.type === 'text' && el.containerId ? byId.get(el.containerId) : el
    if (!head) continue
    out.set(head.id, head)
    for (const r of (head.boundElements ?? []) as { id: string; type: string }[])
      if (r.type === 'text' && byId.has(r.id)) out.set(r.id, byId.get(r.id) as El)
  }
  return [...out.values()]
}
async function byIdOf(st: Stack, b: string) {
  const snap = await st.snapshot(b)
  return { snap, byId: new Map(snap.elements.map((e) => [e.id, e as El])) }
}

describe('restore-elements: a checkpoint’s elements back into the live board (L7-2)', () => {
  it('a live and a deleted element come back with kept ids, for everyone, in one changes frame', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, sampleBoard())).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    const cp = await copies(st, b)
    const was = new Map(cp.map((e) => [e.id, e]))
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([move('N1', v('N1'), 900, 900)])
    await ann.push([del('R', v('R')), del('R.t', v('R.t'))])
    const tombstone = (await st.snapshot(b)).elements.find((e) => e.id === 'R') as El
    expect(tombstone.isDeleted).toBe(true)

    const res = await restore(st, b, ['N1', 'R'], closure(cp, ['N1', 'R']))
    expect([...res.restored].sort()).toEqual(['N1', 'N1.t', 'R', 'R.t'])
    expect(res.skipped).toEqual([])
    const { snap, byId } = await byIdOf(st, b)
    expect(checkInvariants(snap.elements)).toEqual([])
    expect(byId.get('N1')).toMatchObject({ x: was.get('N1')?.x, y: was.get('N1')?.y, isDeleted: false })
    // the deleted rectangle and its label: re-created with their ids, `created: null`, above both versions
    expect(byId.get('R')).toMatchObject({ isDeleted: false, created: null, x: 1000, y: 0 })
    expect(byId.get('R')?.version).toBeGreaterThan(Math.max(tombstone.version, was.get('R')?.version ?? 0))
    expect(byId.get('R')?.boundElements).toEqual([{ id: 'R.t', type: 'text' }])
    expect(byId.get('R.t')).toMatchObject({ isDeleted: false, containerId: 'R', originalText: 'box' })
    // nothing else moved
    for (const id of ['F', 'N2', 'N2.t', 'T']) expect(byId.get(id)?.version, id).toBe(was.get(id)?.version)
    // everyone got it, at the write's clock, in one frame
    for (const c of [ann, bob]) {
      await c.untilClock(res.clock)
      expect(c.confirmed.get('R')?.isDeleted).toBe(false)
      expect(c.confirmed.get('N1')?.x).toBe(was.get('N1')?.x)
      const frame = c.of('changes').find((f) => f.clock === res.clock)
      expect(frame?.ops.map((o) => ('id' in o ? o.id : o.el.id)).sort()).toEqual(['N1', 'R', 'R.t'])
    }
    // restoring the same copies again writes nothing and answers the clock as it is
    const again = await restore(st, b, ['N1', 'R'], closure(cp, ['N1', 'R']))
    expect([...again.restored].sort()).toEqual(['N1', 'N1.t', 'R', 'R.t'])
    expect(again.clock).toBe(res.clock)
    // round 2: and says it wrote nothing (that clock may be a colleague's commit: there is nothing to undo)
    expect(res.wrote).toBe(true)
    expect(again.wrote).toBe(false)
  })

  it('wave N: reactions are each one’s own mark: a live note keeps the ones it has now; a re-created one comes back with the checkpoint’s', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, sampleBoard())).status).toBe(201)
    const ann = await st.client({
      boardId: b,
      user: 'ann',
      query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) },
    })
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    const react = (id: string, key: string, on: boolean) => ({
      k: 'p',
      id,
      pv: v(id),
      c: { [key]: on ? true : null },
    })
    // the checkpoint: N1 with ann's 'up', N2 with ann's 'heart'
    await ann.push([
      react('N1', reactionKey('up', 'ann'), true),
      react('N2', reactionKey('heart', 'ann'), true),
    ])
    const cp = await copies(st, b)
    // since then: N1's 'up' removed and a 'clap' added, N1 moved; N2 deleted
    await ann.push([react('N1', reactionKey('up', 'ann'), false)])
    await ann.push([react('N1', reactionKey('clap', 'ann'), true), move('N1', v('N1'), 700, 700)])
    await ann.push([del('N2', v('N2')), del('N2.t', v('N2.t'))])
    const res = await restore(st, b, ['N1', 'N2'], closure(cp, ['N1', 'N2']))
    expect(res.skipped).toEqual([])
    const { byId } = await byIdOf(st, b)
    const reactions = (id: string) =>
      Object.keys((byId.get(id)?.customData?.lobby ?? {}) as object).filter((k) => k.startsWith('react:'))
    // the live note: its place from the checkpoint, its reactions as they are now (never the checkpoint's)
    expect(byId.get('N1')?.x).toBe(cp.find((e) => e.id === 'N1')?.x)
    expect(reactions('N1')).toEqual([reactionKey('clap', 'ann')])
    // the re-created note: as the checkpoint held it, its reactions included
    expect(byId.get('N2')?.isDeleted).toBe(false)
    expect(reactions('N2')).toEqual([reactionKey('heart', 'ann')])
    await ann.untilClock(res.clock)
    expect(ann.schemaErrors).toEqual([])
  })

  it('wave N round 1: with DRAFTROOM_REACTIONS off a re-created note comes back without the checkpoint’s reactions (the rollback stays clean after strip-keys)', async () => {
    const dataDir = h.dataDir()
    const on = await h.stack({ dataDir })
    const b = newBoardId()
    expect((await seed(on, b, sampleBoard())).status).toBe(201)
    const ann = await on.client({
      boardId: b,
      user: 'ann',
      query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) },
    })
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([{ k: 'p', id: 'N2', pv: v('N2'), c: { [reactionKey('heart', 'ann')]: true } }])
    const cp = await copies(on, b)
    expect(Object.keys(cp.find((e) => e.id === 'N2')?.customData?.lobby ?? {})).toContain(
      reactionKey('heart', 'ann'),
    )
    await ann.push([del('N2', v('N2')), del('N2.t', v('N2.t'))])
    ann.terminate()
    await on.server.kill('SIGKILL')
    // the documented rollback: reactions off, then the strip, then (here) a restore before the older sync is live
    const off = await h.stack({ dataDir, env: { DRAFTROOM_REACTIONS: 'off' } })
    const stripped = await call(off, 'POST', '/internal/maintenance/strip-keys', { prefix: 'react:' })
    expect(stripped.status).toBe(200)
    const res = await restore(off, b, ['N2'], closure(cp, ['N2']))
    expect(res.skipped).toEqual([])
    const { byId } = await byIdOf(off, b)
    expect(byId.get('N2')?.isDeleted).toBe(false)
    const keys = Object.keys((byId.get('N2')?.customData?.lobby ?? {}) as object)
    expect(keys.filter((k) => k.startsWith('react:'))).toEqual([])
  })

  it('wave T: the checkpoint’s planning keys come back as stored with the switch on; off, a live card keeps its keys now and a re-created one comes back without them', async () => {
    const dataDir = h.dataDir()
    const on = await h.stack({ dataDir })
    const b = newBoardId()
    expect((await seed(on, b, sampleBoard())).status).toBe(201)
    const ann = await on.client({
      boardId: b,
      user: 'ann',
      query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) },
    })
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    const planned = (id: string, c: Record<string, unknown>) => ({ k: 'p', id, pv: v(id), c })
    const lobbyOf = (m: Map<string, El>, id: string) => (m.get(id)?.customData?.lobby ?? {}) as object
    await ann.push([
      planned('N1', { 'card:status': 'todo', 'card:due': '2026-10-30' }),
      planned('N2', { 'card:status': 'doing' }),
      planned('F', { kanban: { hidden: ['blocked'] } }),
    ])
    const cp = await copies(on, b)
    // since then: N1 done, the Kanban relabelled, N2 deleted
    await ann.push([planned('N1', { 'card:status': 'done' }), planned('F', { kanban: {} })])
    await ann.push([del('N2', v('N2')), del('N2.t', v('N2.t'))])
    const res = await restore(on, b, ['N1', 'N2'], closure(cp, ['N1', 'N2']))
    expect(res.skipped).toEqual([])
    let { byId } = await byIdOf(on, b)
    expect(lobbyOf(byId, 'N1')).toEqual({ 'card:status': 'todo', 'card:due': '2026-10-30' })
    expect(lobbyOf(byId, 'N2')).toEqual({ 'card:status': 'doing' })
    // again from the same checkpoint with the switch off (the rollback's first step)
    await ann.push([planned('N1', { 'card:status': 'done' })])
    await ann.push([del('N2', v('N2')), del('N2.t', v('N2.t'))])
    ann.terminate()
    await on.server.kill('SIGKILL')
    const off = await h.stack({ dataDir, env: { DRAFTROOM_PLANNING: 'off' } })
    const again = await restore(off, b, ['N1', 'N2', 'F'], closure(cp, ['N1', 'N2', 'F']))
    expect(again.skipped).toEqual([])
    ;({ byId } = await byIdOf(off, b))
    expect(lobbyOf(byId, 'N1')).toEqual({ 'card:status': 'done', 'card:due': '2026-10-30' })
    expect(lobbyOf(byId, 'F')).toEqual({ kanban: {} })
    expect(byId.get('N2')?.isDeleted).toBe(false)
    expect(lobbyOf(byId, 'N2')).toEqual({})
  })

  it('a text under a lease is skipped LEASED (a label: its container’s lease); the rest is written', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, sampleBoard())).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const cp = await copies(st, b)
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([move('N1', v('N1'), 900, 900), move('R', v('R'), 50, 900), move('T', v('T'), 0, 1500)])
    expect((await ann.acquire('N1')).type).toBe('lease.grant')
    expect((await ann.acquire('T')).type).toBe('lease.grant')
    const before = await byIdOf(st, b)

    // asking for the label names its container's unit: skipped too
    const res = await restore(st, b, ['N1.t', 'R', 'T'], closure(cp, ['N1.t', 'R', 'T']))
    expect(res.skipped).toEqual([
      { id: 'N1.t', code: 'LEASED' },
      { id: 'T', code: 'LEASED' },
    ])
    expect([...res.restored].sort()).toEqual(['R', 'R.t'])
    const { byId } = await byIdOf(st, b)
    for (const id of ['N1', 'N1.t', 'T']) expect(byId.get(id), id).toEqual(before.byId.get(id))
    expect(byId.get('R')).toMatchObject({ x: 1000, y: 0 })

    // once released, it comes back
    ann.release('N1')
    ann.release('T')
    await new Promise((r) => setTimeout(r, 200))
    const later = await restore(st, b, ['N1', 'T'], closure(cp, ['N1', 'T']))
    expect(later.skipped).toEqual([])
    expect([...later.restored].sort()).toEqual(['N1', 'N1.t', 'T'])
  })

  it('a unit with an element locked now is skipped INVALID (never overwritten nor unlocked); Undo leaves a locked one', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, sampleBoard())).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const cp = await copies(st, b)
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    // a facilitator moves the note and the rectangle, then locks them (the checkpoint's copies are unlocked)
    await ann.push([
      move('N1', v('N1'), 900, 900),
      move('R', v('R'), 50, 900),
      move('N2', v('N2'), 900, 1200),
    ])
    await ann.push([lock('N1', v('N1')), lock('R', v('R'))])
    const before = await byIdOf(st, b)
    expect(before.byId.get('N1')?.locked).toBe(true)
    expect(before.byId.get('R')?.locked).toBe(true)

    // the locked note, and the locked rectangle asked for by its label (a label follows its container's lock)
    const res = await restore(st, b, ['N1', 'R.t', 'N2'], closure(cp, ['N1', 'R.t', 'N2']))
    expect(res.skipped).toEqual([
      { id: 'N1', code: 'INVALID' },
      { id: 'R.t', code: 'INVALID' },
    ])
    expect([...res.restored].sort()).toEqual(['N2', 'N2.t'])
    const { snap, byId } = await byIdOf(st, b)
    expect(checkInvariants(snap.elements)).toEqual([])
    for (const id of ['N1', 'N1.t', 'R', 'R.t']) expect(byId.get(id), id).toEqual(before.byId.get(id))
    expect(byId.get('N2')).toMatchObject({ x: 300, y: 40 })

    // once unlocked, it comes back as the checkpoint had it
    await ann.push([lock('N1', v('N1'), false)])
    const later = await restore(st, b, ['N1'], closure(cp, ['N1']))
    expect(later.skipped).toEqual([])
    expect((await byIdOf(st, b)).byId.get('N1')).toMatchObject({ x: 40, y: 40, locked: false })

    // "Undo restore" of what came back: a text locked since then stays (as no push could delete it)
    await ann.push([del('T', v('T'))])
    const beforeRestore = await copies(st, b)
    const back = await restore(st, b, ['T'], closure(cp, ['T']))
    expect(back.restored).toEqual(['T'])
    await ann.until(() => ann.confirmed.get('T')?.isDeleted === false, 'ann saw T come back')
    await ann.push([lock('T', v('T'))])
    const undo = await restore(st, b, ['T'], closure(beforeRestore, ['T']), {
      removeAbsent: true,
      restoreClock: back.clock,
    })
    expect(undo.skipped).toEqual([{ id: 'T', code: 'INVALID' }])
    expect((await byIdOf(st, b)).byId.get('T')).toMatchObject({ isDeleted: false, locked: true })
  })

  it('a restored target re-snaps the arrows bound to it in the same clock and changes frame', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const B = rect('B', { x: 0, y: 0, width: 100, height: 100 })
    const C = rect('C', { x: 600, y: 0, width: 100, height: 100 })
    const A = bindArrow(
      arrow('A', {
        x: 106,
        y: 50,
        width: 488,
        height: 0,
        points: [
          [0, 0],
          [488, 0],
        ],
      }),
      B,
      C,
    )
    expect((await seed(st, b, [B, C, A])).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    const cp = await copies(st, b)
    const arrowAt = (a: El | undefined) => [
      Math.round((a?.x ?? 0) + (a?.points?.at(-1)?.[0] ?? 0)),
      Math.round((a?.y ?? 0) + (a?.points?.at(-1)?.[1] ?? 0)),
    ]
    const endBefore = arrowAt(cp.find((e) => e.id === 'A'))
    await ann.push([move('C', ann.confirmed.get('C')?.version ?? 1, 600, 400)])
    await bob.until(() => (arrowAt(bob.confirmed.get('A'))[1] ?? 0) > 300, 'A follows C')

    const res = await restore(st, b, ['C'], closure(cp, ['C']))
    expect(res.restored).toEqual(['C'])
    const { snap, byId } = await byIdOf(st, b)
    expect(checkInvariants(snap.elements)).toEqual([])
    expect(byId.get('C')).toMatchObject({ x: 600, y: 0 })
    const endAfter = arrowAt(byId.get('A'))
    // back on C's left side (fixed point [0, 0.5]) at the binding gap, where it was before C moved
    expect(endBefore).toEqual([594, 50])
    expect(Math.abs((endAfter[0] ?? 0) - 600)).toBeLessThanOrEqual(12)
    expect(endAfter[1]).toBe(50)
    // the arrow's re-snap is in the restore's own commit: one frame, one clock, both elements
    await bob.untilClock(res.clock)
    const frame = bob.of('changes').find((f) => f.clock === res.clock)
    expect(frame?.ops.map((o) => ('id' in o ? o.id : o.el.id)).sort()).toEqual(['A', 'C'])
    expect(arrowAt(bob.confirmed.get('A'))).toEqual(endAfter)
  })

  it('a binding or a frame that names what is neither on the board nor restored is dropped; a live target lists the arrow', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const F = frame('F', { x: -50, y: -50, width: 500, height: 400, name: 'Ideas' })
    const B = rect('B', { x: 0, y: 0, width: 100, height: 100, frameId: 'F' })
    const C = rect('C', { x: 600, y: 0, width: 100, height: 100 })
    const A = bindArrow(
      arrow('A', {
        x: 106,
        y: 50,
        width: 488,
        height: 0,
        points: [
          [0, 0],
          [488, 0],
        ],
      }),
      B,
      C,
    )
    expect((await seed(st, b, [F, B, C, A])).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const cp = await copies(st, b)
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([del('A', v('A'))])
    await ann.push([del('C', v('C')), del('F', v('F'))])
    await ann.push([del('B', v('B'))])

    const res = await restore(st, b, ['A', 'B'], closure(cp, ['A', 'B']))
    expect([...res.restored].sort()).toEqual(['A', 'B'])
    const { snap, byId } = await byIdOf(st, b)
    expect(checkInvariants(snap.elements)).toEqual([])
    // C stays deleted: the arrow's end is free (where it was); F stays deleted: B is on the page
    expect(byId.get('A')?.startBinding).toMatchObject({ elementId: 'B' })
    expect(byId.get('A')?.endBinding).toBeNull()
    expect(byId.get('B')).toMatchObject({ isDeleted: false, frameId: null })
    expect(byId.get('B')?.boundElements).toEqual([{ id: 'A', type: 'arrow' }])
    expect(byId.get('C')?.isDeleted).toBe(true)

    // an arrow restored alone onto a target that is on the board: the target lists it again
    await ann.push([del('A', ann.confirmed.get('A')?.version ?? 1)])
    await ann.until(() => (ann.confirmed.get('B')?.boundElements ?? null) === null, 'B lists nothing')
    const again = await restore(st, b, ['A'], closure(cp, ['A']))
    expect(again.restored).toEqual(['A'])
    const after = await byIdOf(st, b)
    expect(checkInvariants(after.snap.elements)).toEqual([])
    expect(after.byId.get('B')?.boundElements).toEqual([{ id: 'A', type: 'arrow' }])
  })

  it('over the element cap: 409 element-limit, and nothing is written', { timeout: 120_000 }, async () => {
    const st = await h.stack()
    const b = newBoardId()
    const filler = Array.from({ length: MAX_ITEMS - 2 }, (_, i) =>
      rect(`f${i}`, { x: (i % 200) * 20, y: Math.floor(i / 200) * 20, width: 10, height: 10 }),
    )
    const D1 = rect('D1', { x: -500, y: 0 })
    const D2 = rect('D2', { x: -500, y: 200 })
    expect((await seed(st, b, [...filler, D1, D2])).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const cp = (await copies(st, b)).filter((e) => e.id === 'D1' || e.id === 'D2')
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([del('D1', v('D1')), del('D2', v('D2'))])
    // the board is full again, then the restore would add two
    await ann.create([rect('G1', { x: -900, y: 0 }), rect('G2', { x: -900, y: 200 })])
    const before = (await st.snapshot(b)).clock
    const res = await restoreCall(st, b, ['D1', 'D2'], cp)
    expect(res.status).toBe(409)
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe('element-limit')
    const { snap, byId } = await byIdOf(st, b)
    expect(snap.clock).toBe(before)
    expect(byId.get('D1')?.isDeleted).toBe(true)
    expect(byId.get('D2')?.isDeleted).toBe(true)
  })

  it('a failed COMMIT writes nothing (503) and the next restore lands', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, sampleBoard())).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const cp = await copies(st, b)
    await ann.push([move('N1', ann.confirmed.get('N1')?.version ?? 1, 900, 900)])
    const before = await st.snapshot(b)
    await st.failCommit(b, 1)
    const failed = await restoreCall(st, b, ['N1'], closure(cp, ['N1']))
    expect(failed.status).toBe(503)
    const mid = await st.snapshot(b)
    expect(mid.clock).toBe(before.clock)
    expect(mid.elements).toEqual(before.elements)
    const ok = await restore(st, b, ['N1'], closure(cp, ['N1']))
    expect(ok.restored.sort()).toEqual(['N1', 'N1.t'])
  })

  it('a SIGKILL while a restore is in flight leaves all of it or none of it (5 rounds)', {
    timeout: 180_000,
  }, async () => {
    const st = await h.stack()
    const b = newBoardId()
    const n = 200
    expect(
      (
        await seed(
          st,
          b,
          Array.from({ length: n }, (_, i) => rect(`k${i}`, { x: i * 10, y: 0, width: 8 })),
        )
      ).status,
    ).toBe(201)
    const outcomes: string[] = []
    for (let round = 0; round < KILL_DELAYS_MS.length; round++) {
      const ann = await st.client({ boardId: b, user: `ann${round}` })
      const cp = await copies(st, b)
      const at = new Map(cp.map((e) => [e.id, e.y as number]))
      const xs = new Map(cp.map((e) => [e.id, e.x as number]))
      const ids = cp.map((e) => e.id)
      // everything moves down; then the restore of all of it races a SIGKILL
      await ann.push(
        ids.map((id) => move(id, ann.confirmed.get(id)?.version ?? 1, xs.get(id) ?? 0, 5_000 + round)),
      )
      const inFlight = restoreCall(st, b, ids, cp).catch(() => null)
      await new Promise((r) => setTimeout(r, KILL_DELAYS_MS[round]))
      await st.server.kill('SIGKILL')
      await inFlight
      await st.server.restart()
      const snap = await st.snapshot(b)
      const back = snap.elements.filter((e) => (e as El).y === at.get(e.id)).length
      outcomes.push(back === 0 ? 'none' : back === n ? 'all' : `half:${back}`)
      expect([0, n]).toContain(back)
      expect(checkInvariants(snap.elements)).toEqual([])
    }
    console.log('[restore-kill]', outcomes.join(' '))
  })

  it('leaves the tldraw tables and dr_deleted_* of a converted board byte-identical', {
    timeout: 120_000,
  }, async () => {
    const dataDir = h.dataDir()
    const b = newBoardId()
    const path = seedBoardRecords(join(dataDir, 'rooms'), b, fixtureRecords('kitchen-sink'))
    const st = await h.stack({ dataDir })
    const ann = await st.client({ boardId: b, user: 'ann' })
    const digests = () =>
      readDb(path, (db) => ({
        documents: tableDigest(db, 'documents'),
        metadata: tableDigest(db, 'metadata'),
        dr: drDeletedDigests(db),
      }))
    const before = digests()
    expect(before.documents.rows).toBeGreaterThan(0)
    const cp = await copies(st, b)
    const heads = cp
      .filter((e) => ['rectangle', 'ellipse', 'diamond', 'stickynote'].includes(e.type) && !e.frameId)
      .slice(0, 4)
    expect(heads.length).toBe(4)
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    const gone = closure(cp, [heads[0]?.id as string])
    await ann.push(gone.map((e) => del(e.id, v(e.id))))
    await ann.push(
      heads.slice(1).map((e) => move(e.id, v(e.id), (e.x as number) + 300, (e.y as number) + 300)),
    )
    const res = await restore(
      st,
      b,
      heads.map((e) => e.id),
      closure(
        cp,
        heads.map((e) => e.id),
      ),
    )
    expect(res.restored.length).toBeGreaterThan(0)
    const { snap } = await byIdOf(st, b)
    expect(checkInvariants(snap.elements)).toEqual([])
    expect(digests()).toEqual(before)
  })

  it('"Undo restore" (removeAbsent) takes back what came back, and puts back what moved', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect(
      (await seed(st, b, [...sampleBoard(), ...noteWithText('N3', 'third idea', { x: 0, y: 1200 })])).status,
    ).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    const old = await copies(st, b)
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([del('R', v('R')), del('R.t', v('R.t'))])
    await ann.push([move('N1', v('N1'), 900, 900)])
    // the "before_restore" checkpoint: the board as it is now
    const now = await copies(st, b)
    const described = async () =>
      (await st.snapshot(b)).elements
        .filter((e) => !(e as El).isDeleted)
        .map((e) => `${e.id}@${(e as El).x},${(e as El).y}`)
        .sort()
    const beforeRestore = await described()

    const asked = ['R', 'N1', 'N3']
    const res = await restore(st, b, asked, closure(old, asked))
    expect([...res.restored].sort()).toEqual(['N1', 'N1.t', 'N3', 'N3.t', 'R', 'R.t'])
    const undo = await restore(st, b, asked, closure(now, asked), {
      removeAbsent: true,
      restoreClock: res.clock,
    })
    expect(undo.skipped).toEqual([])
    expect([...undo.restored].sort()).toEqual(['N1', 'N1.t', 'N3', 'N3.t', 'R', 'R.t'])
    expect(await described()).toEqual(beforeRestore)
    const { snap, byId } = await byIdOf(st, b)
    expect(checkInvariants(snap.elements)).toEqual([])
    expect(byId.get('R')?.isDeleted).toBe(true)
    expect(byId.get('R.t')?.isDeleted).toBe(true)
    await bob.untilClock(undo.clock)
    expect(bob.confirmed.get('R')?.isDeleted).toBe(true)
    expect(bob.confirmed.get('N1')?.x).toBe(900)
    // round 1: what the undo removed is "Recently deleted" by the restorer, not by Lobby
    const deleted = await call<{ entries: { shapeId: string; deletedBy: { id: string; name: string } }[] }>(
      st,
      'GET',
      `/internal/boards/${b}/deleted`,
    )
    expect(deleted.body.entries.find((e) => e.shapeId === 'shape:R')?.deletedBy).toEqual({
      id: ACTOR.uid,
      name: ACTOR.name,
    })
    // without removeAbsent, an id the checkpoint lacks is MISSING
    const missing = await restore(st, b, ['R', 'nope'], [text('unrelated', {})])
    expect(missing.skipped).toEqual([
      { id: 'R', code: 'MISSING' },
      { id: 'nope', code: 'MISSING' },
    ])
  })

  it('"Undo restore" is an undo: never revives a colleague’s later deletion nor takes back their later edits (round 1)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect(
      (await seed(st, b, [...sampleBoard(), ...noteWithText('N3', 'third idea', { x: 0, y: 1200 })])).status,
    ).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    const old = await copies(st, b)
    const va = (id: string) => ann.confirmed.get(id)?.version ?? 1
    const vb = (id: string) => bob.confirmed.get(id)?.version ?? 1
    await ann.push([move('N1', va('N1'), 900, 900), move('N2', va('N2'), 900, 1300)])
    await ann.push([del('N3', va('N3')), del('N3.t', va('N3.t'))])
    const before = await copies(st, b)
    // between the 'before_restore' checkpoint and the restore's write, Ann moves the text (the restore leaves it)
    await ann.push([move('T', va('T'), 5, 805)])
    // N1 and N2 moved back, N3 re-created; R is as the checkpoint has it, so nothing of it is written
    const asked = ['N1', 'N2', 'N3', 'R']
    const res = await restore(st, b, asked, closure(old, asked))
    expect(res.skipped).toEqual([])
    await bob.untilClock(res.clock)
    // within the notice's 30 s, Bob deletes N1 and R and moves N3
    await bob.push([del('N1', vb('N1')), del('N1.t', vb('N1.t')), del('R', vb('R')), del('R.t', vb('R.t'))])
    await bob.push([move('N3', vb('N3'), 500, 1500)])
    const undo = await restore(st, b, asked, closure(before, asked), {
      removeAbsent: true,
      restoreClock: res.clock,
    })
    expect(undo.skipped).toEqual([
      { id: 'N1', code: 'CHANGED' },
      { id: 'N3', code: 'CHANGED' },
      { id: 'R', code: 'CHANGED' },
    ])
    expect([...undo.restored].sort()).toEqual(['N2', 'N2.t'])
    const { snap, byId } = await byIdOf(st, b)
    expect(checkInvariants(snap.elements)).toEqual([])
    // Bob's deletions stay, his move stays; only N2 (nobody touched it since) goes back
    expect(byId.get('N1')?.isDeleted).toBe(true)
    expect(byId.get('N1.t')?.isDeleted).toBe(true)
    expect(byId.get('R')?.isDeleted).toBe(true)
    expect(byId.get('N3')).toMatchObject({ isDeleted: false, x: 500, y: 1500 })
    expect(byId.get('N2')).toMatchObject({ x: 900, y: 1300 })
    // a unit the restore did not write has nothing to undo: it stays, even when the checkpoint differs
    const again = await restore(st, b, ['T'], closure(before, ['T']), {
      removeAbsent: true,
      restoreClock: res.clock,
    })
    expect(again).toMatchObject({ restored: ['T'], skipped: [], clock: undo.clock })
    expect((await byIdOf(st, b)).byId.get('T')).toMatchObject({ x: 5, y: 805 })
  })

  it('a tab that was away catches the restore up on reconnect; every frame passes the strict wire schema (any reader rev)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, sampleBoard())).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    const cp = await copies(st, b)
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([del('R', v('R')), del('R.t', v('R.t'))])
    await bob.until(() => bob.confirmed.get('R')?.isDeleted === true, 'bob saw the delete')
    // bob drops off, the restore happens meanwhile, bob comes back with what it had
    const since = bob.clock
    const epoch = bob.epoch
    const had = new Map(bob.confirmed)
    bob.terminate()
    const res = await restore(st, b, ['R'], closure(cp, ['R']))
    const back = await st.client({ boardId: b, user: 'bob', since, epoch, confirmed: had })
    await back.untilClock(res.clock)
    expect(back.confirmed.get('R')?.isDeleted).toBe(false)
    expect(back.confirmed.get('R.t')?.originalText).toBe('box')
    expect(await back.hash()).toBe(await ann.hash())
    // the restore's frames are ordinary `changes` frames: the frozen ServerMessage schema (what a rev-11 and a
    // rev-12 tab parse alike: no field of the wire changed) accepted every one
    for (const c of [ann, back]) expect(c.schemaErrors).toEqual([])
  })

  it('two restores at once both land, one after the other in the room queue', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, sampleBoard())).status).toBe(201)
    const ann = await st.client({ boardId: b, user: 'ann' })
    const cp = await copies(st, b)
    const v = (id: string) => ann.confirmed.get(id)?.version ?? 1
    await ann.push([move('N1', v('N1'), 900, 900), move('N2', v('N2'), 900, 1200)])
    const [one, two] = await Promise.all([
      restore(st, b, ['N1'], closure(cp, ['N1'])),
      restore(st, b, ['N2'], closure(cp, ['N2'])),
    ])
    expect(one.clock).not.toBe(two.clock)
    const { snap, byId } = await byIdOf(st, b)
    expect(checkInvariants(snap.elements)).toEqual([])
    expect(byId.get('N1')).toMatchObject({ x: 40, y: 40 })
    expect(byId.get('N2')).toMatchObject({ x: 300, y: 40 })
  })

  it('refuses a malformed body (400) and answers 404 for a board without a file', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await restoreCall(st, b, [], [])).status).toBe(400)
    expect((await call(st, 'POST', `/internal/boards/${b}/restore-elements`, { ids: ['a'] })).status).toBe(
      400,
    )
    const none = await restoreCall(st, b, ['a'], [rect('a')])
    expect(none.status).toBe(404)
  })
})
