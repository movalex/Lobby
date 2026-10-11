// The negative security suite, wave N (N2-3, N2-4, N2-5): emoji reactions on notes, the identity-bound key class
// `react:<code>:<uid>` (canvas-schema reactions.ts; CONTRACTS_REV 13), one test per server rule:
//  - the class (room/custom-data.ts): only the writer's own uid adds or removes its key, an owner also removes
//    anyone's ("Clear reactions"), sticky notes only, never VOTE_OPEN, guests who can edit may react, read-only
//    roles are refused, 120 keys per note within 6 KiB, and per-op validation still holds around them;
//  - the writer rules for a socket below 13 (room/merge.ts, canvas-schema lobbyPatchOfWriter / lobbyCreateOfWriter):
//    a patch never adds, changes or removes a reaction (dropped, the stored keys kept, no fix), and a create keeps
//    only what its undelete source holds, every other key stripped with an ack fix `c:<key>: null`;
//  - the kill switch DRAFTROOM_REACTIONS (config.ts, fail-closed): off refuses every reaction write UNAVAILABLE,
//    changes nothing else, keeps the stored keys, and the room says 12.
// Raw frames against the REAL sync server process (DRAFTROOM_ENGINE=excalidraw). A client of this build names its
// revision in the connect URL (`rev=13`); one that names none is the rev-11 web, `rev=12` the deployed 3c83611 web.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECT_REV_PARAM, CONTRACTS_REV, REACTIONS_REV } from '@draftroom/canvas-schema/protocol'
import { reactionKey } from '@draftroom/canvas-schema/reactions'
import { REACTION_CODES } from '@draftroom/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProtocolClientOptions } from '../harness/element-client.ts'
import {
  createElementStack,
  type ElementStack,
  newBoardId,
  sharedElementStack,
} from '../harness/element-stack.ts'
import { frame, noteWithLabel, rect, text } from '../harness/elements.ts'
import { expectAccepted, expectNotStored, expectRefused, storedEl, storedLobby } from './support.ts'

const shared = sharedElementStack()

type Opts = Omit<ProtocolClientOptions, 'wsUrl' | 'boardId' | 'user'>
/** A tab of this build (rev 13 in its connect URL). */
const tab13 = (st: ElementStack, boardId: string, user: string, o: Opts = {}) =>
  st.client({ boardId, user, query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) }, ...o })
/** A tab of the deployed web 3c83611 (rev 12 in its connect URL). */
const tab12 = (st: ElementStack, boardId: string, user: string, o: Opts = {}) =>
  st.client({ boardId, user, query: { [CONNECT_REV_PARAM]: '12' }, ...o })
const reactionsIn = (lobby: Record<string, unknown>) =>
  Object.keys(lobby)
    .filter((k) => k.startsWith('react:'))
    .sort()

describe('wave N: the room says 13 (REACTIONS_REV)', () => {
  it('its contracts frame names 13 to every reader', async () => {
    const st = shared.get()
    const b = newBoardId()
    expect(CONTRACTS_REV).toBe(REACTIONS_REV)
    for (const c of [
      await tab13(st, b, 'alice'),
      await tab12(st, b, 'bob'),
      await st.client({ boardId: b, user: 'carol' }),
    ])
      expect(c.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 13 })
  })
})

