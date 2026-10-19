// Wave V (WS4, V3-1..V3-3): breakouts on the api. Start, the three modes, who may do what (docs/WAVE-V-CONTRACTS.md
// §6.2), time, ending, the conflicts with a live presentation or a spotlight, and that every change reaches everyone
// on the board as one whole state. The leak rule (a group's summon and broadcast reach only that group) is
// ./leak.test.ts; concurrent writers on a real Postgres are ./breakouts.pg.test.ts.
import {
  BREAKOUT_EVENTS,
  BREAKOUT_LIMITS,
  BREAKOUT_RECENT_MS,
  BreakoutState,
  breakoutActionPath,
  breakoutsPath,
  WorkshopBreakoutEvent,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestApi, type TestApi } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { note } from '../workshops/support.ts'
import {
  act,
  type BreakoutWorld,
  breakoutWorld,
  codeOf,
  expectStatus,
  frames,
  grant,
  groupsOf,
  start,
  state,
  stateEvents,
} from './support.ts'

let w: BreakoutWorld | null = null
let other: TestApi | null = null
afterEach(async () => {
  await w?.api.close()
  w = null
  await other?.close()
  other = null
})

const world = async () => {
  w = await breakoutWorld()
  return w
}

describe('start and read', () => {
  it('an editor with an account starts breakouts; everyone on the board reads them and hears one whole state', async () => {
    const w = await world()
    w.tab(w.editor) // the starter is on the board
    const s = await start(w, w.editor, {
      groups: [
        { name: '  Team\tRed ', frameId: 'shape:f1' },
        { name: 'Team Blue', frameId: 'shape:f2' },
        { name: 'Team Green', frameId: 'shape:f3' },
      ],
      mode: 'manual',
      durationMs: 10 * 60_000,
    })
    expect(s.session).toMatchObject({
      boardId: w.boardId,
      mode: 'manual',
      status: 'running',
      createdBy: w.editor.userId,
      groupCap: null,
      endedAt: null,
      rev: 0,
      groups: [
        { id: 'g1', name: 'Team Red', frameId: 'shape:f1' },
        { id: 'g2', name: 'Team Blue', frameId: 'shape:f2' },
        { id: 'g3', name: 'Team Green', frameId: 'shape:f3' },
      ],
    })
    expect(Date.parse(s.session?.endsAt ?? '') - Date.parse(s.session?.createdAt ?? '')).toBe(10 * 60_000)
    expect(s).toMatchObject({ members: [], myGroupId: null, canManage: true })
    const evs = stateEvents(w)
    expect(evs).toHaveLength(1)
    expect(WorkshopBreakoutEvent.parse(evs[0]?.data)).toEqual({ session: s.session, members: [] })
    for (const c of [w.viewer, w.commenter, w.editor2, w.owner]) {
      const v = await state(w, c)
      expect(v.session).toEqual(s.session)
      // the board owner manages anyone's breakouts; another editor does not while the starter can still edit
      expect(v.canManage, c.me.user.name).toBe(c === w.owner)
    }
  })

  it('no session: an empty state; an outsider gets 404 and a visitor 401', async () => {
    const w = await world()
    expect(await state(w, w.viewer)).toMatchObject({
      session: null,
      members: [],
      myGroupId: null,
      canManage: false,
    })
    expectStatus(await w.outsider.req('GET', breakoutsPath(w.boardId)), 404)
    expectStatus(await w.api.anon('GET', breakoutsPath(w.boardId)), 401)
  })

  it('refuses viewers, commenters (403), outsiders (404), visitors (401) and a guest on a workshop link (403)', async () => {
    const w = await world()
    const body = { groups: frames(2), mode: 'manual' }
    expectStatus(await w.viewer.req('POST', breakoutsPath(w.boardId), body), 403)
    expectStatus(await w.commenter.req('POST', breakoutsPath(w.boardId), body), 403)
    expectStatus(await w.outsider.req('POST', breakoutsPath(w.boardId), body), 404)
    expectStatus(await w.api.anon('POST', breakoutsPath(w.boardId), body), 401)
    const link = await guestLink(w.owner, w.boardId, { role: 'editor' })
    const sam = await joinAsGuest(w.api, link.url, 'Sam')
    const res = await sam.req('POST', breakoutsPath(w.boardId), body)
    expect(res.statusCode).toBe(403)
    expect(codeOf(res)).toBe('GUEST_ACCOUNT_REQUIRED')
    expect(stateEvents(w)).toHaveLength(0)
    // the guest still reads the state (view)
    expectStatus(await sam.req('GET', breakoutsPath(w.boardId)), 200)
  })

  it('validates the setup: 2-20 groups, one frame each, names on one line, a cap only for choose', async () => {
    const w = await world()
    const bad = [
      { groups: frames(1), mode: 'manual' },
      { groups: frames(21), mode: 'manual' },
      { groups: [frames(2)[0], { ...frames(2)[1], frameId: 'shape:frame1' }], mode: 'manual' },
      { groups: [{ name: '', frameId: 'shape:a' }, ...frames(1)], mode: 'manual' },
      { groups: [{ name: 'x'.repeat(41), frameId: 'shape:a' }, ...frames(1)], mode: 'manual' },
      { groups: [{ name: 'a‮b', frameId: 'shape:a' }, ...frames(1)], mode: 'manual' },
      { groups: [{ name: 'A', frameId: 'frame1' }, ...frames(1)], mode: 'manual' },
      { groups: frames(2), mode: 'auto', groupCap: 3 },
      { groups: frames(2), mode: 'sometimes' },
      { groups: frames(2), mode: 'manual', durationMs: 1_000 },
      { groups: frames(2), mode: 'manual', extra: true },
    ]
    for (const body of bad) expectStatus(await w.owner.req('POST', breakoutsPath(w.boardId), body), 400)
    expect(stateEvents(w)).toHaveLength(0)
    // 20 groups is fine
    expect((await start(w, w.owner, { groups: frames(20) })).session?.groups.at(-1)?.id).toBe('g20')
  })

  it('group names with ZWJ emoji, a flag with its variation selector or a Persian word start fine (review m7)', async () => {
    const w = await world()
    const s = (...cps: number[]) => String.fromCodePoint(...cps)
    const names = [
      `${s(0x1f469, 0x200d, 0x1f4bb)} Devs`,
      `${s(0x1f3f3, 0xfe0f, 0x200d, 0x1f308)} Team`,
      s(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645),
    ]
    const started = await start(w, w.owner, {
      groups: names.map((name, i) => ({ name, frameId: `shape:f${i + 1}` })),
    })
    expect(started.session?.groups.map((g) => g.name)).toEqual(names)
    // a joiner that joins nothing is still refused
    const stray = [{ name: `Bo${s(0x200d)}b`, frameId: 'shape:a' }, ...frames(1)]
    expectStatus(await act(w.owner, started.session?.id ?? '', 'end'), 200)
    expectStatus(await w.owner.req('POST', breakoutsPath(w.boardId), { groups: stray, mode: 'manual' }), 400)
  })

  it('one running session per board (409 BREAKOUTS_RUNNING); one past its end time is ended by the next start', async () => {
    const w = await world()
    const first = await start(w, w.owner, { durationMs: 60_000 })
    const again = await w.editor.req('POST', breakoutsPath(w.boardId), { groups: frames(2), mode: 'manual' })
    expect(again.statusCode).toBe(409)
    expect(codeOf(again)).toBe('BREAKOUTS_RUNNING')
    w.clock.advance(60_001)
    const next = await start(w, w.editor)
    expect(next.session?.id).not.toBe(first.session?.id)
    const ended = stateEvents(w)
      .map((e) => WorkshopBreakoutEvent.parse(e.data).session)
      .find((s) => s?.id === first.session?.id && s?.status === 'ended')
    expect(ended?.endedAt).toBe(first.session?.endsAt)
  })

  it('409 PRESENTING during a live presentation and 409 SPOTLIGHT while a spotlight is on', async () => {
    const w = await world()
    w.tab(w.owner)
    const p = await w.owner.req('POST', `/api/boards/${w.boardId}/presentation`, {
      tab: 'tab-00000001',
      slideId: null,
      index: 0,
      count: 1,
    })
    expectStatus(p, 200)
    const res = await w.editor.req('POST', breakoutsPath(w.boardId), { groups: frames(2), mode: 'manual' })
    expect(res.statusCode).toBe(409)
    expect(codeOf(res)).toBe('PRESENTING')
    const id = (p.json() as { presentation: { id: string } }).presentation.id
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/presentation/stop`, { id }), 200)

    w.sync.add(w.boardId, note('a'))
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/spotlight`, { refs: ['shape:a'] }), 200)
    const res2 = await w.editor.req('POST', breakoutsPath(w.boardId), { groups: frames(2), mode: 'manual' })
    expect(res2.statusCode).toBe(409)
    expect(codeOf(res2)).toBe('SPOTLIGHT')
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/spotlight/end`, {}), 200)
    await start(w, w.editor)
  })

  it('an archived board: reads work, starting and choosing do not', async () => {
    const w = await world()
    const s = await start(w, w.owner, { mode: 'choose' })
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/archive`), 200)
    expect((await state(w, w.viewer)).session?.id).toBe(s.session?.id)
    const join = await act(w.viewer, s.session?.id ?? '', 'join', { groupId: 'g1' })
    expect(join.statusCode).toBe(409)
    expect(codeOf(join)).toBe('BOARD_ARCHIVED')
    expectStatus(await act(w.owner, s.session?.id ?? '', 'end'), 403)
  })
})

