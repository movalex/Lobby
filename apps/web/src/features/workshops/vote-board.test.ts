// L5-3 vote results that move the meeting, on a small in-memory board: "Results to board" (one transact, a frame
// with its bars and words, placed clear of the board), "Gather the winners" (rank order, no +1s on the copies,
// move mode and frame membership) and the run-off's prefill. The copies go through the real duplicate rules
// (canvas/board/tx.ts), so what the registry strips is stripped here too. The panel's pieces are rendered at
// the end; the browsers are e2e/excalidraw/l5-results.spec.ts.
import type { WorkshopVoteState } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyTx } from '../../canvas/api/index.ts'
// a test only: the real duplicate rules (canvas/board/tx.ts is pure), so what the registry strips is stripped here too
import { duplicate, setFrame, type TxView } from '../../canvas/board/tx.ts'
import { loadWorkshop, workshopKit } from './ported/ctx-kit.ts'
import { el, fakeCanvas, note } from './ported/test-kit.ts'
import { VotingPanel } from './ported/VotingPanel.tsx'
import {
  candidatesOf,
  gatherWinners,
  obstaclesOf,
  resultsToBoard,
  runOffPrefill,
  scopeBounds,
  VOTE_CHART_KIND,
  VOTE_RANK_KIND,
  VOTE_WINNERS_KIND,
} from './ported/vote-board.ts'

const SID = 'vot_0123456789abcdefghij'
const PLUS = 'plusOne:usr_voter0000001'

/** The kit's canvas with what the real transaction has and the fake one lacks: duplicate, setFrame, measure. */
function board(elements: CanvasElement[]) {
  const f = fakeCanvas(elements)
  const steps: string[] = []
  const real = f.canvas.transact.bind(f.canvas)
  let ids = 0
  f.canvas.transact = ((label: string, fn: (tx: LobbyTx) => unknown, o?: never) => {
    steps.push(label)
    return real(
      label,
      (tx) => {
        const view: TxView = {
          get: (id) => f.elements.find((e) => e.id === id),
          items: () => f.elements.filter((e) => !e.isDeleted),
          update: (id, patch) => tx.update(id, patch),
          create: (kind, props) => tx.create(kind, props),
          newId: () => `gen${++ids}`,
        }
        return fn(
          Object.assign(tx, {
            setFrame: (a: readonly string[], frame: string | null) => setFrame(view, a, frame),
            duplicate: (a: readonly string[], offset?: { x: number; y: number }) =>
              duplicate(view, a, offset ?? { x: 0, y: 0 }, []),
          }),
        )
      },
      o,
    )
  }) as typeof f.canvas.transact
  ;(f.canvas as unknown as { text: unknown }).text = {
    measure: (text: string, style: { fontSize: number }) => ({
      width: Math.max(...text.split('\n').map((l) => l.length)) * style.fontSize * 0.5,
      height: text.split('\n').length * style.fontSize * 1.25,
    }),
  }
  // who else is typing in or dragging an element (round 1: move mode leaves those)
  const leases: Record<string, { sid: string; uid: string; name: string }> = {}
  const draggers: Record<string, { sid: string; name: string }> = {}
  Object.assign(f.canvas, {
    leaseHolder: (id: string) => leases[id] ?? null,
    editingId: () => null,
    presence: { draggerOf: (id: string) => draggers[id] ?? null },
  })
  const byId = (id: string) => f.elements.find((e) => e.id === id)
  const created = () => f.elements.filter((e) => e.id.startsWith('vr') || e.id.startsWith('gen'))
  return { ...f, steps, byId, created, leases, draggers }
}

const vote = (
  results: { shapeId: string; count: number; rank: number }[],
  session: Record<string, unknown> = {},
  status: 'revealed' | 'open' = 'revealed',
): WorkshopVoteState =>
  ({
    session: {
      id: SID,
      boardId: 'b-k3kit00001',
      title: 'Dot vote',
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
      frameId: null,
      selection: null,
      shapeTypes: null,
      status,
      createdBy: 'usr_facilitator0001',
      createdAt: '2026-10-09T09:00:00.000Z',
      endsAt: null,
      closedAt: '2026-10-09T09:05:00.000Z',
      revealedAt: '2026-10-09T09:06:00.000Z',
      ...session,
    },
    myVotes: {},
    myRemaining: 3,
    done: false,
    participantsDone: 0,
    participants: 4,
    totalVotesCast: results.reduce((n, r) => n + r.count, 0),
    results: status === 'revealed' ? results : null,
  }) as unknown as WorkshopVoteState

