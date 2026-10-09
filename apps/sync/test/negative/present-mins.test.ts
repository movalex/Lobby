// The negative security suite, wave L foundation (L6-4; owner W6): `customData.lobby.present.mins`, the
// minutes W5's run of show plans per frame, at CONTRACTS_REV 12. The room accepts whole minutes from 1 to
// 240 beside `index` and `skip`, refuses anything else INVALID, and keeps present's lock exemption (an
// account's on a locked frame passes; a name-only guest's stays LOCKED). A tab that does not know `mins`
// receives it and keeps working; one that rewrites `present` without it drops it (the value is replaced
// whole), which the run of show's own writes avoid by always sending the whole value.
// Raw frames against the REAL sync server process (DRAFTROOM_ENGINE=excalidraw), the protocol harness.

import { describe, expect, it } from 'vitest'
import { newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { frame, rect } from '../harness/elements.ts'
import { expectAccepted, expectRefused, storedLobby } from './support.ts'

const shared = sharedElementStack()

describe('present.mins (CONTRACTS_REV 12)', () => {
  it('commits whole minutes 1 to 240 beside index and skip; refuses 0, 241 and 1.5', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await st.client({ boardId: b, user: 'fac', role: 'owner' })
    await fac.create([frame('f1', { name: 'Intro' }), frame('f2', { name: 'Body', x: 1000 })])
    expectAccepted(await fac.patch('f1', { c: { present: { index: 0, mins: 5 } } }))
    expectAccepted(await fac.patch('f2', { c: { present: { index: 1, skip: true, mins: 240 } } }))
    for (const mins of [0, 241, 1.5])
      expectRefused(await fac.patch('f1', { c: { present: { index: 0, mins } } }), 'INVALID', fac)
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 0, mins: 5 } })
    expect(await storedLobby(st, b, 'f2')).toEqual({ present: { index: 1, skip: true, mins: 240 } })
  })

  it("keeps present's lock exemption: an account's mins on a locked frame commits, a guest's is LOCKED", async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await st.client({ boardId: b, user: 'fac', role: 'owner' })
    await fac.create([
      frame('f1', { name: 'Intro', locked: true }),
      rect('r-locked', { x: 3000, locked: true }),
    ])
    const ed = await st.client({ boardId: b, user: 'eddie' })
    const g = await st.client({ boardId: b, user: 'guest-mins', guest: true })
    await ed.untilClock(fac.clock)
    expectAccepted(await ed.patch('f1', { c: { present: { index: 0, mins: 10 } } }))
    await g.untilClock(ed.clock)
    expectRefused(await g.patch('f1', { c: { present: { index: 0, mins: 20 } } }), 'LOCKED', g)
    expectRefused(await fac.patch('r-locked', { c: { present: { mins: 3 } } }), 'LOCKED', fac)
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 0, mins: 10 } })
  })

  it('a tab that does not know mins receives it and keeps working; a whole present without it replaces it', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await st.client({ boardId: b, user: 'fac', role: 'owner' })
    await fac.create([frame('f1', { name: 'Intro' })])
    const old = await st.client({ boardId: b, user: 'old-build' })
    expectAccepted(await fac.patch('f1', { c: { present: { index: 0, mins: 7 } } }))
    await old.untilClock(fac.clock)
    expect(old.isOpen).toBe(true)
    // the older build reorders the frames, writing the whole present value it knows (index only)
    expectAccepted(await old.patch('f1', { c: { present: { index: 2 } } }))
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 2 } })
    // pinned (L6-4): customData keys are whole values, so mins went with that write; W5's stepper and
    // reorder always write the whole value they read (index, skip and mins together)
  })
})
