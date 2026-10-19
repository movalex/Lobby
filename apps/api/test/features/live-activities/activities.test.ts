// OWNER: WS1 (wave V, V1-1..V1-3). The live activity routes through the api (docs/WAVE-V-CONTRACTS.md §2): start,
// answer and change an answer, close, reveal (the results frozen), extend, cancel, hide a word, mark placed, the
// results and the named answers, the past list, the open-state part, the end by time, the starter-left rule and the
// limits. The frozen app clock starts 100 ms into a 5 s window.

import {
  ActivityResultsResponse,
  ActivityState,
  activitiesPath,
  activityActionPath,
  ListActivitiesResponse,
  NamedAnswersResponse,
  OpenStateBody,
  openStatePath,
  WorkshopActivityEvent,
  WorkshopActivityResultsEvent,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  act,
  activityEvents,
  answer,
  errorCode,
  expectStatus,
  idOf,
  POLL,
  SCALE,
  setupWorld,
  start,
  state,
  tab,
  WORDS,
  type World,
} from './support.ts'

let w: World
afterEach(async () => {
  await w?.close()
})

const W = 5_000
const parseState = (res: { json(): unknown }) => ActivityState.parse(res.json())

describe('a poll, start to placement', () => {
  it('starts (201, one event), takes answers, closes, reveals with frozen counts, and is placed once', async () => {
    w = await setupWorld()
    const s = await start(w.owner, w.board, {
      kind: 'poll',
      prompt: 'Which one first?',
      config: { options: ['Alpha', 'Beta', 'Gamma'], maxChoices: 2 },
    })
    expect(ActivityState.parse(s)).toMatchObject({
      activity: {
        kind: 'poll',
        status: 'open',
        anonymous: true,
        resultsLive: false,
        createdBy: w.owner.userId,
      },
      answered: 0,
      myAnswer: null,
      results: { kind: 'poll', answered: 0, counts: [0, 0, 0] },
      canManage: true,
      starterLeft: false,
    })
    const aid = idOf(s)
    expect(activityEvents(w).map((e) => e.type)).toEqual(['workshop.activity'])
    expect(WorkshopActivityEvent.parse(activityEvents(w)[0]?.data)).toMatchObject({
      answered: 0,
      results: null,
    })

    // a viewer, a commenter, a guest and the owner answer; the viewer changes their mind
    for (const [c, choices] of [
      [w.viewer, [0]],
      [w.commenter, [1, 2]],
      [w.guest, [1]],
      [w.owner, [1]],
      [w.viewer, [2]],
    ] as const) {
      const res = await answer(c, aid, { kind: 'poll', choices })
      expectStatus(res, 200)
      // the caller's own answer comes back at once; the count waits for the window
      expect(parseState(res)).toMatchObject({ myAnswer: { kind: 'poll', choices }, answered: 0 })
    }
    // a participant sees no results while it is open (not live); the facilitator sees the last window's
    expect((await state(w.viewer, w.board)).results).toBeNull()
    expect((await state(w.owner, w.board)).results).toEqual({ kind: 'poll', answered: 0, counts: [0, 0, 0] })
    w.clock.advance(W)
    expect(await state(w.owner, w.board)).toMatchObject({
      answered: 4,
      results: { kind: 'poll', answered: 4, counts: [0, 3, 2] },
    })
    expect(await state(w.viewer, w.board)).toMatchObject({
      answered: 4,
      results: null,
      myAnswer: { choices: [2] },
    })

    const closed = await act(w.owner, aid, 'close')
    expectStatus(closed, 200)
    expect(parseState(closed)).toMatchObject({ activity: { status: 'closed' }, answered: 4 })
    expect(errorCode(await answer(w.viewer, aid, { kind: 'poll', choices: [0] }))).toBe('ACTIVITY_NOT_OPEN')
    // idempotent
    expectStatus(await act(w.owner, aid, 'close'), 200)

    const revealed = await act(w.owner, aid, 'reveal')
    expectStatus(revealed, 200)
    expect(parseState(revealed)).toMatchObject({
      activity: { status: 'revealed' },
      answered: 4,
      results: { kind: 'poll', answered: 4, counts: [0, 3, 2] },
      // anonymous: no answer is kept after the reveal
      myAnswer: null,
    })
    expect((await state(w.viewer, w.board)).results).toEqual({ kind: 'poll', answered: 4, counts: [0, 3, 2] })
    const row = await w.api.db.one<{ status: string; results: unknown; n: number }>(
      `SELECT status, results, (SELECT count(*)::int FROM live_answers WHERE activity_id = $1) AS n
         FROM live_activities WHERE id = $1`,
      [aid],
    )
    expect(row).toEqual({
      status: 'revealed',
      results: { kind: 'poll', answered: 4, counts: [0, 3, 2] },
      n: 0,
    })
    const resultsEvents = w.events.filter((e) => e.type === 'workshop.activity.results')
    expect(resultsEvents.map((e) => WorkshopActivityResultsEvent.parse(e.data))).toEqual([
      { activityId: aid, results: { kind: 'poll', answered: 4, counts: [0, 3, 2] } },
    ])
    // a second reveal publishes nothing more
    const n = activityEvents(w).length
    expectStatus(await act(w.owner, aid, 'reveal'), 200)
    expect(activityEvents(w)).toHaveLength(n)

    const res = await w.viewer.req('GET', activityActionPath(aid, 'results'))
    expectStatus(res, 200)
    expect(ActivityResultsResponse.parse(res.json()).results).toEqual({
      kind: 'poll',
      answered: 4,
      counts: [0, 3, 2],
    })

    const placed = await act(w.owner, aid, 'placed')
    expectStatus(placed, 200)
    const placedAt = parseState(placed).activity?.placedAt
    expect(placedAt).toBe(w.clock.now().toISOString())
    w.clock.advance(1_000)
    expect(parseState(await act(w.owner, aid, 'placed')).activity?.placedAt).toBe(placedAt)
  })

  it('refuses an answer that does not fit (400 ACTIVITY_BAD_ANSWER) or breaks the schema (400)', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, POLL))
    for (const bad of [
      { kind: 'poll', choices: [3] },
      { kind: 'poll', choices: [0, 1] },
      { kind: 'scale', value: 3 },
    ]) {
      const res = await answer(w.viewer, aid, bad)
      expect(res.statusCode, JSON.stringify(bad)).toBe(400)
      expect(errorCode(res)).toBe('ACTIVITY_BAD_ANSWER')
    }
    for (const bad of [{ kind: 'poll', choices: [0, 0] }, { kind: 'poll', choices: [] }, { nope: 1 }]) {
      const res = await answer(w.viewer, aid, bad)
      expect(res.statusCode).toBe(400)
      expect(errorCode(res)).toBe('BAD_REQUEST')
    }
    // a body that names someone else is refused (strict)
    const res = await w.viewer.req('POST', activityActionPath(aid, 'answer'), {
      answer: { kind: 'poll', choices: [0] },
      userId: w.owner.userId,
    })
    expect(res.statusCode).toBe(400)
    expect((await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM live_answers')).n).toBe(0)
  })

  it('a second start while one is open is 409 ACTIVITY_OPEN; once it ended by its time a new one starts', async () => {
    w = await setupWorld()
    const first = idOf(await start(w.owner, w.board, { ...POLL, durationMs: 60_000 }))
    const again = await w.editor.req('POST', activitiesPath(w.board), WORDS)
    expect(again.statusCode).toBe(409)
    expect(errorCode(again)).toBe('ACTIVITY_OPEN')
    w.clock.advance(60_000)
    // reported closed by its end time, before anyone closed it
    expect((await state(w.viewer, w.board)).activity).toMatchObject({ id: first, status: 'closed' })
    expect(errorCode(await answer(w.viewer, first, { kind: 'poll', choices: [0] }))).toBe('ACTIVITY_NOT_OPEN')
    const second = await start(w.editor, w.board, WORDS)
    expect(second.activity?.kind).toBe('words')
    const row = await w.api.db.one<{ status: string; closed_at: Date; ends_at: Date }>(
      'SELECT status, closed_at, ends_at FROM live_activities WHERE id = $1',
      [first],
    )
    expect(row.status).toBe('closed')
    expect(row.closed_at.getTime()).toBe(row.ends_at.getTime())
  })

  it('extend adds time to an open timed activity; not to an untimed one (400) nor a closed one (409)', async () => {
    w = await setupWorld()
    const s = await start(w.owner, w.board, { ...POLL, durationMs: 60_000 })
    const aid = idOf(s)
    const ext = await act(w.owner, aid, 'extend', { addMs: 30_000 })
    expectStatus(ext, 200)
    expect(Date.parse(parseState(ext).activity?.endsAt ?? '')).toBe(
      Date.parse(s.activity?.endsAt ?? '') + 30_000,
    )
    expect(activityEvents(w).at(-1)?.data).toMatchObject({
      activity: { endsAt: parseState(ext).activity?.endsAt },
    })
    expect((await act(w.owner, aid, 'extend', { addMs: 31 * 60_000 })).statusCode).toBe(400)
    expectStatus(await act(w.owner, aid, 'close'), 200)
    expect(errorCode(await act(w.owner, aid, 'extend', { addMs: 30_000 }))).toBe('ACTIVITY_NOT_OPEN')
    await act(w.owner, aid, 'cancel')
    const untimed = idOf(await start(w.owner, w.board, POLL))
    expect((await act(w.owner, untimed, 'extend', { addMs: 30_000 })).statusCode).toBe(400)
  })

  it('cancel: the activity is not shown any more, an anonymous one keeps no answer, a revealed one cannot be', async () => {
    w = await setupWorld()
    const firstId = idOf(await start(w.owner, w.board, POLL))
    expectStatus(await answer(w.viewer, firstId, { kind: 'poll', choices: [0] }), 200)
    expectStatus(await act(w.owner, firstId, 'reveal'), 200)
    expect(errorCode(await act(w.owner, firstId, 'cancel'))).toBe('ACTIVITY_NOT_OPEN')
    const aid = idOf(await start(w.owner, w.board, SCALE))
    expectStatus(await answer(w.viewer, aid, { kind: 'scale', value: 4 }), 200)
    const res = await act(w.owner, aid, 'cancel')
    expectStatus(res, 200)
    // the board's last revealed one is shown again
    expect(parseState(res).activity?.id).toBe(firstId)
    expect((await state(w.viewer, w.board)).activity?.id).toBe(firstId)
    expect(
      (
        await w.api.db.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM live_answers WHERE activity_id = $1',
          [aid],
        )
      ).n,
    ).toBe(0)
    const row = await w.api.db.one<{ status: string; results: unknown }>(
      'SELECT status, results FROM live_activities WHERE id = $1',
      [aid],
    )
    expect(row).toEqual({ status: 'cancelled', results: null })
    expect((await w.viewer.req('GET', activityActionPath(aid, 'results'))).statusCode).toBe(404)
    expect(errorCode(await act(w.owner, aid, 'reveal'))).toBe('ACTIVITY_NOT_OPEN')
    expect(errorCode(await act(w.owner, aid, 'placed'))).toBe('ACTIVITY_NOT_REVEALED')
  })
})

