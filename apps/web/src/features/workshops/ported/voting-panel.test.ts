// K3-2 (wave K): facilitation tools got tried but never finished: no "x of y voted", no clear end, and a
// brainstorm nobody revealed. The Voting panel and the facilitator's bars on the board, rendered to markup
// (react-dom/server) from the counts the api already sends (`participants`, `participantsDone`,
// `totalVotesCast`; for a brainstorm `counts`). In a browser: e2e/excalidraw/k3-finish.spec.ts.
import type { PrivateBrainstormState } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { privateStoreFor } from '../private-notes/hooks.ts'
import { describeVoted, votedOf } from '../voting.ts'
import { loadWorkshop, workshopKit } from './ctx-kit.ts'
import { PrivateNotesFacilitatorBar, PrivateNotesStartPrompt } from './private-notes/PrivateNotesBar.tsx'
import { note } from './test-kit.ts'
import { VotingPanel } from './VotingPanel.tsx'
import { VoteFacilitatorBar } from './WorkshopOverlay.tsx'

const SID = 'vot_0123456789abcdefghij'
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()
const COLLEAGUE = { uid: 'usr_colleague00001', name: 'Cole Lee' }

function vote(over: Record<string, unknown> = {}, session: Record<string, unknown> = {}) {
  return {
    session: {
      id: SID,
      boardId: 'b-k3kit00001',
      title: 'Pick our next experiment',
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board' as const,
      frameId: null,
      shapeTypes: null,
      status: 'open' as const,
      createdBy: 'usr_facilitator0001',
      createdAt: iso(-60_000),
      endsAt: null,
      closedAt: null,
      revealedAt: null,
      ...session,
    },
    myVotes: {},
    myRemaining: 3,
    done: false,
    participantsDone: 0,
    participants: 0,
    totalVotesCast: 0,
    results: null,
    ...over,
  }
}

const text = (html: string) => html.replace(/<[^>]+>/g, '')
const panel = (kit: ReturnType<typeof workshopKit>) =>
  renderToStaticMarkup(createElement(VotingPanel, { ctx: kit.ctx, close: () => {} }))

describe('"x of y voted" (K3-2)', () => {
  it('counts the people here who could vote; the facilitator only once they voted themselves', () => {
    expect(votedOf({ participants: 0, othersHere: 1, meIn: false })).toEqual({ voted: 0, of: 1 })
    expect(votedOf({ participants: 1, othersHere: 1, meIn: false })).toEqual({ voted: 1, of: 1 })
    expect(votedOf({ participants: 2, othersHere: 1, meIn: true })).toEqual({ voted: 2, of: 2 })
    // someone voted and left: never "2 of 1"
    expect(votedOf({ participants: 2, othersHere: 1, meIn: false })).toEqual({ voted: 2, of: 2 })
    expect(describeVoted({ voted: 1, of: 3 })).toBe('1 of 3 voted')
    expect(describeVoted({ voted: 0, of: 0 })).toBe('Nobody else is here yet')
  })
})

describe('the Voting panel for the facilitator (K3-2)', () => {
  it('an open vote: "0 of 1 voted", then "1 of 1 voted", with Reveal and End', async () => {
    const kit = workshopKit({ others: [COLLEAGUE] })
    await loadWorkshop(kit, { timer: null, vote: vote(), serverNow: iso(0) })
    let html = panel(kit)
    expect(html).toMatch(/data-testid="vote-voted"[^>]*>0 of 1 voted</)
    expect(text(html)).toContain('Waiting for votes') // the old progress line stays
    expect(html).toMatch(/data-testid="vote-reveal"[^>]*>End and show results</)
    expect(html).toMatch(/data-testid="vote-close"[^>]*>End without results</)
    expect(html).not.toContain('vote-final')
    // the colleague casts: the counts the api sends (an event) move it
    kit.events.emit('workshop.vote', {
      sessionId: SID,
      status: 'open',
      totalVotesCast: 2,
      participants: 1,
      participantsDone: 0,
      endsAt: null,
    })
    html = panel(kit)
    expect(html).toMatch(/data-testid="vote-voted"[^>]*>1 of 1 voted</)
    expect(text(html)).toContain('0 of 1 done · 2 votes cast')
  })

  it('after the reveal: a final state, the results, and the next vote', async () => {
    const kit = workshopKit({ others: [COLLEAGUE], elements: [...note('n1', 'Weekly demo')] })
    await loadWorkshop(kit, {
      timer: null,
      vote: vote(
        { participants: 2, totalVotesCast: 5, results: [{ shapeId: 'shape:n1', count: 5, rank: 1 }] },
        { status: 'revealed', closedAt: iso(-1_000), revealedAt: iso(-500) },
      ),
      serverNow: iso(0),
    })
    const html = panel(kit)
    expect(text(html)).toContain('Voting is over: 5 votes from 2 people. Everyone sees the results.')
    expect(html).toContain('data-testid="vote-final"')
    expect(html).toContain('data-testid="vote-results"')
    expect(text(html)).toContain('Weekly demo')
    expect(html).not.toContain('data-testid="vote-reveal"')
    expect(html).not.toContain('data-testid="vote-voted"')
    expect(html).toContain('Start a new vote…')
  })

  it("someone who is not facilitating sees no counts and no end buttons, and nobody's ballot", async () => {
    const kit = workshopKit({ role: 'viewer', others: [COLLEAGUE] })
    await loadWorkshop(kit, {
      timer: null,
      vote: vote({ participants: 1, totalVotesCast: 2 }),
      serverNow: iso(0),
    })
    const html = panel(kit)
    expect(html).not.toContain('vote-voted')
    expect(html).not.toContain('vote-reveal')
  })
})