describe('the modes', () => {
  it('auto: everyone with an open tab is dealt out evenly, the starter and board owners left out', async () => {
    const w = await world()
    const guestUrl = (await guestLink(w.owner, w.boardId, { role: 'editor' })).url
    const sam = await joinAsGuest(w.api, guestUrl, 'Sam')
    for (const c of [w.owner, w.editor, w.editor2, w.commenter, w.viewer, sam]) w.tab(c)
    w.tab(w.viewer) // a second tab is still one person
    w.tab(w.outsider) // a stream the board would not admit (no access) is never dealt
    const s = await start(w, w.editor, { mode: 'auto', groups: frames(2) })
    const groups = groupsOf(s)
    const people = [w.editor2, w.commenter, w.viewer, sam].map((c) => c.userId).sort()
    expect([...(groups.g1 ?? []), ...(groups.g2 ?? [])].sort()).toEqual(people)
    expect(Math.abs((groups.g1?.length ?? 0) - (groups.g2?.length ?? 0))).toBeLessThanOrEqual(1)
    // the guest's name is the session's display form
    expect(s.members.find((m) => m.userId === sam.userId)?.name).toMatch(/\(guest\)$/)
    // each person reads their own group
    for (const c of [w.editor2, w.viewer, sam]) {
      const v = await state(w, c)
      expect(v.myGroupId).toBe(s.members.find((m) => m.userId === c.userId)?.groupId)
    }
    expect((await state(w, w.editor)).myGroupId).toBeNull()
    expect((await state(w, w.owner)).myGroupId).toBeNull()
  })

  it('auto: a late joiner is placed in the smallest group at their first read, once; someone taken out stays out', async () => {
    const w = await world()
    w.tab(w.editor2)
    w.tab(w.commenter)
    w.tab(w.viewer)
    const s = await start(w, w.owner, { mode: 'auto', groups: frames(3) })
    expect(s.members).toHaveLength(3)
    const late = await w.api.login('lou', 'Lou Late')
    await grant(w.owner, w.boardId, late.userId, 'viewer')
    const v = await state(w, late)
    expect(v.myGroupId).not.toBeNull()
    expect(v.members).toHaveLength(4)
    expect(v.session?.rev).toBe(1)
    // the next read changes nothing
    const again = await state(w, late)
    expect(again.session?.rev).toBe(1)
    expect(again.myGroupId).toBe(v.myGroupId)
    // the facilitator takes someone out of every group: they are not put back by their next read
    const brk = s.session?.id ?? ''
    expectStatus(await act(w.owner, brk, 'assign', { moves: [{ userId: late.userId, groupId: null }] }), 200)
    const out = await state(w, late)
    expect(out.myGroupId).toBeNull()
    expect(out.members.some((m) => m.userId === late.userId)).toBe(false)
    // ... until the facilitator puts them in a group
    expectStatus(await act(w.owner, brk, 'assign', { moves: [{ userId: late.userId, groupId: 'g2' }] }), 200)
    expect((await state(w, late)).myGroupId).toBe('g2')
  })

  it('manual: nobody is dealt; the facilitator moves people; only people on the board, only real groups', async () => {
    const w = await world()
    w.tab(w.viewer)
    const s = await start(w, w.owner, { mode: 'manual' })
    expect(s.members).toEqual([])
    const brk = s.session?.id ?? ''
    expect((await state(w, w.viewer)).myGroupId).toBeNull()
    const res = await act(w.owner, brk, 'assign', {
      moves: [
        { userId: w.viewer.userId, groupId: 'g2' },
        { userId: w.commenter.userId, groupId: 'g1' },
      ],
    })
    expectStatus(res, 200)
    const after = BreakoutState.parse(res.json())
    expect(groupsOf(after)).toEqual({ g1: [w.commenter.userId], g2: [w.viewer.userId] })
    expect(after.session?.rev).toBe(1)
    // an unchanged move changes nothing (no rev, no event)
    const n = stateEvents(w).length
    const same = BreakoutState.parse(
      (await act(w.owner, brk, 'assign', { moves: [{ userId: w.viewer.userId, groupId: 'g2' }] })).json(),
    )
    expect(same.session?.rev).toBe(1)
    expect(stateEvents(w)).toHaveLength(n)
    expectStatus(
      await act(w.owner, brk, 'assign', { moves: [{ userId: w.viewer.userId, groupId: 'g3' }] }),
      400,
    )
    expectStatus(
      await act(w.owner, brk, 'assign', { moves: [{ userId: w.outsider.userId, groupId: 'g1' }] }),
      400,
    )
    expectStatus(
      await act(w.owner, brk, 'assign', {
        moves: [
          { userId: w.viewer.userId, groupId: 'g1' },
          { userId: w.viewer.userId, groupId: 'g2' },
        ],
      }),
      400,
    )
    // join is for choose mode
    const join = await act(w.viewer, brk, 'join', { groupId: 'g1' })
    expect(join.statusCode).toBe(409)
    expect(codeOf(join)).toBe('BREAKOUT_NOT_CHOOSE')
  })

  it('choose: people pick their group (viewers and guests too), up to the cap; switching frees a place', async () => {
    const w = await world()
    const sam = await joinAsGuest(w.api, (await guestLink(w.owner, w.boardId, { role: 'editor' })).url, 'Sam')
    const s = await start(w, w.owner, { mode: 'choose', groupCap: 1 })
    const brk = s.session?.id ?? ''
    const one = await act(w.viewer, brk, 'join', { groupId: 'g1' })
    expectStatus(one, 200)
    expect(BreakoutState.parse(one.json()).myGroupId).toBe('g1')
    const full = await act(sam, brk, 'join', { groupId: 'g1' })
    expect(full.statusCode).toBe(409)
    expect(codeOf(full)).toBe('BREAKOUT_GROUP_FULL')
    expectStatus(await act(sam, brk, 'join', { groupId: 'g2' }), 200)
    // joining your own group again is fine and changes nothing
    expectStatus(await act(w.viewer, brk, 'join', { groupId: 'g1' }), 200)
    // the viewer leaves g1 for... g2 is full now
    expect(codeOf(await act(w.viewer, brk, 'join', { groupId: 'g2' }))).toBe('BREAKOUT_GROUP_FULL')
    expectStatus(await act(w.viewer, brk, 'join', { groupId: 'g9' }), 400)
    expectStatus(await act(w.outsider, brk, 'join', { groupId: 'g1' }), 404)
    expectStatus(await w.api.anon('POST', breakoutActionPath(brk, 'join'), { groupId: 'g1' }), 401)
    expect(groupsOf(await state(w, w.owner))).toEqual({ g1: [w.viewer.userId], g2: [sam.userId] })
  })

  it('shuffle deals everyone again (members and open tabs, not the starter, not the ones taken out)', async () => {
    const w = await world()
    for (const c of [w.editor, w.editor2, w.commenter, w.viewer]) w.tab(c)
    w.tab(w.owner)
    const s = await start(w, w.owner, { mode: 'manual' })
    const brk = s.session?.id ?? ''
    expectStatus(
      await act(w.owner, brk, 'assign', {
        moves: [
          { userId: w.editor.userId, groupId: 'g1' },
          { userId: w.viewer.userId, groupId: null },
        ],
      }),
      200,
    )
    const res = await act(w.owner, brk, 'shuffle')
    expectStatus(res, 200)
    const after = BreakoutState.parse(res.json())
    const all = Object.values(groupsOf(after)).flat().sort()
    expect(all).toEqual([w.editor.userId, w.editor2.userId, w.commenter.userId].sort())
    expect(
      Math.abs((groupsOf(after).g1?.length ?? 0) - (groupsOf(after).g2?.length ?? 0)),
    ).toBeLessThanOrEqual(1)
  })
})