describe('a scale and a word cloud', () => {
  it('a scale: counts per value, mean and median', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, SCALE))
    for (const [c, value] of [
      [w.viewer, 1],
      [w.commenter, 4],
      [w.guest, 5],
      [w.editor, 4],
    ] as const)
      expectStatus(await answer(c, aid, { kind: 'scale', value }), 200)
    expect(errorCode(await answer(w.owner, aid, { kind: 'scale', value: 0 }))).toBe('ACTIVITY_BAD_ANSWER')
    const s = parseState(await act(w.owner, aid, 'reveal'))
    expect(s.results).toEqual({ kind: 'scale', answered: 4, counts: [1, 0, 0, 2, 1], mean: 3.5, median: 4 })
  })

  it('ZWJ emoji, a flag with its variation selector and a Persian word are taken as words, options and prompts (review m7)', async () => {
    w = await setupWorld()
    const s = (...cps: number[]) => String.fromCodePoint(...cps)
    const coder = s(0x1f469, 0x200d, 0x1f4bb)
    const rainbow = s(0x1f3f3, 0xfe0f, 0x200d, 0x1f308)
    const persian = s(0x0645, 0x06cc, 0x200c, 0x062e, 0x0648, 0x0627, 0x0647, 0x0645)
    const poll = idOf(
      await start(w.owner, w.board, {
        kind: 'poll',
        prompt: `${rainbow} ${persian}?`,
        config: { options: [coder, rainbow, persian] },
      }),
    )
    expectStatus(await act(w.owner, poll, 'cancel'), 200)
    const aid = idOf(await start(w.owner, w.board, WORDS))
    expectStatus(await answer(w.viewer, aid, { kind: 'words', words: [coder, rainbow, persian] }), 200)
    expect(errorCode(await answer(w.commenter, aid, { kind: 'words', words: [`Bo${s(0x200d)}b`] }))).toBe(
      'BAD_REQUEST',
    )
    const revealed = parseState(await act(w.owner, aid, 'reveal'))
    expect(
      revealed.results?.kind === 'words' ? revealed.results.words.map((x) => x.text).sort() : [],
    ).toEqual([coder, rainbow, persian].sort())
  })

  it('words group by their normalized form, one person counts a word once, and a hidden word leaves every result', async () => {
    w = await setupWorld()
    const s = await start(w.owner, w.board, { ...WORDS, resultsLive: true })
    const aid = idOf(s)
    for (const [c, words] of [
      [w.viewer, ['Agile', 'rude']],
      [w.commenter, ['agile ', 'Ｆｏｃｕｓ']],
      [w.guest, ['AGILE', 'focus', 'rude']],
    ] as const)
      expectStatus(await answer(c, aid, { kind: 'words', words }), 200)
    expect((await answer(w.editor, aid, { kind: 'words', words: ['a', 'A'] })).statusCode).toBe(400)
    expect(errorCode(await answer(w.editor, aid, { kind: 'words', words: ['a', 'b', 'c', 'd'] }))).toBe(
      'ACTIVITY_BAD_ANSWER',
    )
    w.clock.advance(W)
    // live results: everyone sees the windowed words
    expect((await state(w.viewer, w.board)).results).toEqual({
      kind: 'words',
      answered: 3,
      words: [
        { text: 'agile', count: 3 },
        { text: 'focus', count: 2 },
        { text: 'rude', count: 2 },
      ].map((x) => (x.text === 'agile' ? { text: 'AGILE', count: 3 } : x)),
      distinct: 3,
      hidden: 0,
    })
    // moderation: a manager hides it (by any spelling), at once, with an event; a participant cannot
    expect((await act(w.viewer, aid, 'hide', { word: 'rude' })).statusCode).toBe(403)
    const before = activityEvents(w).length
    const hidden = await act(w.owner, aid, 'hide', { word: ' RUDE ' })
    expectStatus(hidden, 200)
    expect(parseState(hidden)).toMatchObject({ hiddenWords: ['rude'], results: { distinct: 2, hidden: 1 } })
    expect(activityEvents(w).length).toBe(before + 1)
    expect(JSON.stringify(activityEvents(w).at(-1)?.data)).not.toMatch(/rude/i)
    // (the viewer's own answer still holds it: it is theirs)
    expect(JSON.stringify((await state(w.commenter, w.board)).results)).not.toMatch(/rude/i)
    expect((await state(w.viewer, w.board)).hiddenWords).toEqual([])
    // idempotent
    const n = activityEvents(w).length
    expectStatus(await act(w.owner, aid, 'hide', { word: 'rude' }), 200)
    expect(activityEvents(w)).toHaveLength(n)
    // the reveal freezes it without the hidden word; a word hidden after the reveal leaves the frozen results too
    const revealed = parseState(await act(w.owner, aid, 'reveal'))
    expect(revealed.results).toMatchObject({ distinct: 2, hidden: 1 })
    expectStatus(await act(w.owner, aid, 'hide', { word: 'focus' }), 200)
    const after = await state(w.viewer, w.board)
    expect(after.results).toEqual({
      kind: 'words',
      answered: 3,
      words: [{ text: 'AGILE', count: 3 }],
      distinct: 1,
      hidden: 2,
    })
    const list = ListActivitiesResponse.parse((await w.viewer.req('GET', activitiesPath(w.board))).json())
    expect(JSON.stringify(list)).not.toMatch(/rude|focus/i)
  })

  it('hide is for word clouds only (400)', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, POLL))
    expect((await act(w.owner, aid, 'hide', { word: 'x' })).statusCode).toBe(400)
  })
})