describe("the facilitator's bar on the board (K3-2)", () => {
  it('an open vote: "0 of 1 voted" and "Show results"', async () => {
    const kit = workshopKit({ others: [COLLEAGUE] })
    await loadWorkshop(kit, { timer: null, vote: vote(), serverNow: iso(0) })
    const html = renderToStaticMarkup(createElement(VoteFacilitatorBar, { ctx: kit.ctx, store: kit.store }))
    expect(html).toMatch(/data-testid="vote-bar-voted"[^>]*>0 of 1 voted</)
    expect(html).toMatch(/data-testid="vote-bar-reveal"[^>]*>Show results</)
    // not for a participant
    const viewer = workshopKit({ role: 'viewer', others: [COLLEAGUE] })
    await loadWorkshop(viewer, { timer: null, vote: vote(), serverNow: iso(0) })
    expect(
      renderToStaticMarkup(createElement(VoteFacilitatorBar, { ctx: viewer.ctx, store: viewer.store })),
    ).toBe('')
  })
})

describe('the private brainstorm prompts for notes and counts them (K3-2)', () => {
  const brainstorm = (over: Partial<PrivateBrainstormState> = {}): PrivateBrainstormState => ({
    session: {
      id: 'pbs_0123456789abcdefghij',
      boardId: 'b-k3kit00001',
      prompt: 'What slowed us down?',
      anonymous: false,
      frameId: 'shape:frame1',
      status: 'open',
      createdBy: 'usr_facilitator0001',
      createdAt: iso(-30_000),
      revealedAt: null,
      endedAt: null,
      placedCount: null,
    },
    counts: { notes: 3, people: 2 },
    myNotes: [],
    canReveal: true,
    starterLeft: false,
    placed: null,
    ...over,
  })

  async function loaded(kit: ReturnType<typeof workshopKit>, state: PrivateBrainstormState) {
    kit.next(
      (m, p) => m === 'GET' && p.endsWith('/private-brainstorm'),
      () => state,
    )
    const store = privateStoreFor(kit.ctx)
    await store.refresh()
    return store
  }

  it('the facilitator: the submitted count and a Reveal, from the counts alone', async () => {
    const kit = workshopKit({ others: [COLLEAGUE] })
    await loaded(kit, brainstorm())
    const html = renderToStaticMarkup(createElement(PrivateNotesFacilitatorBar, { ctx: kit.ctx }))
    expect(html).toMatch(/data-testid="pn-bar-counts"[^>]*>3 notes from 2 people</)
    expect(html).toMatch(/data-testid="pn-bar-reveal"[^>]*>Reveal 3 notes</)
    // the state the client holds has nobody's text: counts only (and the caller's own drafts)
    expect(JSON.stringify(privateStoreFor(kit.ctx).getSnapshot())).not.toMatch(/"text"/)
  })

  it('a participant: the prompt to add their notes, and no facilitator bar', async () => {
    const kit = workshopKit({ role: 'editor', userId: 'usr_colleague00001' })
    const store = await loaded(kit, brainstorm({ canReveal: false, counts: { notes: 0, people: 0 } }))
    expect(store.getSnapshot().startNews).toEqual({ sessionId: 'pbs_0123456789abcdefghij' })
    expect(renderToStaticMarkup(createElement(PrivateNotesFacilitatorBar, { ctx: kit.ctx }))).toBe('')
    const prompt = renderToStaticMarkup(createElement(PrivateNotesStartPrompt, { ctx: kit.ctx }))
    expect(prompt).toContain('data-testid="pn-start-prompt"')
    expect(text(prompt)).toContain('What slowed us down?')
    expect(prompt).toMatch(/data-testid="pn-start-prompt-write"[^>]*>Add your notes</)
  })
})
