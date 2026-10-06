import type { VoteResult, VoteSessionSummary, WorkshopState, WorkshopVoteState } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { VOTE_TALLY_WINDOW_MS } from '../../../src/features/workshops/vote-tally.ts'
import type { Client } from '../../helpers.ts'
import { expectStatus, json, note, setupWorld, type World } from './support.ts'

let w: World
afterEach(async () => {
  await w?.api.close()
})

const PAGE = 'page:page'
const MIN = 60_000

async function startVote(c: Client, body: Record<string, unknown> = {}): Promise<WorkshopVoteState> {
  const res = await c.req('POST', `/api/boards/${w.boardId}/votes`, {
    title: 'Best idea',
    votesPerPerson: 5,
    onePerObject: false,
    scope: 'board',
    ...body,
  })
  expectStatus(res, 201)
  return json<WorkshopVoteState>(res)
}
const cast = (c: Client, vid: string, shapeId: string, delta: 1 | -1 = 1) =>
  c.req('POST', `/api/votes/${vid}/cast`, { shapeId, delta })
const state = async (c: Client) => {
  const res = await c.req('GET', `/api/boards/${w.boardId}/workshop`)
  expectStatus(res, 200)
  return json<WorkshopState>(res)
}

async function world(shapes = 10) {
  w = await setupWorld()
  w.sync.add(w.boardId, ...Array.from({ length: shapes }, (_, i) => note(`n${i}`)))
  return w
}