describe('named activities', () => {
  it('the facilitator reads who answered what after the reveal only; nobody else ever does', async () => {
    w = await setupWorld()
    tab(w, w.owner) // the starter is on the board
    const aid = idOf(await start(w.owner, w.board, { ...POLL, anonymous: false }))
    expectStatus(await answer(w.viewer, aid, { kind: 'poll', choices: [0] }), 200)
    expectStatus(await answer(w.guest, aid, { kind: 'poll', choices: [2] }), 200)
    const early = await w.owner.req('GET', activityActionPath(aid, 'answers'))
    expect(early.statusCode).toBe(409)
    expect(errorCode(early)).toBe('ACTIVITY_NOT_REVEALED')
    expectStatus(await act(w.owner, aid, 'reveal'), 200)
    // a named activity keeps its answers, and the answerer still sees theirs
    expect((await state(w.viewer, w.board)).myAnswer).toEqual({ kind: 'poll', choices: [0] })
    const res = await w.owner.req('GET', activityActionPath(aid, 'answers'))
    expectStatus(res, 200)
    const named = NamedAnswersResponse.parse(res.json()).answers
    expect(named.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { userId: w.guest.userId, name: 'Gus Guest (guest)', answer: { kind: 'poll', choices: [2] } },
      { userId: w.viewer.userId, name: 'Vic Viewer', answer: { kind: 'poll', choices: [0] } },
    ])
    for (const c of [w.viewer, w.commenter])
      expect((await c.req('GET', activityActionPath(aid, 'answers'))).statusCode).toBe(403)
    expect(errorCode(await w.editor.req('GET', activityActionPath(aid, 'answers')))).toBe(
      'ACTIVITY_NOT_YOURS',
    )
    expect(errorCode(await w.guest.req('GET', activityActionPath(aid, 'answers')))).toBe(
      'GUEST_ACCOUNT_REQUIRED',
    )
    expect((await w.outsider.req('GET', activityActionPath(aid, 'answers'))).statusCode).toBe(404)
  })

  it('an anonymous activity has no named answers (404), before or after the reveal', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, POLL))
    expectStatus(await answer(w.viewer, aid, { kind: 'poll', choices: [0] }), 200)
    expect((await w.owner.req('GET', activityActionPath(aid, 'answers'))).statusCode).toBe(404)
    expectStatus(await act(w.owner, aid, 'reveal'), 200)
    expect((await w.owner.req('GET', activityActionPath(aid, 'answers'))).statusCode).toBe(404)
  })

  it('a named activity whose results are not live counts in 1 s windows', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, { ...POLL, anonymous: false }))
    w.clock.advance(1_000 - (w.clock.now().getTime() % 1_000) + 100)
    expectStatus(await answer(w.viewer, aid, { kind: 'poll', choices: [0] }), 200)
    expect((await state(w.owner, w.board)).answered).toBe(0)
    w.clock.advance(1_000)
    expect((await state(w.owner, w.board)).answered).toBe(1)
  })
})