const ideas = (extra: CanvasElement[] = []) => [
  ...note('n1', 'Weekly demo'),
  ...note('n2', 'Retro every sprint'),
  ...note('n3', 'Pair on bugs'),
  ...note('n4', 'Swag'),
  ...extra,
]
const placed = (positions: Record<string, [number, number]>) =>
  ideas().map((e) => {
    const at = positions[e.id]
    return at ? { ...e, x: at[0], y: at[1] } : e
  })
const RESULTS = [
  { shapeId: 'shape:n1', count: 4, rank: 1 },
  { shapeId: 'shape:n2', count: 2, rank: 2 },
  { shapeId: 'shape:n3', count: 1, rank: 3 },
]

describe('"Results to board"', () => {
  it('is one transact: a frame named after the vote, a bar per result, their words, all in the frame', () => {
    const b = board(placed({ n1: [0, 0], n2: [300, 0], n3: [600, 0], n4: [900, 0] }))
    const out = resultsToBoard(b.canvas, vote(RESULTS), new Date('2026-10-09T10:00:00Z'))
    expect(out).toMatchObject({ bars: 3 })
    expect(b.steps).toEqual(['vote results to board'])
    const frame = b.byId(out?.frameId ?? '')
    expect(frame).toMatchObject({ type: 'frame', name: 'Results: Dot vote' })
    const kids = b.created().filter((e) => e.id !== frame?.id)
    expect(kids.every((e) => (e as { frameId?: string }).frameId === frame?.id)).toBe(true)
    const rects = kids.filter((e) => e.type === 'rectangle')
    expect(rects).toHaveLength(3)
    // heights follow the counts: 4 : 2 : 1
    const [h1 = 0, h2 = 0, h3 = 0] = rects.map((r) => r.height)
    expect(h1 / 4).toBeCloseTo(h2 / 2, 1)
    expect(h1 / 4).toBeCloseTo(h3 / 1, 1)
    // the engine takes a centred text's `x` as its middle: each count is created over the middle of its bar
    const counts = kids.filter(
      (e) => e.type === 'text' && /^[0-9]+$/.test(String((e as { text?: string }).text)),
    )
    expect(counts).toHaveLength(3)
    const barMiddles = rects.map((r) => r.x + r.width / 2).sort((x, y) => x - y)
    const countXs = counts.map((c) => c.x).sort((x, y) => x - y)
    for (const [i, x] of countXs.entries())
      expect(Math.abs(x - (barMiddles[i] ?? Number.NaN))).toBeLessThan(1)
    // every element it made is tagged, and every text carries its words
    for (const e of b.created()) expect(e.customData?.lobby?.kind, e.type).toBe(VOTE_CHART_KIND)
    // a long label wraps over lines; its words are the same
    const words = kids
      .filter((e) => e.type === 'text')
      .map((e) => String((e as { text?: string }).text ?? '').replace(/\n/g, ' '))
    expect(words).toContain('#1 Weekly demo')
    expect(words).toContain('#2 Retro every sprint')
    expect(words.some((w) => /4 people voted/.test(w ?? ''))).toBe(true)
    expect(words).toContain('4')
    // nothing existing was touched, and the frame is selected for the facilitator
    expect(b.byId('n1')).toMatchObject({ x: 0, y: 0 })
    expect([...b.canvas.selection]).toEqual([out?.frameId])
  })

  it('goes to free space beside the vote’s scope, clear of everything on the board', () => {
    const b = board([
      el('left', 'frame', { name: 'Ideas', x: 0, y: 0, width: 800, height: 600 }),
      ...placed({ n1: [100, 100], n2: [400, 100] }),
      el('wall', 'rectangle', { x: 900, y: 0, width: 600, height: 800 }), // in the way, right of the scope
    ])
    const out = resultsToBoard(b.canvas, vote(RESULTS, { scope: 'frame', frameId: 'shape:left' }))
    const frame = b.byId(out?.frameId ?? '')
    if (!frame) throw new Error('no frame')
    const mine = { x: frame.x, y: frame.y, w: frame.width, h: frame.height }
    for (const other of b.elements.filter((e) => !b.created().includes(e) && e.type !== 'text')) {
      const o = { x: other.x, y: other.y, w: other.width, h: other.height }
      const overlap =
        mine.x < o.x + o.w && o.x < mine.x + mine.w && mine.y < o.y + o.h && o.y < mine.y + mine.h
      expect(overlap, other.id).toBe(false)
    }
    expect(frame.x).toBeGreaterThan(800) // beside the frame the vote covered, not on it
  })

  it('does nothing for a vote that is not revealed, or has no results', () => {
    const b = board(ideas())
    expect(resultsToBoard(b.canvas, vote([], {}, 'open'))).toBeNull()
    expect(resultsToBoard(b.canvas, vote([]))).toBeNull()
    expect(b.steps).toEqual([])
  })

  it('reads the scope: a frame, the listed objects, or the whole board (null)', () => {
    const b = board([
      el('fr', 'frame', { x: 10, y: 20, width: 300, height: 200 }),
      ...placed({ n1: [500, 0], n2: [900, 400] }),
    ])
    expect(scopeBounds(b.canvas, { scope: 'frame', frameId: 'shape:fr', selection: null })).toEqual({
      x: 10,
      y: 20,
      w: 300,
      h: 200,
    })
    expect(
      scopeBounds(b.canvas, {
        scope: 'selection',
        frameId: null,
        selection: ['shape:n1', 'shape:n2', 'shape:gone'],
      }),
    ).toEqual({ x: 500, y: 0, w: 600, h: 600 })
    expect(scopeBounds(b.canvas, { scope: 'board', frameId: null, selection: null })).toBeNull()
    // labels are not obstacles of their own
    expect(obstaclesOf(b.canvas).length).toBe(1 + 4 + 0) // the frame and four note containers (labels left out)
  })
})