describe('§3.3 class 3 (wave N, N2-4): identity-bound react:<code>:<uid>', () => {
  it('the writer’s own reaction is added and removed, by an account and by a name-only guest who can edit', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create(noteWithLabel('n1', 'idea'))
    const g = await tab13(st, b, 'guest-gus', { guest: true })
    await g.untilClock(a.clock)
    for (const code of REACTION_CODES)
      expectAccepted(await a.patch('n1', { c: { [reactionKey(code, 'alice')]: true } }))
    expectAccepted(await g.patch('n1', { c: { [reactionKey('party', 'guest-gus')]: true } }))
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toHaveLength(7)
    // an addition again is no change (a key's value is true, nothing else)
    const v = (await storedEl(st, b, 'n1')).version
    await a.untilClock(g.clock)
    expectAccepted(await a.patch('n1', { c: { [reactionKey('up', 'alice')]: true } }))
    expect((await storedEl(st, b, 'n1')).version).toBe(v)
    // removals: the writer's own
    expectAccepted(
      await a.patch('n1', {
        c: { [reactionKey('up', 'alice')]: null, [reactionKey('heart', 'alice')]: null },
      }),
    )
    await g.untilClock(a.clock)
    expectAccepted(await g.patch('n1', { c: { [reactionKey('party', 'guest-gus')]: null } }))
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toEqual(
      ['laugh', 'party', 'think', 'clap'].map((c) => reactionKey(c as never, 'alice')).sort(),
    )
    await st.converged(b, [a, g])
  })

  it('another uid’s reaction, added or removed, is INVALID (a patch, a create); an owner removes anyone’s (Clear reactions) but adds none', async () => {
    const st = shared.get()
    const b = newBoardId()
    const owner = await tab13(st, b, 'olga', { role: 'owner' })
    await owner.create(noteWithLabel('n1', 'idea'))
    const bob = await tab13(st, b, 'bob')
    const eve = await tab13(st, b, 'eve')
    await bob.untilClock(owner.clock)
    expectAccepted(await bob.patch('n1', { c: { [reactionKey('up', 'bob')]: true } }))
    await eve.untilClock(bob.clock)
    expectAccepted(await eve.patch('n1', { c: { [reactionKey('heart', 'eve')]: true } }))
    await bob.untilClock(eve.clock)
    // an editor: another uid's, added or removed
    expectRefused(await bob.patch('n1', { c: { [reactionKey('up', 'eve')]: true } }), 'INVALID', bob)
    expectRefused(await bob.patch('n1', { c: { [reactionKey('heart', 'eve')]: null } }), 'INVALID', bob)
    // the whole op goes: the writer's own key in the same op does not land
    expectRefused(
      await bob.patch('n1', {
        c: { [reactionKey('clap', 'bob')]: true, [reactionKey('heart', 'eve')]: null },
      }),
      'INVALID',
      bob,
    )
    // a create that carries anyone else's (a forged copy), or a malformed key
    const [n2, n2t] = noteWithLabel('n2', 'copy', {
      customData: { lobby: { [reactionKey('up', 'eve')]: true } },
    })
    expectRefused(
      (
        await bob.push([
          { k: 'c', el: n2 },
          { k: 'c', el: n2t },
        ])
      ).r[0] as never,
      'INVALID',
      bob,
    )
    for (const k of ['react:wow:bob', 'react:up:', `react:up:${'b'.repeat(61)}`])
      expectRefused(await bob.patch('n1', { c: { [k]: true } }), 'INVALID', bob)
    expectRefused(await bob.patch('n1', { c: { [reactionKey('up', 'bob')]: false } }), 'INVALID', bob)
    await expectNotStored(st, b, ['n2'])
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toEqual(
      [reactionKey('up', 'bob'), reactionKey('heart', 'eve')].sort(),
    )
    // an owner adds nobody's reaction but its own ...
    await owner.untilClock(bob.clock)
    expectRefused(await owner.patch('n1', { c: { [reactionKey('laugh', 'bob')]: true } }), 'INVALID', owner)
    // ... and clears everyone's in one op (Clear reactions)
    expectAccepted(
      await owner.patch('n1', {
        c: { [reactionKey('up', 'bob')]: null, [reactionKey('heart', 'eve')]: null },
      }),
    )
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toEqual([])
    await st.converged(b, [owner, bob, eve])
  })

  it('a reaction goes on sticky notes only: on a rectangle, a frame or a text it is INVALID (a patch, a create)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create([rect('r1'), frame('f1', { x: 2000 }), text('t1', { x: 4000 })])
    const own = { [reactionKey('up', 'alice')]: true }
    for (const id of ['r1', 'f1', 't1']) expectRefused(await a.patch(id, { c: own }), 'INVALID', a)
    // a removal of one is never refused for the type (there is nothing to remove)
    expectAccepted(await a.patch('r1', { c: { [reactionKey('up', 'alice')]: null } }))
    expectRefused(await a.createOne(rect('r2', { customData: { lobby: own } })), 'INVALID', a)
    await expectNotStored(st, b, ['r2'])
    for (const id of ['r1', 'f1', 't1']) expect(await storedLobby(st, b, id)).toEqual({})
  })

  it('while a dot vote is open a reaction commits and a +1 is VOTE_OPEN', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create(noteWithLabel('n1', 'idea'))
    await st.setWorkshop(b, { voteOpen: true, anonymous: false })
    await a.until(() => a.of('workshop').some((w) => w.voteOpen), 'the vote-open broadcast')
    expectRefused(await a.patch('n1', { c: { 'plusOne:alice': true } }), 'VOTE_OPEN', a)
    expectAccepted(await a.patch('n1', { c: { [reactionKey('think', 'alice')]: true } }))
    expect(await storedLobby(st, b, 'n1')).toEqual({ [reactionKey('think', 'alice')]: true })
  })

  it('read-only roles are refused (a viewer’s, a commenter’s reaction is READ_ONLY); nothing is stored', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create(noteWithLabel('n1', 'idea'))
    for (const role of ['viewer', 'commenter'] as const) {
      const r = await tab13(st, b, `ro-${role}`, { role })
      await r.untilClock(a.clock)
      expectRefused(await r.patch('n1', { c: { [reactionKey('up', `ro-${role}`)]: true } }), 'READ_ONLY', r)
    }
    expect(await storedLobby(st, b, 'n1')).toEqual({})
  })

  it('120 reactions per note commit, the 121st is INVALID; past 6 KiB of reactions it is TOO_LARGE', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create([...noteWithLabel('n1', 'popular'), ...noteWithLabel('n2', 'long names', { x: 600 })])
    // 20 people with every code each: 120 keys
    for (let i = 0; i < 20; i++) {
      const u = `u${String(i).padStart(2, '0')}`
      const c = await tab13(st, b, u)
      const ack = await c.push([
        c.patchOp('n1', {
          c: Object.fromEntries(REACTION_CODES.map((code) => [reactionKey(code, u), true])),
        }),
      ])
      expect(ack.r[0], u).toMatchObject({ ok: true })
      c.close()
    }
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toHaveLength(120)
    const last = await tab13(st, b, 'u20')
    expectRefused(await last.patch('n1', { c: { [reactionKey('up', 'u20')]: true } }), 'INVALID', last)
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toHaveLength(120)
    // long uids (50 characters): the 6 KiB budget is reached before 120 keys
    let tooLarge = 0
    let n = 0
    for (let i = 0; i < 20 && !tooLarge; i++) {
      const u = `p${String(i).padStart(2, '0')}`.padEnd(50, 'x')
      const c = await tab13(st, b, u)
      for (const code of REACTION_CODES) {
        const r = await c.patch('n2', { c: { [reactionKey(code, u)]: true } })
        if (r.ok) n++
        else {
          expectRefused(r, 'TOO_LARGE', c)
          tooLarge++
          break
        }
      }
      c.close()
    }
    expect(tooLarge).toBe(1)
    expect(n).toBeLessThan(120)
    expect(reactionsIn(await storedLobby(st, b, 'n2'))).toHaveLength(n)
  })

  it('per-op validation still holds around a reaction: references and identity-bearing keys refuse their op only', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create([
      ...noteWithLabel('n1', 'one'),
      ...noteWithLabel('n2', 'two', { x: 600 }),
      rect('r1', { x: 1200 }),
    ])
    // one push, three ops: the writer's reaction lands; another uid's is INVALID; a reaction in an op whose
    // membership names a rectangle as its frame is refused with it (the cross-element invariants)
    const ack = await a.push([
      a.patchOp('n1', { c: { [reactionKey('up', 'alice')]: true } }),
      a.patchOp('n2', { c: { [reactionKey('up', 'mallory')]: true } }),
      a.patchOp('n2', { c: { [reactionKey('heart', 'alice')]: true }, g: { membership: { frameId: 'r1' } } }),
    ])
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'INVALID', 'INVALID'])
    expect(await storedLobby(st, b, 'n1')).toEqual({ [reactionKey('up', 'alice')]: true })
    expect(await storedLobby(st, b, 'n2')).toEqual({})
    expect((await storedEl(st, b, 'n2')).frameId).toBeNull()
    // a +1 for another uid next to the writer's own reaction: the op is INVALID whole
    expectRefused(
      await a.patch('n1', { c: { [reactionKey('clap', 'alice')]: true, 'plusOne:mallory': true } }),
      'INVALID',
      a,
    )
    expect(await storedLobby(st, b, 'n1')).toEqual({ [reactionKey('up', 'alice')]: true })
  })
})