describe('managing', () => {
  it('a starter who closed every tab of the board: any editor with an account manages; one tab open, they do not (review m6)', async () => {
    const w = await world()
    const tab = w.tab(w.editor)
    const brk = (await start(w, w.editor)).session?.id ?? ''
    expectStatus(await act(w.editor2, brk, 'shuffle'), 403)
    expect((await state(w, w.editor2)).canManage).toBe(false)
    // a tab of another board does not count
    const elsewhere = w.tab(w.editor, 'b-elsewhere00')
    tab.close()
    expect((await state(w, w.editor2)).canManage).toBe(true)
    expectStatus(await act(w.editor2, brk, 'shuffle'), 200)
    // back on the board: theirs again
    const again = w.tab(w.editor)
    expectStatus(await act(w.editor2, brk, 'shuffle'), 403)
    // the owner keeps the right whatever the starter does
    expectStatus(await act(w.owner, brk, 'shuffle'), 200)
    // still nobody without edit or an account
    again.close()
    elsewhere.close()
    expectStatus(await act(w.viewer, brk, 'end'), 403)
    const sam = await joinAsGuest(w.api, (await guestLink(w.owner, w.boardId, { role: 'editor' })).url, 'Sam')
    expect(codeOf(await act(sam, brk, 'end'))).toBe('GUEST_ACCOUNT_REQUIRED')
    expectStatus(await act(w.editor2, brk, 'end'), 200)
  })

  it('the starter and board owners manage; another editor only once the starter can no longer edit', async () => {
    const w = await world()
    // the starter keeps a tab of the board open throughout (with none, they left: the test above)
    w.tab(w.editor)
    const s = await start(w, w.editor, { durationMs: 10 * 60_000 })
    const brk = s.session?.id ?? ''
    const addTime = { addMs: 60_000 }
    expectStatus(await act(w.editor2, brk, 'extend', addTime), 403)
    expectStatus(await act(w.viewer, brk, 'extend', addTime), 403)
    expectStatus(await act(w.commenter, brk, 'extend', addTime), 403)
    expectStatus(await act(w.outsider, brk, 'extend', addTime), 404)
    expectStatus(await act(w.owner, brk, 'extend', addTime), 200)
    expectStatus(await act(w.editor, brk, 'extend', addTime), 200)
    // the starter is lowered to a viewer: any editor with an account takes over
    await grant(w.owner, w.boardId, w.editor.userId, 'viewer')
    expect((await state(w, w.editor2)).canManage).toBe(true)
    expectStatus(await act(w.editor2, brk, 'extend', addTime), 200)
    expectStatus(await act(w.editor, brk, 'extend', addTime), 403)
    // a name-only guest on a workshop link never manages (the guard), whatever role the link gave
    const sam = await joinAsGuest(w.api, (await guestLink(w.owner, w.boardId, { role: 'editor' })).url, 'Sam')
    for (const a of ['assign', 'shuffle', 'extend', 'broadcast', 'summon', 'end'] as const) {
      const res = await act(sam, brk, a, {})
      expect(res.statusCode, a).toBe(403)
      expect(codeOf(res), a).toBe('GUEST_ACCOUNT_REQUIRED')
    }
    // an unknown or malformed id is a 404 for everyone
    expectStatus(await act(w.owner, 'brk_0123456789abcdefghij', 'end'), 404)
    expectStatus(await act(w.owner, 'nope', 'end'), 404)
  })

  it('extend adds time, capped at the longest duration from now; an untimed session is refused (400) and stays untimed (review m5)', async () => {
    const w = await world()
    const s = await start(w, w.owner, { durationMs: 5 * 60_000 })
    const brk = s.session?.id ?? ''
    const res = await act(w.owner, brk, 'extend', { addMs: 5 * 60_000 })
    const after = BreakoutState.parse(res.json())
    expect(Date.parse(after.session?.endsAt ?? '')).toBe(Date.parse(s.session?.endsAt ?? '') + 5 * 60_000)
    expect(after.session?.rev).toBe(1)
    expectStatus(await act(w.owner, brk, 'extend', { addMs: BREAKOUT_LIMITS.extendMaxMs + 1 }), 400)
    for (let i = 0; i < 6; i++)
      expectStatus(await act(w.owner, brk, 'extend', { addMs: BREAKOUT_LIMITS.extendMaxMs }), 200)
    const capped = await state(w, w.owner)
    expect(Date.parse(capped.session?.endsAt ?? '')).toBe(
      w.clock.now().getTime() + BREAKOUT_LIMITS.durationMaxMs,
    )
    expectStatus(await act(w.owner, brk, 'end'), 200)

    const open = await start(w, w.owner, { durationMs: null })
    expect(open.session?.endsAt).toBeNull()
    const before = stateEvents(w).length
    const refused = await act(w.owner, open.session?.id ?? '', 'extend', { addMs: 5 * 60_000 })
    expect(refused.statusCode).toBe(400)
    expect(codeOf(refused)).toBe('BAD_REQUEST')
    expect(await state(w, w.owner)).toMatchObject({ session: { endsAt: null, rev: 0 } })
    expect(stateEvents(w)).toHaveLength(before)
  })

  it('end: the session ends for everyone (idempotent); every manage route then says BREAKOUTS_ENDED', async () => {
    const w = await world()
    w.tab(w.viewer)
    const s = await start(w, w.owner, { mode: 'auto' })
    const brk = s.session?.id ?? ''
    const res = await act(w.owner, brk, 'end')
    expectStatus(res, 200)
    const ended = BreakoutState.parse(res.json())
    expect(ended.session).toMatchObject({ status: 'ended', endedAt: w.clock.now().toISOString(), rev: 1 })
    expect(ended).toMatchObject({ myGroupId: null, canManage: false })
    // members stay (the summary counts them), nobody is "in" a group any more
    expect(ended.members).toHaveLength(1)
    expect((await state(w, w.viewer)).myGroupId).toBeNull()
    const n = stateEvents(w).length
    expectStatus(await act(w.owner, brk, 'end'), 200)
    expect(stateEvents(w)).toHaveLength(n)
    for (const [a, body] of [
      ['assign', { moves: [{ userId: w.viewer.userId, groupId: 'g1' }] }],
      ['shuffle', {}],
      ['extend', { addMs: 60_000 }],
      ['broadcast', { text: 'Hello', groupId: null }],
      ['summon', { groupId: 'g1' }],
    ] as const) {
      const r = await act(w.owner, brk, a, body)
      expect(r.statusCode, a).toBe(409)
      expect(codeOf(r), a).toBe('BREAKOUTS_ENDED')
    }
    // an ended session stays the board's for BREAKOUT_RECENT_MS, then the board has none
    w.clock.advance(BREAKOUT_RECENT_MS - 1_000)
    expect((await state(w, w.viewer)).session?.id).toBe(brk)
    w.clock.advance(2_000)
    expect((await state(w, w.viewer)).session).toBeNull()
  })

  it('a session past its end time is ended by the next read, at its end time, and everyone hears it', async () => {
    const w = await world()
    const s = await start(w, w.owner, { durationMs: 60_000 })
    w.clock.advance(61_000)
    const v = await state(w, w.viewer)
    expect(v.session).toMatchObject({ status: 'ended', endedAt: s.session?.endsAt, rev: 1 })
    const last = WorkshopBreakoutEvent.parse(stateEvents(w).at(-1)?.data)
    expect(last.session?.status).toBe('ended')
    // and a manage call on it is BREAKOUTS_ENDED
    expect(codeOf(await act(w.owner, s.session?.id ?? '', 'extend', { addMs: 60_000 }))).toBe(
      'BREAKOUTS_ENDED',
    )
  })

  it('broadcast and summon answer 204, are never stored, and are limited to one per 3 s per session', async () => {
    const w = await world()
    const s = await start(w, w.owner)
    const brk = s.session?.id ?? ''
    expectStatus(await act(w.owner, brk, 'broadcast', { text: '', groupId: null }), 400)
    expectStatus(await act(w.owner, brk, 'broadcast', { text: 'x'.repeat(201), groupId: null }), 400)
    expectStatus(await act(w.owner, brk, 'broadcast', { text: 'Hi', groupId: 'g7' }), 400)
    expectStatus(await act(w.owner, brk, 'summon', { groupId: 'g7' }), 400)
    expectStatus(await act(w.owner, brk, 'summon', {}), 400)
    const ok = await act(w.owner, brk, 'broadcast', { text: '  Five   minutes left ', groupId: null })
    expectStatus(ok, 204)
    expect(ok.body).toBe('')
    const b = w.events.filter((e) => e.type === BREAKOUT_EVENTS.broadcast)
    expect(b.map((e) => e.data)).toEqual([
      {
        sessionId: brk,
        text: 'Five minutes left',
        from: { userId: w.owner.userId, name: 'Ada Owner' },
        groupId: null,
        at: w.clock.now().toISOString(),
      },
    ])
    expectStatus(await act(w.owner, brk, 'broadcast', { text: 'Again', groupId: null }), 429)
    // the summon window is its own
    expectStatus(await act(w.owner, brk, 'summon', { groupId: 'g1', screen: { w: 1200, h: 800 } }), 204)
    expectStatus(await act(w.owner, brk, 'summon', { groupId: 'g2' }), 429)
    w.clock.advance(3_000)
    expectStatus(await act(w.owner, brk, 'broadcast', { text: 'Again', groupId: 'g2' }), 204)
    // nothing about a message is in the session (the rev did not move)
    expect((await state(w, w.owner)).session?.rev).toBe(0)
    const rows = await w.api.db.query(
      "SELECT 1 FROM breakout_sessions WHERE groups::text LIKE '%Five minutes%' OR groups::text LIKE '%Again%'",
    )
    expect(rows.rows).toHaveLength(0)
  })
})

describe('the switch', () => {
  it('off (the default): every breakout route is an unknown route, even for the board owner', async () => {
    other = await createTestApi()
    const owner = await other.login('ada')
    const res = await owner.req('GET', breakoutsPath('b_0123456789'))
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
    const post = await owner.req('POST', breakoutActionPath('brk_0123456789abcdefghij', 'end'), {})
    expect(post.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
  })
})