describe('"Gather the winners"', () => {
  const withVotes = () =>
    board(
      placed({ n1: [0, 0], n2: [300, 0], n3: [600, 0], n4: [900, 0] }).map((e) =>
        e.id === 'n1' || e.id === 'n3'
          ? { ...e, customData: { lobby: { [PLUS]: true, alt: 'Weekly demo card' } } }
          : e,
      ),
    )

  it('copies the top N into a Top ideas frame in rank order, one transact, originals untouched', () => {
    const b = withVotes()
    const out = gatherWinners(b.canvas, vote(RESULTS), { n: 3, move: false })
    expect(out).toMatchObject({ gathered: 3, skipped: { gone: 0, frames: 0, locked: 0 } })
    expect(b.steps).toEqual(['gather the winners'])
    const frame = b.byId(out?.frameId ?? '')
    expect(frame).toMatchObject({ type: 'frame', name: 'Top ideas' })
    expect(frame?.customData?.lobby?.kind).toBe(VOTE_WINNERS_KIND)
    // three notes (copies) now sit in the frame, left to right in rank order
    const copies = b.created().filter((e) => e.type === 'stickynote')
    expect(copies).toHaveLength(3)
    expect(copies.every((c) => (c as { frameId?: string }).frameId === frame?.id)).toBe(true)
    const byX = [...copies].sort((a, c) => a.x - c.x)
    const words = (id: string) => (b.byId(`${id}`)?.customData ? id : id)
    void words
    // rank order: the copy made of n1 is first (it has n1's position order); check by rank texts left to right
    const ranks = b
      .created()
      .filter((e) => e.type === 'text' && e.customData?.lobby?.kind === VOTE_RANK_KIND)
      .sort((a, c) => a.x - c.x)
      .map((t) => (t as { text?: string }).text)
    expect(ranks).toEqual(['#1 · 4 votes', '#2 · 2 votes', '#3 · 1 vote'])
    expect(byX).toHaveLength(3)
    // the originals are where they were, in no new frame
    for (const id of ['n1', 'n2', 'n3']) expect(b.byId(id)).toMatchObject({ frameId: null })
    expect(b.byId('n1')).toMatchObject({ x: 0, y: 0 })
  })

  it('copies carry no +1s (the duplicate rules strip them) and keep what is free to keep', () => {
    const b = withVotes()
    gatherWinners(b.canvas, vote(RESULTS), { n: 3, move: false })
    const copies = b.created().filter((e) => e.type === 'stickynote')
    for (const c of copies) {
      const lobby = c.customData?.lobby ?? {}
      expect(
        Object.keys(lobby).filter((k) => k.startsWith('plusOne:')),
        c.id,
      ).toEqual([])
    }
    // the originals keep theirs
    expect(Object.keys(b.byId('n1')?.customData?.lobby ?? {})).toContain(PLUS)
    // a free key (the alt text) is kept on the copy of n1
    const withAlt = copies.filter((c) => c.customData?.lobby?.alt === 'Weekly demo card')
    expect(withAlt.length).toBeGreaterThan(0)
  })

  it('move mode moves the originals into the frame, out of the frame they were in, labels with them', () => {
    const b = board([
      el('old', 'frame', { name: 'Ideas', x: 0, y: 0, width: 1200, height: 500 }),
      ...placed({ n1: [100, 100], n2: [400, 100], n3: [700, 100], n4: [1000, 100] }).map((e) =>
        e.id.startsWith('n') ? { ...e, frameId: 'old' } : e,
      ),
    ])
    const before = (b.byId('n1-label')?.x ?? 0) - (b.byId('n1')?.x ?? 0)
    const out = gatherWinners(b.canvas, vote(RESULTS), { n: 2, move: true })
    expect(out).toMatchObject({ gathered: 2 })
    expect(b.steps).toEqual(['move the winners into Top ideas'])
    for (const id of ['n1', 'n2']) {
      expect(b.byId(id), id).toMatchObject({ frameId: out?.frameId })
      expect(b.byId(`${id}-label`), id).toMatchObject({ frameId: out?.frameId })
    }
    // the others stayed in the frame they were in
    for (const id of ['n3', 'n4']) expect(b.byId(id)).toMatchObject({ frameId: 'old' })
    // the winners and their labels moved by the same step
    const n1 = b.byId('n1')
    const label = b.byId('n1-label')
    expect(label && n1 ? label.x - n1.x : Number.NaN).toBe(before)
    // nothing was copied
    expect(b.created().filter((e) => e.type === 'stickynote')).toHaveLength(0)
  })

  it('includes ties at the cut-off, and leaves out what is locked, a frame or gone, saying how many', () => {
    const b = board([
      ...placed({ n1: [0, 0], n2: [300, 0], n3: [600, 0], n4: [900, 0] }).map((e) =>
        e.id === 'n2' ? { ...e, locked: true } : e,
      ),
      el('fr', 'frame', { x: 0, y: 1000, width: 100, height: 100 }),
    ])
    const tied = vote([
      { shapeId: 'shape:n1', count: 4, rank: 1 },
      { shapeId: 'shape:n2', count: 3, rank: 2 }, // locked
      { shapeId: 'shape:n3', count: 3, rank: 2 },
      { shapeId: 'shape:fr', count: 2, rank: 4 }, // a frame
      { shapeId: 'shape:gone', count: 1, rank: 5 },
    ])
    const out = gatherWinners(b.canvas, tied, { n: 5, move: false })
    expect(out).toMatchObject({ gathered: 2, skipped: { gone: 1, frames: 1, locked: 1 } })
    // nothing to gather at all: no frame
    const none = gatherWinners(board(ideas()).canvas, vote([{ shapeId: 'shape:ghost', count: 2, rank: 1 }]), {
      n: 3,
      move: false,
    })
    expect(none).toEqual({ frameId: null, gathered: 0, skipped: { gone: 1, frames: 0, locked: 0 } })
  })

  it('a note in a locked frame is gathered as a copy but not moved (the server refuses a write to it)', () => {
    const make = () =>
      board([
        el('lockedframe', 'frame', { x: 0, y: 0, width: 1200, height: 500, locked: true }),
        ...placed({ n1: [100, 100], n2: [400, 100] }).map((e) =>
          e.id.startsWith('n1') || e.id.startsWith('n2') ? { ...e, frameId: 'lockedframe' } : e,
        ),
      ])
    const copy = gatherWinners(make().canvas, vote(RESULTS), { n: 2, move: false })
    expect(copy).toMatchObject({ gathered: 2, skipped: { locked: 0 } })
    const move = gatherWinners(make().canvas, vote(RESULTS), { n: 2, move: true })
    expect(move).toEqual({ frameId: null, gathered: 0, skipped: { gone: 0, frames: 0, locked: 2 } })
  })

  it('move mode leaves a winner someone is typing in or dragging, and counts it; copying takes it (round 1)', () => {
    const make = () => {
      const b = board(placed({ n1: [100, 100], n2: [400, 100], n3: [700, 100] }))
      b.leases['n1-label'] = { sid: 'sid-other', uid: 'usr_typist00001', name: 'Tia' }
      b.draggers.n2 = { sid: 'sid-other', name: 'Dee' }
      return b
    }
    const results = [
      { shapeId: 'shape:n1', count: 3, rank: 1 },
      { shapeId: 'shape:n2', count: 2, rank: 2 },
      { shapeId: 'shape:n3', count: 1, rank: 3 },
    ]
    const moved = make()
    const out = gatherWinners(moved.canvas, vote(results), { n: 3, move: true })
    expect(out).toMatchObject({ gathered: 1, skipped: { locked: 2 } })
    expect(moved.byId('n1')).toMatchObject({ x: 100, y: 100 })
    expect(moved.byId('n1-label')?.frameId ?? null).not.toBe(out?.frameId)
    expect(moved.byId('n2')).toMatchObject({ x: 400, y: 100 })
    const copied = gatherWinners(make().canvas, vote(results), { n: 3, move: false })
    expect(copied).toMatchObject({ gathered: 3, skipped: { locked: 0 } })
  })

  it('reads the candidates from the board as it is now', () => {
    const b = board([...ideas(), el('fr', 'frame', { x: 0, y: 900 })])
    b.canvas.transact('del', (tx) => tx.delete('n3'))
    const c = candidatesOf(b.canvas, [
      { shapeId: 'shape:n1', count: 3, rank: 1 },
      { shapeId: 'shape:n3', count: 2, rank: 2 },
      { shapeId: 'shape:fr', count: 1, rank: 3 },
      { shapeId: 'nope', count: 1, rank: 3 },
    ])
    expect(c.map((x) => [x.ref, x.live, x.frame, x.id])).toEqual([
      ['shape:n1', true, false, 'n1'],
      ['shape:n3', false, false, 'n3'],
      ['shape:fr', true, true, 'fr'],
      ['nope', false, false, null],
    ])
  })
})

