// G1 (wave G): a click the vote, as this tab knows it, does not take is decided again on the vote the server
// has open now when this tab's copy is not fresh. Found live: a name-only guest whose event stream missed the
// end of a selection vote and the start of a board vote was told "Not part of this vote: only objects in the
// selection take votes." on the board vote's notes, and no vote landed.
import { WorkshopState, type WorkshopVoteState } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { type EventSource, type RequestFn, WorkshopStore } from '../store.ts'
import { el, fakeCanvas, note } from './test-kit.ts'
import { REFUSE_CONFIRMED_MS, refusedClick } from './WorkshopOverlay.tsx'

const ISO = new Date('2026-10-05T10:00:00.000Z').toISOString()
const OLD = 'vot_selection000000001'
const NEW = 'vot_boardvote000000002'

function vote(id: string, over: Partial<WorkshopVoteState['session']> = {}): WorkshopVoteState {
  return {
    session: {
      id,
      boardId: 'b-abc1234567',
      title: 'Vote',
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
      frameId: null,
      selection: null,
      shapeTypes: null,
      status: 'open',
      createdBy: 'usr_facilitator0001',
      createdAt: ISO,
      endsAt: null,
      closedAt: null,
      revealedAt: null,
      ...over,
    },
    myVotes: {},
    myRemaining: 3,
    done: false,
    participantsDone: 0,
    participants: 0,
    totalVotesCast: 0,
    results: null,
  }
}
const selectionVote = () => vote(OLD, { scope: 'selection', selection: ['shape:went', 'shape:improve'] })

const events: EventSource = {
  on: () => () => {},
  onResync: () => () => {},
  serverOffsetMs: () => 0,
}

function setup(first: WorkshopVoteState) {
  const f = fakeCanvas([
    el('went', 'frame', { x: 0, y: 0, width: 500, height: 400, name: 'Went well' }),
    el('improve', 'frame', { x: 600, y: 0, width: 500, height: 400, name: 'To improve' }),
    ...note('w1', 'Trailer music', { x: 40, y: 80, frameId: 'went' }),
    ...note('loose', 'Standup', { x: 0, y: 600 }),
  ])
  let server: z.input<typeof WorkshopState> = { timer: null, vote: first, serverNow: ISO }
  let now = 1_000_000
  const gets: number[] = []
  const casts: { path: string; body: unknown }[] = []
  const request = (async (method: string, path: string, opts: { body?: unknown }) => {
    if (method === 'GET' && path.endsWith('/workshop')) {
      gets.push(now)
      return WorkshopState.parse(server)
    }
    if (method === 'POST' && path.endsWith('/cast')) {
      casts.push({ path, body: opts.body })
      const v = WorkshopState.parse(server).vote as WorkshopVoteState
      return { ...v, myVotes: { 'shape:loose': 1 }, myRemaining: 2 }
    }
    throw new Error(`unexpected ${method} ${path}`)
  }) as unknown as RequestFn
  const store = new WorkshopStore({
    boardId: 'b-abc1234567',
    userId: 'usr_guest000000001',
    request,
    events,
    storage: null,
    nowMs: () => now,
  })
  const notices: string[] = []
  const ctx = {
    canvas: f.canvas,
    notify: (n: { text: string }) => notices.push(n.text),
  } as unknown as CanvasFeatureContext
  return {
    store,
    ctx,
    gets,
    casts,
    notices,
    setServer: (v: WorkshopVoteState | null) => {
      server = { timer: null, vote: v, serverNow: ISO }
    },
    later: (ms: number) => {
      now += ms
    },
  }
}

describe('G1: a refused click asks the server about the vote first, when this tab’s copy is not fresh', () => {
  it('the selection vote was replaced by a board vote this person has not joined: no notice, the join card shows', async () => {
    const t = setup(selectionVote())
    await t.store.refresh()
    await t.store.joinVote(OLD)
    // the stream misses the end of the selection vote and the start of a board vote
    t.setServer(vote(NEW))
    t.later(REFUSE_CONFIRMED_MS)
    await refusedClick(t.ctx, t.store, OLD, 'loose')
    expect(t.notices).toEqual([])
    expect(t.casts).toEqual([])
    expect(t.store.getSnapshot()).toMatchObject({ vote: { session: { id: NEW } }, participation: null })
  })

  it('…and joined (another tab): the click votes in the board vote', async () => {
    const t = setup(selectionVote())
    await t.store.refresh()
    await t.store.joinVote(OLD)
    t.store.setParticipation(NEW, 'joined')
    t.setServer(vote(NEW))
    t.later(REFUSE_CONFIRMED_MS)
    await refusedClick(t.ctx, t.store, OLD, 'loose')
    expect(t.notices).toEqual([])
    expect(t.casts).toEqual([{ path: `/api/votes/${NEW}/cast`, body: { shapeId: 'shape:loose', delta: 1 } }])
  })

  it('still the same vote: the notice, after one check (none while the copy is fresh)', async () => {
    const t = setup(selectionVote())
    await t.store.refresh()
    await t.store.joinVote(OLD)
    const n = t.gets.length
    // just confirmed: refused at once, no request
    await refusedClick(t.ctx, t.store, OLD, 'loose')
    expect(t.gets.length).toBe(n)
    expect(t.notices).toEqual(['Not part of this vote: only objects in the selection take votes.'])
    // a while later: checked, still the selection vote, refused again
    t.later(REFUSE_CONFIRMED_MS)
    await refusedClick(t.ctx, t.store, OLD, 'loose')
    expect(t.gets.length).toBe(n + 1)
    expect(t.notices).toHaveLength(2)
    expect(t.casts).toEqual([])
  })

  it('the vote ended meanwhile: nothing is cast and nothing is said (the vote shows as ended)', async () => {
    const t = setup(selectionVote())
    await t.store.refresh()
    await t.store.joinVote(OLD)
    t.setServer(vote(OLD, { scope: 'selection', selection: ['shape:went'], status: 'closed' }))
    t.later(REFUSE_CONFIRMED_MS)
    await refusedClick(t.ctx, t.store, OLD, 'loose')
    expect(t.notices).toEqual([])
    expect(t.casts).toEqual([])
    expect(t.store.getSnapshot().vote?.session.status).toBe('closed')
  })

  it('a new vote that does not take the object either: the notice names the new vote’s rule', async () => {
    const t = setup(vote(OLD))
    await t.store.refresh()
    await t.store.joinVote(OLD)
    t.store.setParticipation(NEW, 'joined')
    t.setServer(vote(NEW, { scope: 'frame', frameId: 'shape:went', shapeTypes: ['note'] }))
    t.later(REFUSE_CONFIRMED_MS)
    await refusedClick(t.ctx, t.store, OLD, 'loose')
    expect(t.notices).toEqual(['Not part of this vote: only sticky notes in “Went well” take votes.'])
    expect(t.casts).toEqual([])
  })
})
