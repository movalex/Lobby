// Wave T, WS1 (docs/WAVE-T-CONTRACTS.md §3.2): the room's rules for the planning keys with DRAFTROOM_PLANNING on,
// against the REAL sync server process (the test stacks run with the switch on; ./planning-foundation.test.ts keeps
// the switch-off and rev-13 writer cases). One test per rule:
//  - cards, panels, heads, Kanbans and timelines are written by every editing writer of rev 14 (the types and
//    cross-key rules are checkElement's: a card key without card:status, start after due, a panel key on a note);
//  - viewers and commenters are READ_ONLY; a name-only guest who may edit writes status, dates and panel order, but a
//    card:who it writes is INVALID (clearing one is not; a create carrying one lands without it, with a fix);
//  - card:who is an ACCOUNT with a role on the board, from the api's assignee-refs (the fake api here): one call per
//    push for the uids the room's cache lacks, none for a removal or a value already stored; not named INVALID on a
//    patch and stripped (with an ack fix) on a create (a copy of an assigned card is never refused),
//    the api down or 404 UNAVAILABLE (fail closed; nothing written); an undelete keeps its own assignee unasked;
//  - sb:head.audio names a live element with a `file` key when it is set (soft afterwards);
//  - no lock exemption;
//  - the room writes none on its own: a write of a planning key reaches the other tab exactly as written, and a
//    receiving tab gets no frame naming a key nobody wrote.

import { CONNECT_REV_PARAM, CONTRACTS_REV } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import { fileRef } from '../harness/element-api.ts'
import type { ProtocolClientOptions } from '../harness/element-client.ts'
import { type ElementStack, newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import { assetId, frame, image, noteWithLabel, rect, text, versionId } from '../harness/elements.ts'
import { expectAccepted, expectNotStored, expectRefused, storedLobby } from './support.ts'

const shared = sharedElementStack()

type Opts = Omit<ProtocolClientOptions, 'wsUrl' | 'boardId' | 'user'>
/** A tab of this build (rev 14 in its connect URL). */
const tab = (st: ElementStack, boardId: string, user: string, o: Opts = {}) =>
  st.client({ boardId, user, query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) }, ...o })

const CARD = { 'card:status': 'todo', 'card:start': '2026-10-01', 'card:due': '2026-10-30' }
const PANEL = { 'sb:of': 'head', 'sb:pos': 'a0', 'sb:dur': 2000 }
const TIMELINE = { start: '2026-10-01', end: '2026-12-31', scale: 'week', lanes: 'status' }

