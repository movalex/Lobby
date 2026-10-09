// Wave L foundation (W5 owns; W2 and W8 import): lastRevealedResults(), agendaActuals() and the workshop command
// ids with their args. Read-only: nothing is fetched, created or written.
import type { WorkshopVoteState } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { agendaActuals } from '../present-export/live/agenda.ts'
import {
  presentExportArgs,
  spotlightArgs,
  voteSetupArgs,
  WORKSHOP_COMMAND_IDS,
  WORKSHOP_COMMAND_MAX_IDS,
} from './commands.ts'
import { lastRevealedResults, type WorkshopStore, workshopStoreFor } from './store.ts'

const vote = (status: 'open' | 'closed' | 'revealed', results: WorkshopVoteState['results']) =>
  ({
    session: { id: 'vot_0123456789abcdefghij', status },
    participants: 3,
    results,
  }) as unknown as WorkshopVoteState

/** A store stand-in holding `v` as its vote (only what lastRevealedResults reads). */
function boardWith(v: WorkshopVoteState | null) {
  const events = { on: () => () => {}, onResync: () => () => {}, serverOffsetMs: () => 0 }
  workshopStoreFor(
    events,
    () => ({ getSnapshot: () => ({ vote: v }), startFirstLoad: () => {} }) as unknown as WorkshopStore,
  )
  return events
}

describe('lastRevealedResults', () => {
  it('is null without a workshop store for the board (it never creates one)', () => {
    expect(lastRevealedResults({})).toBeNull()
  })

  it('is null for a vote that is not revealed, and for none', () => {
    expect(lastRevealedResults(boardWith(null))).toBeNull()
    expect(lastRevealedResults(boardWith(vote('open', null)))).toBeNull()
    expect(lastRevealedResults(boardWith(vote('closed', null)))).toBeNull()
  })

  it('gives a revealed vote’s results as refs with counts and ranks', () => {
    const events = boardWith(
      vote('revealed', [
        { shapeId: 'shape:a', count: 3, rank: 1 },
        { shapeId: 'shape:b', count: 3, rank: 1 },
        { shapeId: 'shape:c', count: 1, rank: 3 },
      ]),
    )
    expect(lastRevealedResults(events)).toEqual({
      sessionId: 'vot_0123456789abcdefghij',
      participants: 3,
      results: [
        { ref: 'shape:a', count: 3, rank: 1 },
        { ref: 'shape:b', count: 3, rank: 1 },
        { ref: 'shape:c', count: 1, rank: 3 },
      ],
    })
  })
})

describe('agendaActuals (foundation stub)', () => {
  it('is null: no agenda recorded before W5’s run of show', () => {
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