describe('the run-off', () => {
  it('is a selection vote over exactly the top N, one vote per object, a few votes each', () => {
    const b = board(ideas())
    const p = runOffPrefill(b.canvas, vote(RESULTS), 3)
    expect(p).toEqual({
      scope: 'selection',
      refs: ['shape:n1', 'shape:n2', 'shape:n3'],
      onePerObject: true,
      title: 'Run-off: Dot vote',
      votesPerPerson: 1,
    })
    expect(runOffPrefill(b.canvas, vote(RESULTS), 2)?.refs).toEqual(['shape:n1', 'shape:n2'])
  })

  it('needs two candidates still on the board; a locked one is fine (a vote writes nothing)', () => {
    const b = board(ideas().map((e) => (e.id === 'n2' ? { ...e, locked: true } : e)))
    expect(runOffPrefill(b.canvas, vote(RESULTS), 1)).toBeNull()
    expect(runOffPrefill(b.canvas, vote(RESULTS), 2)?.refs).toEqual(['shape:n1', 'shape:n2'])
    expect(runOffPrefill(b.canvas, vote([]), 3)).toBeNull()
    b.canvas.transact('del', (tx) => {
      tx.delete('n2')
      tx.delete('n3')
    })
    expect(runOffPrefill(b.canvas, vote(RESULTS), 3)).toBeNull()
  })

  it('keeps a long title within the vote title limit', () => {
    const b = board(ideas())
    const long = 'x'.repeat(120)
    expect(runOffPrefill(b.canvas, vote(RESULTS, { title: long }), 3)?.title).toHaveLength(120)
  })
})