describe('who manages', () => {
  it('the starter, a board owner, or any account editor once the starter left (ACTIVITY_NOT_YOURS before)', async () => {
    w = await setupWorld()
    // the starter keeps a tab of the board open (with none, they left: below)
    tab(w, w.editor)
    const aid = idOf(await start(w.editor, w.board, POLL))
    const s = await state(w.editor2, w.board)
    expect(s).toMatchObject({ canManage: false, starterLeft: false, results: null })
    const refused = await act(w.editor2, aid, 'close')
    expect(refused.statusCode).toBe(403)
    expect(errorCode(refused)).toBe('ACTIVITY_NOT_YOURS')
    // the board owner may
    expect((await state(w.owner, w.board)).canManage).toBe(true)
    // the starter is lowered to viewer: they left; any account editor may now, the guest editor never
    expectStatus(
      await w.owner.req('PUT', `/api/boards/${w.board}/members/${w.editor.userId}`, { role: 'viewer' }),
      200,
    )
    expect(await state(w.editor2, w.board)).toMatchObject({ canManage: true, starterLeft: true })
    expect(await state(w.guest, w.board)).toMatchObject({ canManage: false })
    expect(errorCode(await act(w.guest, aid, 'close'))).toBe('GUEST_ACCOUNT_REQUIRED')
    expect((await act(w.editor, aid, 'close')).statusCode).toBe(403)
    expectStatus(await act(w.editor2, aid, 'close'), 200)
  })

  it('a starter who closed every tab of the board counts as left: any account editor may close or cancel; back on the board, theirs again (review m6)', async () => {
    w = await setupWorld()
    const close = tab(w, w.editor)
    const aid = idOf(await start(w.editor, w.board, { ...POLL, durationMs: null }))
    expect(errorCode(await act(w.editor2, aid, 'close'))).toBe('ACTIVITY_NOT_YOURS')
    // a tab of another board does not count
    const elsewhere = tab(w, w.editor, 'b-elsewhere00')
    close()
    expect(await state(w.editor2, w.board)).toMatchObject({ canManage: true, starterLeft: true })
    const back = tab(w, w.editor)
    expect(await state(w.editor2, w.board)).toMatchObject({ canManage: false, starterLeft: false })
    back()
    elsewhere()
    // a viewer, a commenter and a name-only guest still never manage
    for (const c of [w.viewer, w.commenter]) expect((await act(c, aid, 'close')).statusCode).toBe(403)
    expect(errorCode(await act(w.guest, aid, 'close'))).toBe('GUEST_ACCOUNT_REQUIRED')
    expectStatus(await act(w.editor2, aid, 'close'), 200)
    // a new one is not blocked: and its starter left too, so the other editor cancels it
    const next = idOf(await start(w.editor, w.board, POLL))
    expectStatus(await act(w.editor2, next, 'cancel'), 200)
    // the board owner keeps the right whatever the starter does
    const third = idOf(await start(w.editor, w.board, POLL))
    tab(w, w.editor)
    expectStatus(await act(w.owner, third, 'close'), 200)
  })

  it('a starter whose account is gone counts as left', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.editor, w.board, POLL))
    await w.api.db.query('UPDATE live_activities SET created_by = NULL WHERE id = $1', [aid])
    expect(await state(w.editor2, w.board)).toMatchObject({
      canManage: true,
      starterLeft: true,
      activity: { createdBy: null },
    })
  })
})

