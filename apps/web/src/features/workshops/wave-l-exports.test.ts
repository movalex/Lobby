// Wave L (W5 owns; W2 and W8 import): lastRevealedResults(), agendaActuals() and the workshop command ids
// with their args. Read-only: nothing is fetched, created or written.
import { describe, expect, it } from 'vitest'
import { agendaActuals } from '../present-export/live/agenda.ts'
import {
  presentExportArgs,
  spotlightArgs,
  voteSetupArgs,
  WORKSHOP_COMMAND_IDS,
  WORKSHOP_COMMAND_MAX_IDS,
} from './commands.ts'
import { loadWorkshop, workshopKit } from './ported/ctx-kit.ts'
import { lastRevealedResults } from './store.ts'

const iso = (ms: number) => new Date(Date.now() + ms).toISOString()
const session = (id: string, status: 'open' | 'closed' | 'revealed') => ({
  id,
  boardId: 'b-k3kit00001',
  title: `Vote ${id.slice(-3)}`,
  votesPerPerson: 3,
  onePerObject: false,
  scope: 'board' as const,
  frameId: null,
  shapeTypes: null,
  status,
  createdBy: 'usr_facilitator0001',
  createdAt: iso(-60_000),
  endsAt: null,
  closedAt: status === 'open' ? null : iso(-30_000),
  revealedAt: status === 'revealed' ? iso(-20_000) : null,
})
const SID1 = 'vot_aaaaaaaaaaaaaaaaaaa1'
const SID2 = 'vot_bbbbbbbbbbbbbbbbbbb2'
const vote = (
  id: string,
  status: 'open' | 'closed' | 'revealed',
  results: { shapeId: string; count: number; rank: number }[] | null,
  participants = 3,
) => ({
  session: session(id, status),
  myVotes: {},
  myRemaining: 3,
  done: false,
  participantsDone: 0,
  participants,
  totalVotesCast: 0,
  results,
})

describe('lastRevealedResults', () => {
  it('is null without a workshop store for the board (it never creates one)', () => {
    expect(lastRevealedResults({})).toBeNull()
  })

  it('is null for a vote that is not revealed, and for none', async () => {
    const kit = workshopKit({})
    await loadWorkshop(kit, { timer: null, vote: null, serverNow: iso(0) })
    expect(lastRevealedResults(kit.events)).toBeNull()
    await loadWorkshop(kit, { timer: null, vote: vote(SID1, 'open', null), serverNow: iso(0) })
    expect(lastRevealedResults(kit.events)).toBeNull()
    await loadWorkshop(kit, { timer: null, vote: vote(SID1, 'closed', null), serverNow: iso(0) })
    expect(lastRevealedResults(kit.events)).toBeNull()
  })

  it('gives a revealed vote’s results as refs with counts and ranks', async () => {
    const kit = workshopKit({})
    await loadWorkshop(kit, {
      timer: null,
      vote: vote(SID1, 'revealed', [
        { shapeId: 'shape:a', count: 3, rank: 1 },
        { shapeId: 'shape:b', count: 3, rank: 1 },
        { shapeId: 'shape:c', count: 1, rank: 3 },
      ]),
      serverNow: iso(0),
    })
    expect(lastRevealedResults(kit.events)).toEqual({
      sessionId: SID1,
      participants: 3,
      results: [
        { ref: 'shape:a', count: 3, rank: 1 },
        { ref: 'shape:b', count: 3, rank: 1 },
        { ref: 'shape:c', count: 1, rank: 3 },
      ],
    })
  })

  it('keeps the last revealed vote after a newer vote opens (the board’s current vote is the open one)', async () => {
    const kit = workshopKit({})
    await loadWorkshop(kit, {
      timer: null,
      vote: vote(SID1, 'revealed', [{ shapeId: 'shape:a', count: 2, rank: 1 }]),
      serverNow: iso(0),
    })
    await loadWorkshop(kit, { timer: null, vote: vote(SID2, 'open', null), serverNow: iso(0) })
    expect(kit.store.getSnapshot().vote?.session.id).toBe(SID2)
    expect(lastRevealedResults(kit.events)).toMatchObject({
      sessionId: SID1,
      results: [{ ref: 'shape:a', count: 2, rank: 1 }],
    })
    // and the newer vote's own results replace it once that one is revealed
    await loadWorkshop(kit, {
      timer: null,
      vote: vote(SID2, 'revealed', [{ shapeId: 'shape:z', count: 5, rank: 1 }], 4),
      serverNow: iso(0),
    })
    expect(lastRevealedResults(kit.events)).toEqual({
      sessionId: SID2,
      participants: 4,
      results: [{ ref: 'shape:z', count: 5, rank: 1 }],
    })
  })

  it('follows the results event of the vote it is showing (the counts the room sees at the reveal)', async () => {
    const kit = workshopKit({})
    await loadWorkshop(kit, { timer: null, vote: vote(SID1, 'closed', null, 2), serverNow: iso(0) })
    kit.events.emit('workshop.vote.results', {
      sessionId: SID1,
      results: [{ shapeId: 'shape:q', count: 4, rank: 1 }],
      totalVotesCast: 4,
      participants: 2,
    })
    expect(lastRevealedResults(kit.events)).toEqual({
      sessionId: SID1,
      participants: 2,
      results: [{ ref: 'shape:q', count: 4, rank: 1 }],
    })
  })
})

describe('agendaActuals', () => {
  it('is null on a board this tab presented no agenda on (the real record is in agenda.test.ts)', () => {
    expect(agendaActuals('b-abc1234567')).toBeNull()
  })
})

describe('the workshop command ids and their args', () => {
  it('names the three ids', () => {
    expect(WORKSHOP_COMMAND_IDS).toEqual({
      voteSetup: 'workshops.vote.setup',
      spotlight: 'workshops.spotlight',
      presentExport: 'present-export.export',
    })
  })

  it('reads vote setup args: a selection needs refs; unknown fields are dropped', () => {
    expect(voteSetupArgs({ scope: 'selection', refs: ['shape:a'], onePerObject: true, x: 1 })).toEqual({
      scope: 'selection',
      refs: ['shape:a'],
      onePerObject: true,
    })
    expect(voteSetupArgs({ scope: 'board' })).toEqual({ scope: 'board' })
    expect(voteSetupArgs({ scope: 'selection' })).toBeNull()
    expect(voteSetupArgs({ scope: 'selection', refs: [] })).toBeNull()
    expect(voteSetupArgs({ scope: 'everything' })).toBeNull()
    expect(voteSetupArgs({ scope: 'board', refs: [1] })).toBeNull()
    expect(
      voteSetupArgs({ scope: 'selection', refs: Array(WORKSHOP_COMMAND_MAX_IDS + 1).fill('shape:a') }),
    ).toBeNull()
    expect(voteSetupArgs(undefined)).toBeNull()
  })

  it('reads spotlight and export args', () => {
    expect(spotlightArgs({ ids: ['a', 'b'] })).toEqual({ ids: ['a', 'b'] })
    expect(spotlightArgs({ ids: [] })).toBeNull()
    expect(spotlightArgs({})).toBeNull()
    expect(presentExportArgs({ frameIds: ['f1'] })).toEqual({ frameIds: ['f1'] })
    expect(presentExportArgs(undefined)).toEqual({})
  })
})
