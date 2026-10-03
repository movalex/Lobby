// The negative security suite: P-W5, an undelete by patch checks its `pv`.
// A `life` false patch based below the tombstone’s version (a stale tab, an offline replay) brings the
// element back only for the deleter of record or an owner; anyone else’s is STALE with the redacted
// tombstone. A current pv still revives (undo, redo, a replay with the corrected pv), and so does a delete
// and its undelete in one push.
// Raw frames against the REAL sync server process (DRAFTROOM_ENGINE=excalidraw), the protocol harness.

import { isRedactedTombstone } from '@draftroom/canvas-schema/elements'
import { describe, expect, it } from 'vitest'
import { type ElementStack, newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { rect, text } from '../harness/elements.ts'
import { expectAccepted, expectRefused, storedEl } from './support.ts'

const shared = sharedElementStack()

type Ack = Awaited<ReturnType<Awaited<ReturnType<ElementStack['client']>>['push']>>
const codes = (ack: Ack) => ack.r.map((r) => (r.ok ? 'ok' : r.code))

describe('P-W5: an undelete checks its pv', () => {
  it('a non-deleter editor’s revive based below the tombstone’s version is STALE (redacted reset); a current pv, the deleter and an owner revive', async () => {
    const st = shared.get()
    const b = newBoardId()
    const S = `SECRET-${Math.random().toString(36).slice(2, 10)}`
    const alice = await st.client({ boardId: b, user: 'alice' })
    const bob = await st.client({ boardId: b, user: 'bob' })
    const olga = await st.client({ boardId: b, user: 'olga', role: 'owner' })
    await alice.create([
      text('t1', { text: S, originalText: S }),
      rect('r2', { x: 300 }),
      rect('r3', { x: 600 }),
    ])
    for (const c of [bob, olga]) await c.untilClock(alice.clock)
    // every client's version before the deletions (a stale tab's or an offline queue's pv)
    const stale = (id: string) => alice.confirmed.get(id)?.version as number
    const pv = { t1: stale('t1'), r2: stale('r2'), r3: stale('r3') }
    const gone = await alice.push(
      ['t1', 'r2', 'r3'].map((id) => alice.patchOp(id, { g: { life: { isDeleted: true } } })),
    )
    expect(codes(gone)).toEqual(['ok', 'ok', 'ok'])
    for (const c of [bob, olga]) await c.untilClock(alice.clock)
    const tomb = (await storedEl(st, b, 't1')).version as number
    expect(tomb).toBeGreaterThan(pv.t1)

    // bob's stale revive of alice's deletion: STALE, the reset copy carries no content, nothing stored
    const seen = bob.of('changes').length
    const r = await bob.one(bob.patchOp('t1', { pv: pv.t1, g: { life: { isDeleted: false } } }))
    expectRefused(r, 'STALE', bob)
    expect(r.ok === false && r.el && isRedactedTombstone(r.el as never)).toBe(true)
    expect(JSON.stringify(r)).not.toContain(S)
    // an offline replay with the same stale pv: STALE too
    const replay = await bob.one(
      bob.patchOp('t1', { pv: pv.t1, g: { life: { isDeleted: false } }, off: 30_000 }),
    )
    expectRefused(replay, 'STALE', bob)
    expect((await storedEl(st, b, 't1')).isDeleted).toBe(true)
    // nothing after the deletion brought its words back to bob's tab
    expect(JSON.stringify(bob.of('changes').slice(seen))).not.toContain(S)

    // the deleter of record's own undo, whatever its tab knew; an owner's; an editor's current pv
    expectAccepted(await alice.one(alice.patchOp('r2', { pv: pv.r2, g: { life: { isDeleted: false } } })))
    expectAccepted(await olga.one(olga.patchOp('r3', { pv: pv.r3, g: { life: { isDeleted: false } } })))
    expectAccepted(await bob.patch('t1', { g: { life: { isDeleted: false } } }))
    const after = await st.snapshot(b)
    expect(after.elements.filter((e) => e.isDeleted).map((e) => e.id)).toEqual([])
  })

  it('a delete, an undo and a redo of one editor, and an offline replay with the current pv, all land', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    const m = await st.client({ boardId: b, user: 'bob' })
    await a.create([rect('r1'), rect('r9', { x: 400 })])
    expectAccepted(await a.patch('r1', { g: { life: { isDeleted: true } } }))
    expectAccepted(await a.patch('r1', { g: { life: { isDeleted: false } } })) // undo
    expectAccepted(await a.patch('r1', { g: { life: { isDeleted: true } } })) // redo
    // a delete and its undelete in ONE push (both on the version the tab knew): the deletion is this
    // push's own, so the undelete is the deleter's (its lb_deleted row is only written at the end)
    const pv9 = a.confirmed.get('r9')?.version as number
    const both = await a.push([
      a.patchOp('r9', { pv: pv9, g: { life: { isDeleted: true } } }),
      a.patchOp('r9', { pv: pv9, g: { life: { isDeleted: false } } }),
    ])
    expect(codes(both)).toEqual(['ok', 'ok'])
    expect((await storedEl(st, b, 'r9')).isDeleted).toBe(false)
    await m.untilClock(a.clock)
    // bob saw the deletion: his undelete (a replay from his queue with the corrected pv) lands
    expectAccepted(await m.patch('r1', { g: { life: { isDeleted: false } }, off: 5_000 }))
    expect((await storedEl(st, b, 'r1')).isDeleted).toBe(false)
    // bob deletes it again: alice's undo from before that deletion (her pv) is STALE, as she is not its
    // deleter of record any more; with the tombstone's version it lands
    await a.untilClock(m.clock)
    const alicePv = a.confirmed.get('r1')?.version as number
    expectAccepted(await m.patch('r1', { g: { life: { isDeleted: true } } }))
    await a.untilClock(m.clock)
    expect(a.confirmed.get('r1')?.version).toBeGreaterThan(alicePv)
    expectRefused(
      await a.one(a.patchOp('r1', { pv: alicePv, g: { life: { isDeleted: false } } })),
      'STALE',
      a,
    )
    expectAccepted(await a.patch('r1', { g: { life: { isDeleted: false } } }))
  })
})