describe('writers below 13 (N2-3): a rev-12 or rev-11 tab never adds, removes or forges a reaction', () => {
  it('a rev-12 patch with react:*: null (or a value) keeps the stored keys, commits the rest of the op, and says no fix for them', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create(noteWithLabel('n1', 'idea'))
    expectAccepted(await a.patch('n1', { c: { [reactionKey('up', 'alice')]: true } }))
    const old = await tab12(st, b, 'bob')
    const rev11 = await st.client({ boardId: b, user: 'carl' })
    await old.untilClock(a.clock)
    await rev11.untilClock(a.clock)
    const r = expectAccepted(
      await old.patch('n1', {
        g: { style: { backgroundColor: '#ffc9c9' } },
        c: { [reactionKey('up', 'alice')]: null, [reactionKey('heart', 'bob')]: true },
      }),
    )
    expect(Object.keys(r.fix ?? {}).filter((k) => k.startsWith('c:react:'))).toEqual([])
    const s = await storedEl(st, b, 'n1')
    expect(s.backgroundColor).toBe('#ffc9c9')
    expect(reactionsIn(s.customData?.lobby ?? {})).toEqual([reactionKey('up', 'alice')])
    // only reactions in it: the op is acked and writes nothing (no new version)
    await rev11.untilClock(old.clock)
    const only = expectAccepted(await rev11.patch('n1', { c: { [reactionKey('up', 'alice')]: null } }))
    expect(only.v).toBe(s.version)
    expect((await storedEl(st, b, 'n1')).version).toBe(s.version)
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toEqual([reactionKey('up', 'alice')])
    await st.converged(b, [a, old, rev11])
  })

  it('a rev-12 create carrying another uid’s reaction (a paste of a reacted note) commits stripped, with the fix c:<key>: null', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create(noteWithLabel('n1', 'idea'))
    expectAccepted(await a.patch('n1', { c: { [reactionKey('up', 'alice')]: true, 'tag:x': null } }))
    const old = await tab12(st, b, 'bob')
    await old.untilClock(a.clock)
    // the deployed web's Excalidraw-native paste: the note as it holds it, new ids, its own reaction key too
    const held = old.confirmed.get('n1') as Record<string, unknown>
    const [copy, copyT] = noteWithLabel('copy1', 'idea', {
      x: 900,
      customData: {
        lobby: {
          ...((held.customData as { lobby?: Record<string, unknown> }).lobby ?? {}),
          [reactionKey('heart', 'bob')]: true,
        },
      },
    })
    const ack = await old.push([
      { k: 'c', el: copy },
      { k: 'c', el: copyT },
    ])
    const r = expectAccepted(ack.r[0] as never)
    expect(r.fix).toMatchObject({
      [`c:${reactionKey('up', 'alice')}`]: null,
      [`c:${reactionKey('heart', 'bob')}`]: null,
    })
    expect(reactionsIn(await storedLobby(st, b, 'copy1'))).toEqual([])
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toEqual([reactionKey('up', 'alice')])
    expect(old.schemaErrors).toEqual([])
    await st.converged(b, [a, old])
  })

  it('a rev-12 create over its tombstone (the undo of a delete) keeps the reactions the tombstone holds, and no other', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create(noteWithLabel('n1', 'idea'))
    expectAccepted(await a.patch('n1', { c: { [reactionKey('up', 'alice')]: true } }))
    const old = await tab12(st, b, 'bob')
    await old.untilClock(a.clock)
    const held = structuredClone(old.confirmed.get('n1') as Record<string, unknown>)
    const heldT = structuredClone(old.confirmed.get('n1.t') as Record<string, unknown>)
    const del = await old.push([
      old.patchOp('n1', { g: { life: { isDeleted: true } } }),
      old.patchOp('n1.t', { g: { life: { isDeleted: true } } }),
    ])
    expect(del.r.every((r) => r.ok)).toBe(true)
    // its undo: the note as it held it, back whole, plus a key it never saw (a forgery)
    const lobby = { ...((held.customData as { lobby: Record<string, unknown> }).lobby ?? {}) }
    const back = await old.push([
      {
        k: 'c',
        el: {
          ...held,
          version: (held.version as number) + 2,
          customData: {
            ...(held.customData as object),
            lobby: { ...lobby, [reactionKey('laugh', 'eve')]: true },
          },
        },
      },
      { k: 'c', el: { ...heldT, version: (heldT.version as number) + 2 } },
    ])
    const r = expectAccepted(back.r[0] as never)
    expect(r.fix).toMatchObject({ [`c:${reactionKey('laugh', 'eve')}`]: null })
    expect(Object.keys(r.fix ?? {})).not.toContain(`c:${reactionKey('up', 'alice')}`)
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toEqual([reactionKey('up', 'alice')])
    await a.untilClock(old.clock)
    await st.converged(b, [a, old])
  })

  it('a rev-12 create over its tombstone that lacks the tombstone’s reactions (it never saw them) keeps them, told in the fix; a rev-13 one writes what it says', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab13(st, b, 'alice')
    await a.create(noteWithLabel('n1', 'idea'))
    const old = await tab12(st, b, 'bob')
    await old.untilClock(a.clock)
    // bob's copy from before the reaction (an undo step of the deployed web recorded then)
    const held = structuredClone(old.confirmed.get('n1') as Record<string, unknown>)
    const heldT = structuredClone(old.confirmed.get('n1.t') as Record<string, unknown>)
    expect((await a.patch('n1', { c: { [reactionKey('up', 'alice')]: true } })).ok).toBe(true)
    await old.untilClock(a.clock)
    const del = await old.push(
      ['n1', 'n1.t'].map((id) => old.patchOp(id, { g: { life: { isDeleted: true } } })),
    )
    expect(del.r.every((r) => r.ok)).toBe(true)
    const tomb = (await st.stored(b, 'n1')) as { version: number }
    const back = await old.push([
      { k: 'c', el: { ...held, version: tomb.version + 1 } },
      { k: 'c', el: { ...heldT, version: tomb.version + 1 } },
    ])
    const r = expectAccepted(back.r[0] as never)
    expect(r.fix).toMatchObject({ [`c:${reactionKey('up', 'alice')}`]: true })
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toEqual([reactionKey('up', 'alice')])
    // this build's own create over the tombstone means what it says: without the key, the reaction goes
    await a.untilClock(old.clock)
    const del2 = await a.push(['n1', 'n1.t'].map((id) => a.patchOp(id, { g: { life: { isDeleted: true } } })))
    expect(del2.r.every((x) => x.ok)).toBe(true)
    const tomb2 = (await st.stored(b, 'n1')) as { version: number }
    const back2 = await a.push([
      { k: 'c', el: { ...held, version: tomb2.version + 1 } },
      { k: 'c', el: { ...heldT, version: tomb2.version + 1 } },
    ])
    expect(back2.r.every((x) => x.ok)).toBe(true)
    expect(reactionsIn(await storedLobby(st, b, 'n1'))).toEqual([])
    await old.untilClock(a.clock)
    await st.converged(b, [a, old])
  })
})

