// Wave V fix wave (review m2): an ANONYMOUS activity keeps no answer row once it stops taking answers, whichever way it
// stops: closed, its end time passing (the first read after it, or the sweep for a board nobody reads), superseded by
// a new start, cancelled, revealed, or its board archived or trashed. Its aggregate is frozen at that moment and the
// reveal shows the frozen aggregate. A NAMED activity keeps its answers (the facilitator reads them after the reveal).

import {
  type ActivityResults,
  ActivityState,
  activityActionPath,
  ListActivitiesResponse,
  NamedAnswersResponse,
  type StartActivityInput,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepActivities } from '../../../src/features/live-activities/sweep.ts'
import {
  act,
  activityEvents,
  answer,
  expectStatus,
  idOf,
  POLL,
  setupWorld,
  start,
  state,
  WORDS,
  type World,
} from './support.ts'

let w: World
afterEach(async () => {
  await w?.close()
})

const TIMED: StartActivityInput = { ...POLL, durationMs: 60_000 }

const rowsOf = async (aid: string) =>
  (
    await w.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM live_answers WHERE activity_id = $1', [
      aid,
    ])
  ).n

const stored = (aid: string) =>
  w.api.db.one<{ status: string; results: ActivityResults | null; closed_at: Date | null }>(
    'SELECT status, results, closed_at FROM live_activities WHERE id = $1',
    [aid],
  )

