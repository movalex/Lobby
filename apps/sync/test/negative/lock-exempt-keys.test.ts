// The negative security suite: CR-3F-2 and CR-3b-4, the customData keys a lock lets through (the
// registry’s `lockExempt`).
// The writer’s own `plusOne:<uid>` (an account’s or a guest’s +1 on a locked template note) and an
// account’s `present` on a locked frame (the facilitator orders and skips locked slides) pass the lock;
// another uid’s +1, other keys, geometry, a guest’s `present` and `present` on a locked non-frame stay
// LOCKED. A +1 keeps its own rules (VOTE_OPEN).
// Raw frames against the REAL sync server process (DRAFTROOM_ENGINE=excalidraw), the protocol harness.

import { describe, expect, it } from 'vitest'
import type { PatchBody } from '../harness/element-client.ts'
import { type ElementStack, newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { frame, noteWithLabel, rect } from '../harness/elements.ts'
import { expectAccepted, expectRefused, storedEl, storedLobby } from './support.ts'

const shared = sharedElementStack()

type Ack = Awaited<ReturnType<Awaited<ReturnType<ElementStack['client']>>['push']>>
const codes = (ack: Ack) => ack.r.map((r) => (r.ok ? 'ok' : r.code))
const tagDef = (k: string) => ({ [`tagDef:${k}`]: { name: k, color: 'red' } })
const tagOn = (k: string) => ({ [`tag:${k}`]: { name: k, color: 'red' } })

describe('CR-3F-2, CR-3b-4: the keys a lock lets through', () => {
  it('the writer’s own +1 (an account’s, a guest’s) lands on a locked note; another uid’s +1, other keys and geometry stay LOCKED', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await st.client({ boardId: b, user: 'fac', role: 'owner' })
    await fac.create(noteWithLabel('n1', 'template prompt'))
    await fac.push([], { doc: { set: tagDef('t') } })
    expectAccepted(await fac.patch('n1', { g: { meta: { locked: true } } }))
    const bob = await st.client({ boardId: b, user: 'bob' })
    const g = await st.client({ boardId: b, user: 'guest-pat', guest: true })
    expectAccepted(await bob.patch('n1', { c: { 'plusOne:bob': true } }))
    expectAccepted(await g.patch('n1', { c: { 'plusOne:guest-pat': true } }))
    // another uid's +1: LOCKED (the lock answers first; unlocked it is INVALID, custom-data.test.ts)
    expectRefused(await bob.patch('n1', { c: { 'plusOne:carol': true } }), 'LOCKED', bob)
    expectRefused(await g.patch('n1', { c: { 'plusOne:bob': null } }), 'LOCKED', g)
    // other customData keys and geometry stay LOCKED, for accounts and guests
    for (const c of [{ alt: 'hi' }, tagOn('t'), { prompt: true }])
      for (const w of [bob, g]) expectRefused(await w.patch('n1', { c }), 'LOCKED', w)
    for (const w of [bob, g]) {
      const r = await w.patch('n1', { g: { pos: { x: 500, y: 500 } } })
      if (r.ok) expect(r.denied).toMatchObject({ code: 'LOCKED' })
      else expectRefused(r, 'LOCKED', w)
    }
    // a +1 with a move in one patch: the +1 lands, the move is denied (partial accept, as for z)
    const mixed = await bob.patch('n1', { g: { pos: { x: 900, y: 900 } }, c: { 'plusOne:bob': null } })
    expect(mixed).toMatchObject({ ok: true, denied: { code: 'LOCKED', groups: ['pos'] } })
    const s = await storedEl(st, b, 'n1')
    expect([s.x, s.y, s.locked]).toEqual([0, 0, true])
    expect(await storedLobby(st, b, 'n1')).toEqual({ 'plusOne:guest-pat': true })
    // the +1's own rules still hold on a locked note: VOTE_OPEN while a dot vote is open
    await st.setWorkshop(b, { voteOpen: true, anonymous: false })
    await bob.until(() => bob.of('workshop').some((w) => w.voteOpen), 'the vote-open broadcast')
    expectRefused(await bob.patch('n1', { c: { 'plusOne:bob': true } }), 'VOTE_OPEN', bob)
    expect(await storedLobby(st, b, 'n1')).toEqual({ 'plusOne:guest-pat': true })
  })

  it('an account reorders and skips a locked frame (present); a guest’s present on it, and present on a locked non-frame, stay LOCKED', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await st.client({ boardId: b, user: 'fac', role: 'owner' })
    await fac.create([
      frame('f1', { name: 'Intro', locked: true }),
      frame('f2', { name: 'Body', x: 1000 }),
      rect('r-locked', { x: 3000, locked: true }),
    ])
    const ed = await st.client({ boardId: b, user: 'eddie' })
    const g = await st.client({ boardId: b, user: 'guest-fr', guest: true })
    // one reorder push, as the frames panel writes it: both frames' present.index
    const order = await fac.push([
      fac.patchOp('f1', { c: { present: { index: 1 } } }),
      fac.patchOp('f2', { c: { present: { index: 0 } } }),
    ])
    expect(codes(order)).toEqual(['ok', 'ok'])
    expect(order.r[0]).not.toHaveProperty('denied')
    await ed.untilClock(fac.clock)
    expectAccepted(await ed.patch('f1', { c: { present: { index: 1, skip: true } } }))
    await g.untilClock(ed.clock)
    expectRefused(await g.patch('f1', { c: { present: { index: 0 } } }), 'LOCKED', g)
    expectRefused(await fac.patch('r-locked', { c: { present: { index: 0 } } }), 'LOCKED', fac)
    // the frame's name and geometry stay LOCKED for the account too
    const bodies: PatchBody[] = [{ g: { meta: { name: 'Renamed' } } }, { g: { pos: { x: 77, y: 77 } } }]
    for (const body of bodies) {
      const r = await ed.patch('f1', body)
      if (r.ok) expect(r.denied).toMatchObject({ code: 'LOCKED' })
      else expectRefused(r, 'LOCKED', ed)
    }
    const f1 = await storedEl(st, b, 'f1')
    expect([f1.x, f1.name, f1.locked]).toEqual([0, 'Intro', true])
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 1, skip: true } })
    expect(await storedLobby(st, b, 'f2')).toEqual({ present: { index: 0 } })
    expect(await storedLobby(st, b, 'r-locked')).toEqual({})
  })

  it('wave L (L6-4): present.mins rides the same exemption: an account times a locked frame, a guest’s mins stays LOCKED', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await st.client({ boardId: b, user: 'fac', role: 'owner' })
    await fac.create([frame('f1', { name: 'Intro', locked: true })])
    const ed = await st.client({ boardId: b, user: 'eddie' })
    const g = await st.client({ boardId: b, user: 'guest-mins', guest: true })
    await ed.untilClock(fac.clock)
    // the run of show writes the whole value (index, skip and mins together)
    expectAccepted(await ed.patch('f1', { c: { present: { index: 0, skip: false, mins: 15 } } }))
    expectAccepted(await fac.patch('f1', { c: { present: { index: 0, skip: false, mins: 20 } } }))
    await g.untilClock(fac.clock)
    expectRefused(await g.patch('f1', { c: { present: { index: 0, skip: false, mins: 5 } } }), 'LOCKED', g)
    // out of range is INVALID before the lock is looked at by anyone (the value's own schema)
    expectRefused(await fac.patch('f1', { c: { present: { index: 0, mins: 241 } } }), 'INVALID', fac)
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 0, skip: false, mins: 20 } })
    const f1 = await storedEl(st, b, 'f1')
    expect(f1.locked).toBe(true)
  })
})