describe('the past list and the open-state part', () => {
  it('lists the newest first with aggregates; results only once revealed (cancelled ones listed without)', async () => {
    w = await setupWorld()
    const a = idOf(await start(w.owner, w.board, POLL))
    expectStatus(await answer(w.viewer, a, { kind: 'poll', choices: [1] }), 200)
    expectStatus(await act(w.owner, a, 'reveal'), 200)
    w.clock.advance(10)
    const b = idOf(await start(w.owner, w.board, SCALE))
    expectStatus(await answer(w.viewer, b, { kind: 'scale', value: 2 }), 200)
    expectStatus(await act(w.owner, b, 'cancel'), 200)
    w.clock.advance(10)
    const c = idOf(await start(w.owner, w.board, { ...WORDS, anonymous: false }))
    expectStatus(await answer(w.viewer, c, { kind: 'words', words: ['hi'] }), 200)
    const res = await w.viewer.req('GET', activitiesPath(w.board))
    expectStatus(res, 200)
    const list = ListActivitiesResponse.parse(res.json()).activities
    expect(list.map((x) => [x.activity.id, x.activity.status, x.answered, x.results?.kind ?? null])).toEqual([
      [c, 'open', 0, null], // windowed: the answer waits for its window
      [b, 'cancelled', 0, null],
      [a, 'revealed', 1, 'poll'],
    ])
  })

  it('the open-state part is what GET …/activity answers the same caller', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, WORDS))
    expectStatus(await answer(w.viewer, aid, { kind: 'words', words: ['one'] }), 200)
    for (const c of [w.owner, w.viewer, w.guest]) {
      const own = await state(c, w.board)
      const res = await c.req('GET', openStatePath(w.board))
      expectStatus(res, 200)
      const body = OpenStateBody.parse(res.json()) as { activity?: unknown }
      // answered since the integration moved 'activity' into OPEN_STATE_PARTS
      expect(body.activity).toEqual(own)
    }
  })
})