/** Anonymous answers of any activity that is not open: the invariant is that there are none. */
const strayAnswers = async () =>
  (
    await w.api.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM live_answers x JOIN live_activities a ON a.id = x.activity_id
        WHERE a.anonymous AND a.status <> 'open'`,
    )
  ).n

/** A timed anonymous poll with two answers (Beta, Gamma). */
async function answeredPoll(input: StartActivityInput = TIMED): Promise<string> {
  const aid = idOf(await start(w.owner, w.board, input))
  expectStatus(await answer(w.viewer, aid, { kind: 'poll', choices: [1] }), 200)
  expectStatus(await answer(w.commenter, aid, { kind: 'poll', choices: [2] }), 200)
  expect(await rowsOf(aid)).toBe(2)
  return aid
}

const FROZEN = { kind: 'poll', answered: 2, counts: [0, 1, 1] }

describe('an anonymous activity keeps no answer once it stops taking answers', () => {
  it('close: the aggregate is frozen and the answers deleted at once; the reveal shows the frozen aggregate', async () => {
    w = await setupWorld()
    const aid = await answeredPoll(POLL)
    const closed = ActivityState.parse((await act(w.owner, aid, 'close')).json())
    expect(closed).toMatchObject({ activity: { status: 'closed' }, answered: 2, results: FROZEN })
    expect(await rowsOf(aid)).toBe(0)
    expect(await stored(aid)).toMatchObject({ status: 'closed', results: FROZEN })
    // a participant sees the count, not the results, and no longer their own answer
    expect(await state(w.viewer, w.board)).toMatchObject({ answered: 2, results: null, myAnswer: null })
    expect(activityEvents(w).at(-1)?.data).toMatchObject({ activity: { status: 'closed' }, answered: 2 })
    const revealed = ActivityState.parse((await act(w.owner, aid, 'reveal')).json())
    expect(revealed).toMatchObject({ activity: { status: 'revealed' }, answered: 2, results: FROZEN })
    expect((await w.viewer.req('GET', activityActionPath(aid, 'results'))).json()).toMatchObject({
      results: FROZEN,
    })
    const listed = ListActivitiesResponse.parse(
      (await w.viewer.req('GET', `/api/boards/${w.board}/activities`)).json(),
    )
    expect(listed.activities[0]).toMatchObject({ answered: 2, results: FROZEN })
  })

  it('close of a word cloud: a word hidden after the close still leaves the frozen results and the reveal', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, WORDS))
    expectStatus(await answer(w.viewer, aid, { kind: 'words', words: ['agile', 'lean'] }), 200)
    expectStatus(await answer(w.commenter, aid, { kind: 'words', words: ['agile'] }), 200)
    expectStatus(await act(w.owner, aid, 'close'), 200)
    expect(await rowsOf(aid)).toBe(0)
    expectStatus(await act(w.owner, aid, 'hide', { word: 'lean', hidden: true }), 200)
    const revealed = ActivityState.parse((await act(w.owner, aid, 'reveal')).json())
    expect(revealed.results).toMatchObject({
      kind: 'words',
      answered: 2,
      words: [{ text: 'agile', count: 2 }],
      hidden: 1,
    })
  })

  it('its end time passing: the first read after it settles it', async () => {
    w = await setupWorld()
    const aid = await answeredPoll()
    w.clock.advance(61_000)
    const seen = await state(w.viewer, w.board)
    expect(seen).toMatchObject({ activity: { id: aid, status: 'closed' }, answered: 2, myAnswer: null })
    expect(await rowsOf(aid)).toBe(0)
    const row = await stored(aid)
    expect(row).toMatchObject({ status: 'closed', results: FROZEN })
    // closed at its end time, not at the read
    expect(row.closed_at?.getTime()).toBe(new Date(seen.activity?.endsAt ?? 0).getTime())
    expect((await act(w.owner, aid, 'reveal')).json()).toMatchObject({ results: FROZEN })
  })

  it('its end time passing on a board nobody reads: the sweep settles it', async () => {
    w = await setupWorld()
    const aid = await answeredPoll()
    expect(await sweepActivities({ db: w.api.db, now: w.clock.now })).toEqual([])
    w.clock.advance(61_000)
    expect(await sweepActivities({ db: w.api.db, now: w.clock.now })).toEqual([aid])
    expect(await rowsOf(aid)).toBe(0)
    expect(await stored(aid)).toMatchObject({ status: 'closed', results: FROZEN })
    // a second pass has nothing to do
    expect(await sweepActivities({ db: w.api.db, now: w.clock.now })).toEqual([])
    expect((await act(w.owner, aid, 'reveal')).json()).toMatchObject({ results: FROZEN })
  })

  it('superseded: a new start settles the one that ended by its time', async () => {
    w = await setupWorld()
    const aid = await answeredPoll()
    w.clock.advance(61_000)
    const next = idOf(await start(w.editor, w.board, POLL))
    expect(next).not.toBe(aid)
    expect(await rowsOf(aid)).toBe(0)
    expect(await stored(aid)).toMatchObject({ status: 'closed', results: FROZEN })
  })

  it('cancel: the answers go and no aggregate is kept, also for one that was closed first', async () => {
    w = await setupWorld()
    const open = await answeredPoll(POLL)
    expectStatus(await act(w.owner, open, 'cancel'), 200)
    expect(await rowsOf(open)).toBe(0)
    expect(await stored(open)).toMatchObject({ status: 'cancelled', results: null })
    const closed = await answeredPoll(POLL)
    expectStatus(await act(w.owner, closed, 'close'), 200)
    expectStatus(await act(w.owner, closed, 'cancel'), 200)
    expect(await stored(closed)).toMatchObject({ status: 'cancelled', results: null })
  })

  it('reveal straight from open: the answers go with the reveal', async () => {
    w = await setupWorld()
    const aid = await answeredPoll(POLL)
    expect((await act(w.owner, aid, 'reveal')).json()).toMatchObject({ results: FROZEN })
    expect(await rowsOf(aid)).toBe(0)
  })

  for (const action of ['archive', 'trash'] as const)
    it(`its board ${action === 'archive' ? 'archived' : 'trashed'}: the open activity is closed and settled in the same transaction`, async () => {
      w = await setupWorld()
      const aid = await answeredPoll(POLL)
      expectStatus(await w.owner.req('POST', `/api/boards/${w.board}/${action}`), 200)
      expect(await rowsOf(aid)).toBe(0)
      expect(await stored(aid)).toMatchObject({ status: 'closed', results: FROZEN })
      if (action === 'archive')
        // an archived board's readers still see it, closed, with its count
        expect(await state(w.viewer, w.board)).toMatchObject({
          activity: { id: aid, status: 'closed' },
          answered: 2,
        })
      expectStatus(await w.owner.req('POST', `/api/boards/${w.board}/restore`), 200)
      expect(await stored(aid)).toMatchObject({ status: 'closed', results: FROZEN })
    })

  it('the invariant: after every path, no answer row of an anonymous activity that is not open remains; a named one keeps its answers', async () => {
    w = await setupWorld()
    const closed = await answeredPoll(POLL)
    expectStatus(await act(w.owner, closed, 'close'), 200)
    const revealed = await answeredPoll(POLL)
    expectStatus(await act(w.owner, revealed, 'reveal'), 200)
    const cancelled = await answeredPoll(POLL)
    expectStatus(await act(w.owner, cancelled, 'cancel'), 200)
    const timed = await answeredPoll()
    w.clock.advance(61_000)
    await sweepActivities({ db: w.api.db, now: w.clock.now })
    const superseded = await answeredPoll()
    w.clock.advance(61_000)
    const named = await answeredPoll({ ...POLL, anonymous: false })
    expect(await rowsOf(superseded)).toBe(0)
    expectStatus(await act(w.owner, named, 'close'), 200)
    const archived = await answeredPoll(POLL)
    expectStatus(await w.owner.req('POST', `/api/boards/${w.board}/archive`), 200)
    expect(await strayAnswers()).toBe(0)
    for (const aid of [closed, revealed, cancelled, timed, superseded, archived])
      expect(await rowsOf(aid)).toBe(0)
    // the named one keeps who answered what, for its facilitator after the reveal
    expect(await rowsOf(named)).toBe(2)
    expectStatus(await w.owner.req('POST', `/api/boards/${w.board}/restore`), 200)
    expectStatus(await act(w.owner, named, 'reveal'), 200)
    expect(
      NamedAnswersResponse.parse((await w.owner.req('GET', activityActionPath(named, 'answers'))).json())
        .answers,
    ).toHaveLength(2)
  })
})
