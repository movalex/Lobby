// OWNER: WS1 (wave V). The tally window through the api (docs/WAVE-V-CONTRACTS.md §2.2 rule 2, §2.4; lead decision
// d): an answer publishes nothing by itself, no read (the state, the past list, the results, the answer response
// itself) shows another person's answer before its window is over, one event per window that changed something, and
// close, reveal and cancel publish at once. The frozen app clock starts 100 ms into a 5 s window.

import {
  type ActivityState,
  activitiesPath,
  activityActionPath,
  ListActivitiesResponse,
  WorkshopActivityEvent,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  act,
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

const W = 5_000
const activityEvents = () =>
  w.events.filter((e) => e.type === 'workshop.activity').map((e) => WorkshopActivityEvent.parse(e.data))

describe('counts through the api', () => {
  it('answers publish nothing; every read inside the window answers the same; one event at the window end', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, { ...POLL, resultsLive: true }))
    expect(activityEvents()).toHaveLength(1) // the start
    const seen = new Set<string>()
    const look = async () => {
      const s = await state(w.commenter, w.board)
      const list = ListActivitiesResponse.parse(
        (await w.commenter.req('GET', activitiesPath(w.board))).json(),
      )
      const res = await w.commenter.req('GET', activityActionPath(aid, 'results'))
      seen.add(JSON.stringify([s.answered, s.results, list.activities[0]?.answered, res.json()]))
    }
    for (const [i, c] of [w.viewer, w.guest, w.editor, w.reviewGuest].entries()) {
      w.clock.advance(400)
      const r = await answer(c, aid, { kind: 'poll', choices: [i % 2] })
      expectStatus(r, 200)
      // the answerer's own response shows the old count too
      expect((r.json() as ActivityState).answered).toBe(0)
      await look()
    }
    expect(seen.size).toBe(1)
    expect(activityEvents()).toHaveLength(1)
    w.clock.advance(W)
    await look()
    expect(seen.size).toBe(2)
    const events = activityEvents()
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ answered: 4, results: { kind: 'poll', counts: [2, 2, 0] } })
    // reads in the next window (nothing changed) send nothing more
    w.clock.advance(W)
    await look()
    expect(activityEvents()).toHaveLength(2)
  })

  it('at most one event per window per activity, however many answers', async () => {
    w = await setupWorld()
    // the app-clock time of every activity event (the hub stamps its own wall clock)
    const at: number[] = []
    w.hub.subscribe(w.board, (e) => {
      if (e.type === 'workshop.activity') at.push(w.clock.now().getTime())
    })
    const aid = idOf(await start(w.owner, w.board, WORDS))
    const people = [w.viewer, w.commenter, w.guest, w.reviewGuest, w.client, w.editor, w.editor2]
    const windows = 4
    for (let k = 0; k < windows; k++) {
      for (const [i, c] of people.entries()) {
        w.clock.advance(300)
        expectStatus(await answer(c, aid, { kind: 'words', words: [`k${k}`, `p${i}`] }), 200)
        await state(w.owner, w.board)
      }
      // just past the next boundary
      w.clock.advance(W - (w.clock.now().getTime() % W) + 10)
    }
    await state(w.owner, w.board)
    // the start, then one event per window of answers (sent when the window ended), never two in one window
    expect(at).toHaveLength(1 + windows)
    const windowsOf = at.slice(1).map((t) => Math.floor(t / W))
    expect(new Set(windowsOf).size).toBe(windows)
    // participants were never sent words (not live)
    expect(activityEvents().every((e) => e.results === null)).toBe(true)
  })

  it('close, reveal and cancel publish at once with the final counts', async () => {
    w = await setupWorld()
    const aid = idOf(await start(w.owner, w.board, POLL))
    expectStatus(await answer(w.viewer, aid, { kind: 'poll', choices: [1] }), 200)
    expectStatus(await act(w.owner, aid, 'close'), 200)
    expect(activityEvents().at(-1)).toMatchObject({
      activity: { status: 'closed' },
      answered: 1,
      results: null,
    })
    expect((await state(w.commenter, w.board)).answered).toBe(1)
    expectStatus(await act(w.owner, aid, 'reveal'), 200)
    expect(activityEvents().at(-1)).toMatchObject({
      activity: { status: 'revealed' },
      answered: 1,
      results: { counts: [0, 1, 0] },
    })
    // no late window event after the final one
    const n = w.events.length
    w.clock.advance(3 * W)
    await state(w.commenter, w.board)
    expect(w.events.length).toBe(n)
    const second = idOf(await start(w.owner, w.board, POLL))
    expectStatus(await answer(w.viewer, second, { kind: 'poll', choices: [0] }), 200)
    expectStatus(await act(w.owner, second, 'cancel'), 200)
    expect(activityEvents().at(-1)).toMatchObject({
      activity: { id: second, status: 'cancelled' },
      results: null,
    })
  })
})