describe('setting up a vote', () => {
  it('only editors and owners can start one; one open vote per board; inputs are validated', async () => {
    await world()
    const body = { votesPerPerson: 3, onePerObject: false, scope: 'board' }
    expectStatus(await w.viewer.req('POST', `/api/boards/${w.boardId}/votes`, body), 403)
    expectStatus(await w.commenter.req('POST', `/api/boards/${w.boardId}/votes`, body), 403)
    expectStatus(await w.outsider.req('POST', `/api/boards/${w.boardId}/votes`, body), 404)
    for (const bad of [
      { ...body, votesPerPerson: 0 },
      { ...body, votesPerPerson: 100 },
      { ...body, scope: 'frame' }, // no frameId
      { ...body, frameId: 'shape:f1' }, // frameId on a board vote
      { ...body, durationMs: 1000 },
    ])
      expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/votes`, bad), 400)
    expect(w.sync.snapshots).toBe(0) // refused requests never touch the canvas

    const v = await startVote(w.editor, { votesPerPerson: 3 })
    expect(v.session).toMatchObject({
      status: 'open',
      votesPerPerson: 3,
      title: 'Best idea',
      createdBy: w.editor.userId,
    })
    expect(v).toMatchObject({ myRemaining: 3, myVotes: {}, results: null, totalVotesCast: 0 })
    const again = await w.owner.req('POST', `/api/boards/${w.boardId}/votes`, body)
    expectStatus(again, 409)
    expect(json<{ error: { code: string } }>(again).error.code).toBe('VOTE_ALREADY_OPEN')
    // everyone who can view sees it (late joiners included)
    expect((await state(w.viewer)).vote?.session.id).toBe(v.session.id)
  })

  it('two facilitators starting at once get exactly one vote', async () => {
    await world()
    const body = { votesPerPerson: 3, onePerObject: false, scope: 'board' }
    const res = await Promise.all([
      w.owner.req('POST', `/api/boards/${w.boardId}/votes`, body),
      w.editor.req('POST', `/api/boards/${w.boardId}/votes`, body),
      w.owner.req('POST', `/api/boards/${w.boardId}/votes`, body),
    ])
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409, 409])
    const n = await w.api.db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM vote_sessions WHERE board_id = $1',
      [w.boardId],
    )
    expect(n.n).toBe(1)
  })

  it('a frame vote needs a real frame', async () => {
    await world()
    w.sync.add(w.boardId, { id: 'shape:frame1', type: 'frame', parentId: PAGE })
    const bad = await w.owner.req('POST', `/api/boards/${w.boardId}/votes`, {
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'frame',
      frameId: 'shape:n1', // a note, not a frame
    })
    expectStatus(bad, 400)
    const v = await startVote(w.owner, { scope: 'frame', frameId: 'shape:frame1' })
    expect(v.session).toMatchObject({ scope: 'frame', frameId: 'shape:frame1' })
  })
})

describe('casting', () => {
  it('enforces the budget: the 6th vote of 5 is refused, removal gives it back', async () => {
    await world()
    const v = await startVote(w.owner)
    const vid = v.session.id
    for (let i = 0; i < 5; i++) {
      const r = await cast(w.viewer, vid, `shape:n${i % 2}`)
      expectStatus(r, 200)
      expect(json<WorkshopVoteState>(r).myRemaining).toBe(4 - i)
    }
    const over = await cast(w.viewer, vid, 'shape:n3')
    expectStatus(over, 409)
    expect(json<{ error: { code: string } }>(over).error.code).toBe('NO_VOTES_LEFT')
    const s = (await state(w.viewer)).vote
    expect(s?.myVotes).toEqual({ 'shape:n0': 3, 'shape:n1': 2 })
    const back = await cast(w.viewer, vid, 'shape:n0', -1)
    expectStatus(back, 200)
    expect(json<WorkshopVoteState>(back)).toMatchObject({
      myRemaining: 1,
      myVotes: { 'shape:n0': 2, 'shape:n1': 2 },
    })
    expectStatus(await cast(w.viewer, vid, 'shape:n3'), 200)
    // you can only take back your own dots
    const none = await cast(w.viewer, vid, 'shape:n5', -1)
    expectStatus(none, 409)
    expect(json<{ error: { code: string } }>(none).error.code).toBe('NO_VOTE_TO_REMOVE')
  })

  it('20 parallel casts against a budget of 5: exactly 5 land', async () => {
    await world(20)
    const v = await startVote(w.owner, { votesPerPerson: 5 })
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => cast(w.commenter, v.session.id, `shape:n${i}`)),
    )
    const codes = results.map((r) => r.statusCode)
    expect(codes.filter((c) => c === 200)).toHaveLength(5)
    expect(codes.filter((c) => c === 409)).toHaveLength(15)
    const row = await w.api.db.one<{ n: number }>(
      'SELECT coalesce(sum(count), 0)::int AS n FROM votes WHERE session_id = $1 AND user_id = $2',
      [v.session.id, w.commenter.userId],
    )
    expect(row.n).toBe(5)
    // RT-03: the counts move once the counting window is over (the caller's own ballot at once)
    expect((await state(w.commenter)).vote).toMatchObject({ myRemaining: 0, totalVotesCast: 0 })
    w.clock.advance(VOTE_TALLY_WINDOW_MS)
    expect((await state(w.commenter)).vote).toMatchObject({ myRemaining: 0, totalVotesCast: 5 })
    // the same burst on ONE object with one-per-object: exactly one lands
  })

  it('20 parallel casts on one object with one vote per object: exactly 1 lands', async () => {
    await world()
    const v = await startVote(w.owner, { votesPerPerson: 5, onePerObject: true })
    const results = await Promise.all(
      Array.from({ length: 20 }, () => cast(w.viewer, v.session.id, 'shape:n1')),
    )
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1)
    expect(
      results.filter((r) => json<{ error?: { code: string } }>(r).error?.code === 'ONE_PER_OBJECT'),
    ).toHaveLength(19)
    expect((await state(w.viewer)).vote?.myVotes).toEqual({ 'shape:n1': 1 })
    // a different object still works
    expectStatus(await cast(w.viewer, v.session.id, 'shape:n2'), 200)
  })

  it('refuses objects outside the scope, of the wrong type, connectors, and unknown shapes', async () => {
    await world()
    w.sync.add(
      w.boardId,
      { id: 'shape:frame1', type: 'frame', parentId: PAGE },
      { id: 'shape:inside', type: 'note', parentId: 'shape:frame1' },
      { id: 'shape:group1', type: 'group', parentId: 'shape:frame1' },
      { id: 'shape:deep', type: 'geo', parentId: 'shape:group1' },
      { id: 'shape:arrow1', type: 'arrow', parentId: 'shape:frame1' },
      { id: 'shape:outside', type: 'note', parentId: PAGE },
    )
    const v = await startVote(w.owner, { scope: 'frame', frameId: 'shape:frame1' })
    const vid = v.session.id
    expectStatus(await cast(w.viewer, vid, 'shape:inside'), 200)
    expectStatus(await cast(w.viewer, vid, 'shape:deep'), 200) // nested in a group inside the frame
    for (const bad of ['shape:outside', 'shape:frame1', 'shape:arrow1', 'shape:group1', 'shape:ghost']) {
      const r = await cast(w.viewer, vid, bad)
      expectStatus(r, 400)
      expect(json<{ error: { code: string } }>(r).error.code).toBe('NOT_ELIGIBLE')
    }
    expectStatus(await cast(w.viewer, vid, 'not-a-shape-id'), 400)
    expectStatus(await w.owner.req('POST', `/api/votes/${vid}/close`), 200)

    const notes = await startVote(w.owner, { shapeTypes: ['note'] })
    expectStatus(await cast(w.viewer, notes.session.id, 'shape:outside'), 200)
    expectStatus(await cast(w.viewer, notes.session.id, 'shape:deep'), 400) // a geo shape
  })

  it('a shape created a moment ago can be voted on (stale snapshot cache is re-checked)', async () => {
    await world(2)
    const v = await startVote(w.owner)
    expectStatus(await cast(w.viewer, v.session.id, 'shape:n0'), 200)
    w.sync.add(w.boardId, note('fresh'))
    w.clock.advance(300) // past the re-check threshold, still inside the cache ttl
    expectStatus(await cast(w.viewer, v.session.id, 'shape:fresh'), 200)
  })

  it('fails closed when the canvas cannot be read', async () => {
    await world()
    const v = await startVote(w.owner)
    w.sync.down = true
    w.clock.advance(5_000) // expire the cache
    const r = await cast(w.viewer, v.session.id, 'shape:n0')
    expectStatus(r, 503)
    expect((await state(w.viewer)).vote?.totalVotesCast).toBe(0)
  })

  it('viewers and commenters vote and say they are done; counts are aggregates', async () => {
    await world()
    const v = await startVote(w.owner, { votesPerPerson: 2 })
    const vid = v.session.id
    expectStatus(await cast(w.viewer, vid, 'shape:n1'), 200)
    expectStatus(await cast(w.commenter, vid, 'shape:n2'), 200)
    const done = await w.viewer.req('POST', `/api/votes/${vid}/done`)
    expectStatus(done, 200)
    // RT-03: the caller's own "done" at once; everyone's counts once the counting window is over
    expect(json<WorkshopVoteState>(done)).toMatchObject({ done: true, participantsDone: 0, participants: 0 })
    expectStatus(await w.viewer.req('POST', `/api/votes/${vid}/done`, {}), 200) // idempotent
    w.clock.advance(VOTE_TALLY_WINDOW_MS)
    const f = (await state(w.owner)).vote
    expect(f).toMatchObject({ participantsDone: 1, participants: 2, totalVotesCast: 2, done: false })
    const undone = await w.viewer.req('POST', `/api/votes/${vid}/done`, { done: false })
    expect(json<WorkshopVoteState>(undone)).toMatchObject({ done: false, participantsDone: 1 })
    w.clock.advance(VOTE_TALLY_WINDOW_MS)
    expect((await state(w.owner)).vote).toMatchObject({ participantsDone: 0, participants: 2 })
    // outsiders cannot even see that the vote exists
    expectStatus(await cast(w.outsider, vid, 'shape:n1'), 404)
    expectStatus(await w.outsider.req('POST', `/api/votes/${vid}/done`), 404)
    expectStatus(await w.api.anon('POST', `/api/votes/${vid}/cast`, { shapeId: 'shape:n1', delta: 1 }), 401)
    expectStatus(
      await w.viewer.req('POST', '/api/votes/vot_doesnotexist0000000/cast', {
        shapeId: 'shape:n1',
        delta: 1,
      }),
      404,
    )
  })

  it('casting after close, after reveal, or after the end time fails', async () => {
    await world()
    let v = await startVote(w.owner)
    expectStatus(await cast(w.viewer, v.session.id, 'shape:n1'), 200)
    expectStatus(await w.owner.req('POST', `/api/votes/${v.session.id}/close`), 200)
    for (const d of [1, -1] as const) {
      const r = await cast(w.viewer, v.session.id, 'shape:n1', d)
      expectStatus(r, 409)
      expect(json<{ error: { code: string } }>(r).error.code).toBe('VOTE_CLOSED')
    }
    expectStatus(await w.viewer.req('POST', `/api/votes/${v.session.id}/done`), 409)
    expectStatus(await w.owner.req('POST', `/api/votes/${v.session.id}/reveal`), 200)
    expectStatus(await cast(w.viewer, v.session.id, 'shape:n2'), 409)

    v = await startVote(w.owner, { durationMs: 2 * MIN })
    expect(v.session.endsAt).not.toBeNull()
    expectStatus(await cast(w.viewer, v.session.id, 'shape:n1'), 200)
    w.clock.advance(2 * MIN)
    expectStatus(await cast(w.viewer, v.session.id, 'shape:n2'), 409)
    expect((await state(w.viewer)).vote?.session.status).toBe('closed')
    // a new vote can start once the timed one ran out
    await startVote(w.owner)
  })

  it('facilitators can extend a timed vote; others cannot', async () => {
    await world()
    const v = await startVote(w.owner, { durationMs: MIN })
    expectStatus(await w.viewer.req('POST', `/api/votes/${v.session.id}/extend`, { addMs: MIN }), 403)
    w.clock.advance(50_000)
    const ext = await w.editor.req('POST', `/api/votes/${v.session.id}/extend`, { addMs: MIN })
    expectStatus(ext, 200)
    const endsAt = Date.parse(json<WorkshopVoteState>(ext).session.endsAt ?? '')
    expect(endsAt - w.clock.now().getTime()).toBe(70_000)
    w.clock.advance(65_000)
    expectStatus(await cast(w.viewer, v.session.id, 'shape:n1'), 200)
  })

  it('an archived board takes no ballots', async () => {
    await world()
    const v = await startVote(w.owner)
    expectStatus(await w.owner.req('POST', `/api/boards/${w.boardId}/archive`), 200)
    expectStatus(await cast(w.viewer, v.session.id, 'shape:n1'), 403)
  })
})

describe('privacy and results', () => {
  it('no route or event exposes another person’s ballot before reveal; results are correct after', async () => {
    await world()
    const owner = w.track(w.owner)
    const viewer = w.track(w.viewer)
    const commenter = w.track(w.commenter)
    const editor = w.track(w.editor)
    const v = await startVote(owner, { votesPerPerson: 3 })
    const vid = v.session.id
    // Each person votes on objects nobody else touches, except n9 which two people share.
    const ballots: [Client, string[]][] = [
      [viewer, ['shape:n1', 'shape:n1', 'shape:n9']],
      [commenter, ['shape:n2', 'shape:n9']],
      [editor, ['shape:n3']],
      [owner, ['shape:n4', 'shape:n4']],
    ]
    for (const [c, shapes] of ballots) for (const s of shapes) expectStatus(await cast(c, vid, s), 200)
    expectStatus(await viewer.req('POST', `/api/votes/${vid}/done`), 200)
    // every read route, from everyone, while the vote is open and then closed
    for (const phase of ['open', 'closed'] as const) {
      if (phase === 'closed') expectStatus(await owner.req('POST', `/api/votes/${vid}/close`), 200)
      for (const [c] of ballots) {
        await c.req('GET', `/api/boards/${w.boardId}/workshop`)
        await c.req('GET', `/api/boards/${w.boardId}/votes`)
        expectStatus(await c.req('GET', `/api/votes/${vid}/results`), 409)
      }
    }
    const voted = new Set(ballots.flatMap(([, s]) => s))
    for (const [c, mine] of ballots) {
      const bodies = w.seen.get(c.userId) ?? []
      expect(bodies.length).toBeGreaterThan(4)
      for (const shapeId of voted) {
        if (mine.includes(shapeId)) continue
        for (const body of bodies) expect(body).not.toContain(shapeId)
      }
      // nobody else's user id shows up either (the facilitator's own id is the session's createdBy)
      for (const [other] of ballots) {
        if (other.userId === c.userId || other.userId === owner.userId) continue
        for (const body of bodies) expect(body).not.toContain(other.userId)
      }
    }
    // no event before reveal carries a shape id or a voter id
    const beforeReveal = JSON.stringify(w.events)
    for (const shapeId of voted) expect(beforeReveal).not.toContain(shapeId)
    for (const [c] of ballots) if (c.userId !== owner.userId) expect(beforeReveal).not.toContain(c.userId)
    expect(w.events.every((e) => e.type === 'workshop.vote')).toBe(true)
    const lastAgg = w.events.at(-1)?.data as {
      totalVotesCast: number
      participants: number
      participantsDone: number
    }
    expect(lastAgg).toMatchObject({ totalVotesCast: 8, participants: 4, participantsDone: 1 })

    // reveal (twice: one result, one results event)
    const r1 = await owner.req('POST', `/api/votes/${vid}/reveal`)
    const r2 = await w.editor.req('POST', `/api/votes/${vid}/reveal`)
    expectStatus(r1, 200)
    expectStatus(r2, 200)
    const expected: VoteResult[] = [
      { shapeId: 'shape:n1', count: 2, rank: 1 },
      { shapeId: 'shape:n4', count: 2, rank: 1 },
      { shapeId: 'shape:n9', count: 2, rank: 1 },
      { shapeId: 'shape:n2', count: 1, rank: 4 },
      { shapeId: 'shape:n3', count: 1, rank: 4 },
    ]
    expect(json<WorkshopVoteState>(r1).results).toEqual(expected)
    expect(json<WorkshopVoteState>(r2).results).toEqual(expected)
    const resultEvents = w.events.filter((e) => e.type === 'workshop.vote.results')
    expect(resultEvents).toHaveLength(1)
    expect(resultEvents[0]?.data).toMatchObject({
      sessionId: vid,
      results: expected,
      totalVotesCast: 8,
      participants: 4,
    })
    // results carry counts only: never who voted for what
    expect(JSON.stringify(resultEvents)).not.toContain(w.viewer.userId)
    for (const c of [w.viewer, w.commenter, w.outsider]) {
      if (c === w.outsider) {
        expectStatus(await c.req('GET', `/api/votes/${vid}/results`), 404)
        continue
      }
      expect((await state(c)).vote?.results).toEqual(expected)
      const res = await c.req('GET', `/api/votes/${vid}/results`)
      expectStatus(res, 200)
      expect(json<{ results: VoteResult[] }>(res).results).toEqual(expected)
    }
    // past votes list
    const list = json<{ sessions: VoteSessionSummary[] }>(
      await w.viewer.req('GET', `/api/boards/${w.boardId}/votes`),
    )
    expect(list.sessions[0]).toMatchObject({
      id: vid,
      status: 'revealed',
      totalVotesCast: 8,
      participants: 4,
    })
  })

  it('close and reveal are idempotent and only for facilitators', async () => {
    await world()
    const v = await startVote(w.owner)
    const vid = v.session.id
    expectStatus(await cast(w.viewer, vid, 'shape:n1'), 200)
    for (const c of [w.viewer, w.commenter]) {
      expectStatus(await c.req('POST', `/api/votes/${vid}/close`), 403)
      expectStatus(await c.req('POST', `/api/votes/${vid}/reveal`), 403)
    }
    expectStatus(await w.outsider.req('POST', `/api/votes/${vid}/close`), 404)
    const before = w.events.length
    const c1 = await w.editor.req('POST', `/api/votes/${vid}/close`)
    const c2 = await w.owner.req('POST', `/api/votes/${vid}/close`)
    expect(json<WorkshopVoteState>(c1).session.status).toBe('closed')
    expect(json<WorkshopVoteState>(c2).session).toEqual(json<WorkshopVoteState>(c1).session)
    expect(w.events.length - before).toBe(1)
    expect(json<WorkshopVoteState>(c2).results).toBeNull() // closed is not revealed
    const [a, b] = await Promise.all([
      w.owner.req('POST', `/api/votes/${vid}/reveal`),
      w.editor.req('POST', `/api/votes/${vid}/reveal`),
    ])
    expect(json<WorkshopVoteState>(a).results).toEqual([{ shapeId: 'shape:n1', count: 1, rank: 1 }])
    expect(json<WorkshopVoteState>(b).results).toEqual(json<WorkshopVoteState>(a).results)
    expect(w.events.filter((e) => e.type === 'workshop.vote.results')).toHaveLength(1)
  })

  it('a new vote starts clean and the previous results stay available', async () => {
    await world()
    const first = await startVote(w.owner, { title: 'Round 1' })
    expectStatus(await cast(w.viewer, first.session.id, 'shape:n1'), 200)
    expectStatus(await w.owner.req('POST', `/api/votes/${first.session.id}/reveal`), 200)
    expect((await state(w.viewer)).vote?.session.id).toBe(first.session.id) // results stay visible
    const second = await startVote(w.owner, { title: 'Round 2' })
    const s = (await state(w.viewer)).vote
    expect(s).toMatchObject({ myVotes: {}, myRemaining: 5, totalVotesCast: 0, results: null })
    expect(s?.session.id).toBe(second.session.id)
    const res = await w.viewer.req('GET', `/api/votes/${first.session.id}/results`)
    expect(json<{ results: VoteResult[] }>(res).results).toEqual([{ shapeId: 'shape:n1', count: 1, rank: 1 }])
  })
})