describe('planning writes from a rev-14 editor (the switch on)', () => {
  it('cards: made, edited, unmade; the element rules hold (status required, start <= due, the types)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab(st, b, 'alice')
    const made = await a.create([
      ...noteWithLabel('n1', 'Write the brief', { customData: { lobby: CARD } }),
      rect('r1', { x: 400, customData: { lobby: { 'card:status': 'doing' } } }),
    ])
    expect(made.r.map((r) => r.ok)).toEqual([true, true, true])
    expect(await storedLobby(st, b, 'n1')).toEqual(CARD)
    expectAccepted(await a.patch('n1', { c: { 'card:status': 'review', 'card:due': '2026-11-02' } }))
    expectAccepted(await a.patch('r1', { c: { 'card:due': '2026-10-20' } }))
    // a card key without the status, start after due, a card key on a frame: INVALID
    expectRefused(await a.patch('n1', { c: { 'card:status': null } }), 'INVALID', a)
    expectRefused(await a.patch('n1', { c: { 'card:start': '2026-12-01' } }), 'INVALID', a)
    expectRefused(
      await a.createOne(frame('f1', { customData: { lobby: { 'card:status': 'todo' } } })),
      'INVALID',
      a,
    )
    expectRefused(await a.patch('r1', { c: { 'card:status': 'later' } }), 'INVALID', a)
    // unmade: every card key removed in one op
    expectAccepted(
      await a.patch('n1', {
        c: { 'card:status': null, 'card:start': null, 'card:due': null },
      }),
    )
    expect(await storedLobby(st, b, 'n1')).toEqual({})
    await expectNotStored(st, b, ['f1'])
  })

  it('storyboards, Kanbans and timelines: a head on a free text, panels on frames, reorder; frames only', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab(st, b, 'alice')
    const ack = await a.create([
      text('head', { customData: { lobby: { 'sb:head': { aspect: '16:9', fps: 24, perRow: 4 } } } }),
      frame('p1', { x: 0, y: 200, customData: { lobby: PANEL } }),
      frame('p2', { x: 900, y: 200, customData: { lobby: { ...PANEL, 'sb:pos': 'a1' } } }),
      frame('k1', { x: 0, y: 1000, customData: { lobby: { kanban: { wip: { doing: 3 } } } } }),
      frame('t1', { x: 900, y: 1000, customData: { lobby: { timeline: TIMELINE } } }),
    ])
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
    // the actor's reorder: one panel's key between its new neighbours; a duration
    expectAccepted(await a.patch('p2', { c: { 'sb:pos': 'Zz' } }))
    expectAccepted(await a.patch('p1', { c: { 'sb:dur': 3500 } }))
    expectAccepted(await a.patch('k1', { c: { kanban: { hidden: ['blocked'] } } }))
    // a panel without its storyboard, a head on a frame, a Kanban on a note, both on one frame: INVALID
    expectRefused(await a.patch('p1', { c: { 'sb:of': null } }), 'INVALID', a)
    expectRefused(await a.patch('p1', { c: { 'sb:head': { aspect: '1:1' } } }), 'INVALID', a)
    expectRefused(await a.patch('t1', { c: { kanban: {} } }), 'INVALID', a)
    expectRefused(
      await a.createOne(rect('r9', { customData: { lobby: { timeline: TIMELINE } } })),
      'INVALID',
      a,
    )
    expect(await storedLobby(st, b, 'p2')).toEqual({ ...PANEL, 'sb:pos': 'Zz' })
    expect(await storedLobby(st, b, 'k1')).toEqual({ kanban: { hidden: ['blocked'] } })
  })

  it('no lock exemption: a locked card or panel takes no planning write (LOCKED); unlocked, it does', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab(st, b, 'alice', { role: 'owner' })
    await a.create([
      rect('r1', { locked: true, customData: { lobby: { 'card:status': 'todo' } } }),
      frame('p1', { x: 400, locked: true, customData: { lobby: PANEL } }),
    ])
    expectRefused(await a.patch('r1', { c: { 'card:status': 'done' } }), 'LOCKED', a)
    expectRefused(await a.patch('p1', { c: { 'sb:pos': 'a5' } }), 'LOCKED', a)
    expect(await storedLobby(st, b, 'r1')).toEqual({ 'card:status': 'todo' })
    expectAccepted(await a.patch('r1', { g: { meta: { locked: false } } }))
    expectAccepted(await a.patch('r1', { c: { 'card:status': 'done' } }))
  })
})

describe('who may write: roles and name-only guests', () => {
  it('viewers and commenters: READ_ONLY', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab(st, b, 'alice')
    await a.create([rect('r1', { customData: { lobby: { 'card:status': 'todo' } } })])
    for (const role of ['viewer', 'commenter'] as const) {
      const c = await tab(st, b, `${role}-1`, { role })
      expectRefused(await c.patch('r1', { c: { 'card:status': 'done' } }), 'READ_ONLY', c)
    }
    expect(await storedLobby(st, b, 'r1')).toEqual({ 'card:status': 'todo' })
  })

  it('a name-only guest who may edit: status, dates and panel order yes; an assignment INVALID, clearing one yes', async () => {
    const st = shared.get()
    const b = newBoardId()
    st.api.setAssignees(b, ['usr_member', 'guest-1'])
    const a = await tab(st, b, 'alice')
    await a.create([
      rect('r1', { customData: { lobby: { 'card:status': 'todo', 'card:who': 'usr_member' } } }),
      rect('r2', { x: 300, customData: { lobby: { 'card:status': 'todo' } } }),
      frame('p1', { x: 600, customData: { lobby: PANEL } }),
    ])
    const g = await tab(st, b, 'guest-1', { guest: true })
    const calls = st.api.assigneeCalls.length
    expectAccepted(await g.patch('r2', { c: { 'card:status': 'doing', 'card:due': '2026-10-31' } }))
    expectAccepted(await g.patch('p1', { c: { 'sb:pos': 'a3' } }))
    // even a uid the api names (the guest's own): a guest never assigns, and the room does not ask
    expectRefused(await g.patch('r2', { c: { 'card:who': 'guest-1' } }), 'INVALID', g)
    expectRefused(await g.patch('r2', { c: { 'card:who': 'usr_member' } }), 'INVALID', g)
    // a guest's copy of an assigned card is not refused: the card lands without its assignee (the ack's fix says so)
    const copy = expectAccepted(
      await g.createOne(
        rect('r3', { x: 900, customData: { lobby: { 'card:status': 'todo', 'card:who': 'usr_member' } } }),
      ),
    )
    expect(copy.fix).toMatchObject({ 'c:card:who': null })
    expect(st.api.assigneeCalls.length, 'no lookup for a guest').toBe(calls)
    expectAccepted(await g.patch('r1', { c: { 'card:who': null } }))
    expect(await storedLobby(st, b, 'r1')).toEqual({ 'card:status': 'todo' })
    expect(await storedLobby(st, b, 'r2')).toEqual({ 'card:status': 'doing', 'card:due': '2026-10-31' })
    expect(await storedLobby(st, b, 'r3')).toEqual({ 'card:status': 'todo' })
  })
})