// ---- the kill switch (N2-5) -------------------------------------------------------------------------------------

describe('DRAFTROOM_REACTIONS off (N2-5): every reaction write is UNAVAILABLE, nothing else changes, the stored keys stay', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })

  it('off (and unset): the room says 12; an add, a removal and an owner’s clear are UNAVAILABLE; other writes and an undelete land', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-reactions-'))
    dirs.push(dataDir)
    const b = newBoardId()
    // reactions made while the switch was on
    const on = await createElementStack({ dataDir })
    try {
      const a = await tab13(on, b, 'alice', { role: 'owner' })
      await a.create([...noteWithLabel('n1', 'idea'), ...noteWithLabel('n2', 'other', { x: 600 })])
      expectAccepted(await a.patch('n1', { c: { [reactionKey('up', 'alice')]: true } }))
      expectAccepted(await a.patch('n2', { c: { [reactionKey('clap', 'alice')]: true } }))
    } finally {
      await on.dispose()
    }
    for (const env of [{ DRAFTROOM_REACTIONS: 'off' }, { DRAFTROOM_REACTIONS: undefined }]) {
      const st = await createElementStack({ dataDir, env })
      try {
        const a = await tab13(st, b, 'alice', { role: 'owner' })
        expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 12 })
        expect(st.server.logs()).toContain('[reactions] off (DRAFTROOM_REACTIONS is not on)')
        const before = await st.snapshot(b)
        expectRefused(await a.patch('n1', { c: { [reactionKey('heart', 'alice')]: true } }), 'UNAVAILABLE', a)
        expectRefused(await a.patch('n1', { c: { [reactionKey('up', 'alice')]: null } }), 'UNAVAILABLE', a)
        const bob = await tab13(st, b, 'bob')
        expectRefused(await bob.patch('n1', { c: { [reactionKey('up', 'bob')]: true } }), 'UNAVAILABLE', bob)
        // the owner's Clear reactions of someone else's key too
        expectRefused(await a.patch('n1', { c: { [reactionKey('laugh', 'bob')]: null } }), 'UNAVAILABLE', a)
        // nothing changed: same rows, same clock
        const after = await st.snapshot(b)
        expect(after.clock).toBe(before.clock)
        expect(after.elements).toEqual(before.elements)
        // the rest still lands, and the reactions stay on what is edited
        expectAccepted(await a.patch('n1', { g: { style: { backgroundColor: '#d0bfff' } } }))
        expect(reactionsIn(await storedLobby(st, b, 'n1'))).toEqual([reactionKey('up', 'alice')])
        // an undelete brings the note's own reactions back with it (they are the tombstone's, not a write)
        const held = structuredClone(a.confirmed.get('n2') as Record<string, unknown>)
        const heldT = structuredClone(a.confirmed.get('n2.t') as Record<string, unknown>)
        await a.push([
          a.patchOp('n2', { g: { life: { isDeleted: true } } }),
          a.patchOp('n2.t', { g: { life: { isDeleted: true } } }),
        ])
        const back = await a.push([
          { k: 'c', el: { ...held, version: (held.version as number) + 2 } },
          { k: 'c', el: { ...heldT, version: (heldT.version as number) + 2 } },
        ])
        expect(back.r.every((r) => r.ok)).toBe(true)
        expect(reactionsIn(await storedLobby(st, b, 'n2'))).toEqual([reactionKey('clap', 'alice')])
        await st.converged(b, [a, bob])
      } finally {
        await st.dispose()
      }
    }
  })
})
