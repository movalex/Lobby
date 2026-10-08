// K3-3 (wave K, UXD-01): the one Facilitate button and its menu, rendered to markup (react-dom/server; the
// clicks and keys in a browser are e2e/excalidraw/k3-facilitate.spec.ts). The menu lists Timer, Reactions and
// raise hand, and Voting under the test ids the bar's own controls had; the button's pill shows only what is
// live.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { loadWorkshop, workshopKit } from './ctx-kit.ts'
import { FacilitateMenu, WorkshopBar } from './WorkshopBar.tsx'

const SID = 'vot_0123456789abcdefghij'
const iso = (ms: number) => new Date(Date.now() + ms).toISOString()

function openVote() {
  return {
    session: {
      id: SID,
      boardId: 'b-k3kit00001',
      title: 'Dot vote',
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board' as const,
      frameId: null,
      shapeTypes: null,
      status: 'open' as const,
      createdBy: 'usr_cofacilitator01', // started by someone else: this person has not joined
      createdAt: iso(-60_000),
      endsAt: null,
      closedAt: null,
      revealedAt: null,
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

const runningTimer = (leftMs: number) => ({
  status: 'running' as const,
  durationMs: 300_000,
  remainingMs: leftMs,
  endsAt: iso(leftMs),
  startedAt: iso(leftMs - 300_000),
  startedBy: 'usr_facilitator0001',
  updatedAt: iso(-1_000),
})

const testIds = (html: string) => [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1])

describe('the Facilitate menu (K3-3)', () => {
  it('lists Timer, Reactions and raise hand, and Voting under their existing test ids', async () => {
    const kit = workshopKit()
    await loadWorkshop(kit, { timer: runningTimer(298_000), vote: null, serverNow: iso(0) })
    const html = renderToStaticMarkup(
      createElement(FacilitateMenu, {
        id: 'm',
        ctx: kit.ctx,
        store: kit.store,
        snap: kit.store.getSnapshot(),
        entries: ['timer', 'reactions', 'voting'],
        facilitator: true,
        timer: { display: 'running', remaining: 298_000 },
        onShow: () => {},
        onClose: () => {},
      }),
    )
    expect(html).toContain('role="menu"')
    expect(testIds(html)).toEqual(['facilitate-menu', 'timer-pill', 'reactions-button', 'vote-chip'])
    expect(html).toMatch(/data-testid="timer-pill"[^>]*data-state="running"/)
    expect(html).toContain('>Timer<')
    expect(html).toContain('4:58 left')
    expect(html).toContain('>Reactions and raise hand<')
    expect(html).toContain('>Voting<')
    expect(html).toContain('Start…') // a facilitator with no vote yet starts one from here
    expect(html.match(/role="menuitem"/g)).toHaveLength(3)
  })

  it('a raised hand and an open vote: the hands entry, and Voting says what to do', async () => {
    const kit = workshopKit()
    await loadWorkshop(kit, {
      timer: null,
      vote: openVote(),
      hands: [{ userId: 'usr_participant0001', name: 'Pat', raisedAt: iso(-5_000) }],
      handsVersion: { epoch: 'e1', n: 1 },
      serverNow: iso(0),
    })
    const html = renderToStaticMarkup(
      createElement(FacilitateMenu, {
        id: 'm',
        ctx: kit.ctx,
        store: kit.store,
        snap: kit.store.getSnapshot(),
        entries: ['timer', 'reactions', 'hands', 'voting'],
        facilitator: true,
        timer: { display: 'idle', remaining: 0 },
        onShow: () => {},
        onClose: () => {},
      }),
    )
    expect(testIds(html)).toEqual([
      'facilitate-menu',
      'timer-pill',
      'reactions-button',
      'hands-chip',
      'vote-chip',
    ])
    expect(html).toMatch(/data-testid="hands-chip"[^>]*data-count="1"/)
    expect(html).toContain('Not set')
    expect(html).toContain('>Join<') // not joined yet
  })
})

describe('the Facilitate button (K3-3)', () => {
  it('idle: "Facilitate" and no pill', async () => {
    const kit = workshopKit()
    await loadWorkshop(kit, { timer: null, vote: null, serverNow: iso(0) })
    const html = renderToStaticMarkup(createElement(WorkshopBar, { ctx: kit.ctx }))
    expect(html).toContain('data-testid="facilitate-button"')
    expect(html).toContain('>Facilitate<')
    expect(html).not.toContain('facilitate-pill')
    expect(html).toContain('data-live="false"')
    // the bar's old controls are behind the menu now, not in the bar
    for (const id of ['timer-pill', 'reactions-button', 'vote-chip', 'hands-chip', 'pn-chip'])
      expect(testIds(html), id).not.toContain(id)
  })

  it('a running timer and an open vote: the pill reads "4:58 · Vote"', async () => {
    const kit = workshopKit()
    await loadWorkshop(kit, { timer: runningTimer(298_000), vote: openVote(), serverNow: iso(0) })
    const html = renderToStaticMarkup(createElement(WorkshopBar, { ctx: kit.ctx }))
    const pill =
      /<span class="dr-wk-facilitate__pill" data-testid="facilitate-pill">(.*?)<\/span><\/button>/.exec(
        html,
      )?.[1]
    expect(pill?.replace(/<[^>]+>/g, '')).toBe('4:58·Vote')
    expect(html).toMatch(/data-testid="timer-remaining"[^>]*>4:58</)
    expect(html).toContain('data-timer-state="running"')
    expect(html).toContain('aria-label="Facilitate: timer 4 minutes 58 seconds left, a vote is open"')
  })

  it('someone who cannot facilitate sees "Session"', async () => {
    const kit = workshopKit({ role: 'viewer' })
    await loadWorkshop(kit, { timer: null, vote: null, serverNow: iso(0) })
    const html = renderToStaticMarkup(createElement(WorkshopBar, { ctx: kit.ctx }))
    expect(html).toContain('>Session<')
  })
})