describe('card:who through assignee-refs', () => {
  it('an account with access is stored; anyone else INVALID; one call per push for the uids not cached; a removal asks nothing', async () => {
    const st = shared.get()
    const b = newBoardId()
    st.api.setAssignees(b, ['usr_ann', 'usr_bo'])
    const a = await tab(st, b, 'alice')
    await a.create([
      rect('c1', { customData: { lobby: { 'card:status': 'todo' } } }),
      rect('c2', { x: 300, customData: { lobby: { 'card:status': 'todo' } } }),
    ])
    const before = st.api.assigneeCalls.length
    // two cards, two uids, one push: one call naming both
    const ack = await a.push([
      a.patchOp('c1', { c: { 'card:who': 'usr_ann' } }),
      a.patchOp('c2', { c: { 'card:who': 'usr_bo' } }),
    ])
    expect(ack.r.map((r) => r.ok)).toEqual([true, true])
    expect(st.api.assigneeCalls.slice(before)).toEqual([{ boardId: b, uids: ['usr_ann', 'usr_bo'] }])
    // cached: the same uids again, and a copy of an assigned card, ask nothing
    expectAccepted(await a.patch('c2', { c: { 'card:who': 'usr_ann' } }))
    expectAccepted(
      await a.createOne(
        rect('c3', { x: 600, customData: { lobby: { 'card:status': 'todo', 'card:who': 'usr_bo' } } }),
      ),
    )
    expect(st.api.assigneeCalls.length).toBe(before + 1)
    // not named (no access, a guest, unknown): INVALID, nothing written
    expectRefused(await a.patch('c1', { c: { 'card:who': 'usr_outsider' } }), 'INVALID', a)
    expect(await storedLobby(st, b, 'c1')).toEqual({ 'card:status': 'todo', 'card:who': 'usr_ann' })
    // a create (a copy, a paste) naming someone without access is not refused: the card lands unassigned, with a fix
    const copy = expectAccepted(
      await a.createOne(
        rect('c4', { x: 900, customData: { lobby: { 'card:status': 'todo', 'card:who': 'usr_nobody' } } }),
      ),
    )
    expect(copy.fix).toMatchObject({ 'c:card:who': null })
    expect(await storedLobby(st, b, 'c4')).toEqual({ 'card:status': 'todo' })
    // a removal and an unchanged value ask nothing
    const n = st.api.assigneeCalls.length
    expectAccepted(await a.patch('c2', { c: { 'card:who': null } }))
    expect(st.api.assigneeCalls.length).toBe(n)
    expect(await storedLobby(st, b, 'c2')).toEqual({ 'card:status': 'todo' })
  })

  it('the api down (503), the board unknown to it (404), or no answer within 3 s: UNAVAILABLE, nothing written', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab(st, b, 'alice')
    await a.create([rect('c1', { customData: { lobby: { 'card:status': 'todo' } } })])
    try {
      for (const [mode, uid] of [
        ['error', 'usr_x1'],
        ['missing', 'usr_x2'],
        ['hang', 'usr_x3'],
      ] as const) {
        st.api.assigneeMode = mode
        expectRefused(await a.patch('c1', { c: { 'card:who': uid } }), 'UNAVAILABLE', a)
      }
      // the other ops of the push still land; the failure is not cached as a no
      st.api.assigneeMode = 'error'
      const ack = await a.push([
        a.patchOp('c1', { c: { 'card:who': 'usr_x1', 'card:status': 'doing' } }),
        a.patchOp('c1', { c: { 'card:due': '2026-10-30' } }),
      ])
      expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['UNAVAILABLE', 'ok'])
      expect(await storedLobby(st, b, 'c1')).toEqual({ 'card:status': 'todo', 'card:due': '2026-10-30' })
    } finally {
      st.api.assigneeMode = 'ok'
    }
    st.api.setAssignees(b, ['usr_x1'])
    expectAccepted(await a.patch('c1', { c: { 'card:who': 'usr_x1' } }))
  })

  it('an undelete brings its own assignee back without a lookup (even with the api down); a person who lost access stays named', async () => {
    const st = shared.get()
    const b = newBoardId()
    st.api.setAssignees(b, ['usr_ann'])
    const a = await tab(st, b, 'alice')
    const card = rect('c1', { customData: { lobby: { 'card:status': 'todo', 'card:who': 'usr_ann' } } })
    expectAccepted(await a.createOne(card))
    st.api.setAssignees(b, [])
    expectAccepted(await a.patch('c1', { g: { life: { isDeleted: true } } }))
    st.api.assigneeMode = 'error'
    try {
      expectAccepted(await a.patch('c1', { g: { life: { isDeleted: false } } }))
      expect(await storedLobby(st, b, 'c1')).toEqual({ 'card:status': 'todo', 'card:who': 'usr_ann' })
      // its edit of another key keeps the assignee (never rewritten by the room)
      expectAccepted(await a.patch('c1', { c: { 'card:status': 'done' } }))
      expect(await storedLobby(st, b, 'c1')).toEqual({ 'card:status': 'done', 'card:who': 'usr_ann' })
    } finally {
      st.api.assigneeMode = 'ok'
    }
  })
})