describe('the Voting panel', () => {
  const panel = (kit: ReturnType<typeof workshopKit>) =>
    renderToStaticMarkup(createElement(VotingPanel, { ctx: kit.ctx, close: () => {} }))
  const revealed = (results = RESULTS) => vote(results)

  it('with no results there is no chart and no actions (a vote not yet revealed shows no per-note counts)', async () => {
    const kit = workshopKit({ elements: ideas() })
    await loadWorkshop(kit, {
      timer: null,
      vote: vote([], {}, 'open') as never,
      serverNow: new Date().toISOString(),
    })
    const open = panel(kit)
    expect(open).not.toContain('vote-chart')
    expect(open).not.toContain('vote-result-bar')
    expect(open).not.toContain('vote-after')
    // closed, not revealed: still none
    await loadWorkshop(kit, {
      timer: null,
      vote: { ...vote([], {}, 'open'), session: { ...vote([]).session, status: 'closed' } } as never,
      serverNow: new Date().toISOString(),
    })
    expect(panel(kit)).not.toContain('vote-chart')
  })

  it('revealed: a ranked bar chart, each bar as long as its count says, ties sharing a rank', async () => {
    const kit = workshopKit({ elements: ideas() })
    await loadWorkshop(kit, {
      timer: null,
      vote: revealed([
        { shapeId: 'shape:n1', count: 4, rank: 1 },
        { shapeId: 'shape:n2', count: 4, rank: 1 },
        { shapeId: 'shape:n3', count: 2, rank: 3 },
      ]) as never,
      serverNow: new Date().toISOString(),
    })
    const h = panel(kit)
    expect(h).toContain('data-testid="vote-chart"')
    expect(h.match(/data-testid="vote-result-bar"/g)).toHaveLength(3)
    expect(h.match(/data-testid="vote-result-row"[^>]*data-rank="1"/g)).toHaveLength(2)
    expect(h).toMatch(/data-count="4" data-share="100"/)
    expect(h).toMatch(/data-count="2" data-share="50"/)
    expect(h).toMatch(/width:100%/)
    expect(h).toMatch(/width:50%/)
  })

  it('shows the facilitator what to do with the results; others see the chart only', async () => {
    const kit = workshopKit({ elements: ideas() })
    await loadWorkshop(kit, { timer: null, vote: revealed() as never, serverNow: new Date().toISOString() })
    const h = panel(kit)
    for (const id of [
      'vote-results-to-board',
      'vote-gather',
      'vote-runoff',
      'vote-gather-move',
      'vote-top-n',
    ])
      expect(h, id).toContain(`data-testid="${id}"`)
    const viewer = workshopKit({ role: 'viewer', elements: ideas() })
    await loadWorkshop(viewer, {
      timer: null,
      vote: revealed() as never,
      serverNow: new Date().toISOString(),
    })
    const v = panel(viewer)
    expect(v).toContain('data-testid="vote-chart"')
    expect(v).not.toContain('vote-after')
  })
})

describe('the setup dialog opened for a run-off', () => {
  it('the store carries the prefill while the dialog is open, and drops it when it closes', () => {
    const kit = workshopKit({ elements: ideas() })
    expect(kit.store.getSnapshot().setupPrefill).toBeNull()
    kit.store.openSetup({
      scope: 'selection',
      refs: ['shape:n1', 'shape:n2'],
      onePerObject: true,
      title: 'Run-off: X',
    })
    expect(kit.store.getSnapshot()).toMatchObject({
      setupOpen: true,
      setupPrefill: { scope: 'selection', refs: ['shape:n1', 'shape:n2'], onePerObject: true },
    })
    kit.store.setSetupOpen(false)
    expect(kit.store.getSnapshot()).toMatchObject({ setupOpen: false, setupPrefill: null })
    // the plain "Start a vote" opens with no prefill
    kit.store.setSetupOpen(true)
    expect(kit.store.getSnapshot().setupPrefill).toBeNull()
  })
})