describe('limits', () => {
  it('30 answers a person a minute per activity (429), 10 starts a board a minute', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, POLL))
    for (let i = 0; i < 30; i++)
      expectStatus(await answer(w.viewer, aid, { kind: 'poll', choices: [i % 3] }), 200)
    const over = await answer(w.viewer, aid, { kind: 'poll', choices: [0] })
    expect(over.statusCode).toBe(429)
    expect(over.headers['retry-after']).toBeDefined()
    // someone else is not held back
    expectStatus(await answer(w.commenter, aid, { kind: 'poll', choices: [0] }), 200)
    w.clock.advance(60_000)
    expectStatus(await answer(w.viewer, aid, { kind: 'poll', choices: [0] }), 200)

    await act(w.owner, aid, 'cancel')
    // the first start was a minute ago: ten more fit, the eleventh does not
    for (let started = 0; started < 10; started++) {
      const id = idOf(await start(w.owner, w.board, POLL))
      expectStatus(await act(w.owner, id, 'cancel'), 200)
    }
    const res = await w.owner.req('POST', activitiesPath(w.board), POLL)
    expect(res.statusCode).toBe(429)
  })

  it('a prompt and options follow the text rules (one line, code points, no controls)', async () => {
    w = await setupWorld()
    for (const bad of [
      { ...POLL, prompt: '   ' },
      { ...POLL, prompt: 'x'.repeat(201) },
      { ...POLL, prompt: 'bidi ‮ trick' },
      { ...POLL, config: { options: ['Same', 'same'] } },
      { ...POLL, config: { options: ['Only one'] } },
      { ...SCALE, config: { min: 1, max: 10 } },
      { ...POLL, status: 'revealed' },
    ]) {
      const res = await w.owner.req('POST', activitiesPath(w.board), bad)
      expect(res.statusCode, JSON.stringify(bad)).toBe(400)
    }
    const s = await start(w.owner, w.board, { ...POLL, prompt: '  Two\n lines\tone  ' })
    expect(s.activity?.prompt).toBe('Two lines one')
  })
})