describe('assignee lookups cannot be flooded', () => {
  it('a push names at most 50 uids the cache lacks: they are asked in one call, the rest INVALID before any lookup', async () => {
    const st = shared.get()
    const b = newBoardId()
    const uids = Array.from({ length: 55 }, (_, i) => `usr_flood${String(i).padStart(2, '0')}`)
    // every one of them an account with access: the five past the cap are refused without being asked
    st.api.setAssignees(b, uids)
    const a = await tab(st, b, 'alice')
    await a.create(
      uids.map((_, i) => rect(`f${i}`, { x: i * 10, customData: { lobby: { 'card:status': 'todo' } } })),
    )
    const before = st.api.assigneeCalls.length
    const ack = await a.push(uids.map((u, i) => a.patchOp(`f${i}`, { c: { 'card:who': u } })))
    const codes = ack.r.map((r) => (r.ok ? 'ok' : r.code))
    expect(codes.slice(0, 50)).toEqual(Array(50).fill('ok'))
    expect(codes.slice(50)).toEqual(Array(5).fill('INVALID'))
    expect(st.api.assigneeCalls.slice(before)).toEqual([{ boardId: b, uids: uids.slice(0, 50) }])
    expect(a.isOpen).toBe(true)
    // cached now: the same 50 again ask nothing
    expectAccepted(await a.patch('f50', { c: { 'card:who': uids[0] as string } }))
    expect(st.api.assigneeCalls.length).toBe(before + 1)
  })

  it('a room asks assignee-refs at most 20 times a minute: past that a new uid is UNAVAILABLE without a call; cached ones still work', async () => {
    const st = shared.get()
    const b = newBoardId()
    const uids = Array.from({ length: 22 }, (_, i) => `usr_rate${String(i).padStart(2, '0')}`)
    st.api.setAssignees(b, uids)
    const a = await tab(st, b, 'alice')
    await a.create([rect('r1', { customData: { lobby: { 'card:status': 'todo' } } })])
    const before = st.api.assigneeCalls.length
    for (const u of uids.slice(0, 20)) expectAccepted(await a.patch('r1', { c: { 'card:who': u } }))
    expect(st.api.assigneeCalls.length).toBe(before + 20)
    // a second tab of the same room shares the room's budget
    const c = await tab(st, b, 'carol')
    expectRefused(await c.patch('r1', { c: { 'card:who': uids[20] as string } }), 'UNAVAILABLE', c)
    expectRefused(await a.patch('r1', { c: { 'card:who': uids[21] as string } }), 'UNAVAILABLE', a)
    expect(st.api.assigneeCalls.length).toBe(before + 20)
    // what the room already knows needs no call
    expectAccepted(await a.patch('r1', { c: { 'card:who': uids[3] as string } }))
    expect(await storedLobby(st, b, 'r1')).toEqual({ 'card:status': 'todo', 'card:who': uids[3] })
  })
})

describe('sb:head.audio', () => {
  it('names a live element with a file when it is set (on the board or earlier/later in the same push); soft afterwards', async () => {
    const st = shared.get()
    const b = newBoardId()
    st.api.addFile(fileRef(versionId(90), assetId(90)))
    const fileValue = {
      assetId: assetId(90),
      versionId: versionId(90),
      kind: 'image',
      name: 'scratch.png',
      mimeType: 'image/png',
      sizeBytes: 1_024,
    }
    const card = (id: string, x = 0) =>
      image(id, versionId(90), { x, customData: { lobby: { file: fileValue } } })
    const a = await tab(st, b, 'alice')
    expect((await a.create([card('vo1'), rect('plain', { x: 300 })])).r.every((r) => r.ok)).toBe(true)
    const head = (id: string, audio: string, x = 600) =>
      text(id, { x, customData: { lobby: { 'sb:head': { aspect: '16:9', audio } } } })
    expectAccepted(await a.createOne(head('h1', 'vo1')))
    expectRefused(await a.createOne(head('h2', 'plain')), 'INVALID', a)
    expectRefused(await a.createOne(head('h3', 'nothere')), 'INVALID', a)
    // a copy of a head with its audio card, the head first in the push
    const ack = await a.create([head('h4', 'vo2', 900), card('vo2', 1200)])
    expect(ack.r.map((r) => r.ok)).toEqual([true, true])
    // soft afterwards: its card deleted, the head's other settings still change
    expectAccepted(await a.patch('vo1', { g: { life: { isDeleted: true } } }))
    expectAccepted(await a.patch('h1', { c: { 'sb:head': { aspect: '9:16', audio: 'vo1' } } }))
    // but a new ref to it is refused
    expectRefused(await a.patch('h4', { c: { 'sb:head': { aspect: '16:9', audio: 'vo1' } } }), 'INVALID', a)
    await expectNotStored(st, b, ['h2', 'h3'])
  })
})

describe('no echo: the room writes no planning key on its own', () => {
  it('another tab gets each planning write exactly as written, and pushes nothing while it only receives', async () => {
    const st = shared.get()
    const b = newBoardId()
    const a = await tab(st, b, 'alice')
    const watcher = await tab(st, b, 'bob')
    await a.create([
      text('head', { customData: { lobby: { 'sb:head': { aspect: '16:9' } } } }),
      frame('p1', { y: 200, customData: { lobby: PANEL } }),
      frame('p2', { x: 900, y: 200, customData: { lobby: { ...PANEL, 'sb:pos': 'a1' } } }),
      rect('r1', { y: 1000, customData: { lobby: { 'card:status': 'todo' } } }),
    ])
    expectAccepted(await a.patch('p2', { c: { 'sb:pos': 'Zz' } }))
    expectAccepted(await a.patch('r1', { c: { 'card:status': 'done' } }))
    await watcher.untilClock(a.clock)
    // every planning value the watcher was sent is one alice wrote (no server re-layout, renumbering or status)
    const sent: Record<string, unknown>[] = []
    for (const m of watcher.received)
      if (m.type === 'changes')
        for (const op of m.ops)
          if (op.k === 'p' && op.c) sent.push(op.c as Record<string, unknown>)
          else if (op.k === 'c') sent.push((op.el.customData?.lobby ?? {}) as Record<string, unknown>)
    const planningKeys = sent.flatMap((c) =>
      Object.keys(c).filter((k) => k.startsWith('card:') || k.startsWith('sb:')),
    )
    expect(planningKeys.sort()).toEqual(
      [
        'sb:head',
        'sb:of',
        'sb:pos',
        'sb:dur',
        'sb:of',
        'sb:pos',
        'sb:dur',
        'card:status',
        'sb:pos',
        'card:status',
      ].sort(),
    )
    expect(watcher.of('ack')).toEqual([])
    expect(await storedLobby(st, b, 'p1')).toEqual(PANEL)
  })
})
