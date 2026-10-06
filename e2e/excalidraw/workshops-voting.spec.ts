// OWNER: 3f. Anonymous dot voting on the Excalidraw board page, ported from tests/workshops.spec.ts
// ("ballot privacy", "vote setup", "end without results"), tests/facilitation-review.fix.spec.ts
// (RETRO-06 keyboard voting, RETRO-08 the results card) and tests/workshops-2.fix.spec.ts (F3 + F17 the
// result badges; the vote CSV's export gate). alice = board owner and facilitator, bob = editor (may
// facilitate too), carol = viewer, dave = commenter. What a person sees is asserted in their browser; what
// the server stored and refuses through the API as that person; ballot privacy on the wire (every /api
// response, every server-sent event and the canvas socket's presence frames each browser received).
//
// Differences from the tldraw specs (docs/research/excalidraw/wave3/3F.md): elements are made through the
// board page's dev handle (one transact), their api refs are `shape:<elementId>`; "what the canvas socket
// says about selections" reads the Excalidraw presence frames' `sel` (the server drops it while a vote is
// open); a selection is read with the facade.
import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import {
  item,
  itemBounds,
  items,
  sceneToScreen,
  select,
  selection,
  selectNone,
  setTool,
  setViewport,
  stopTextEditing,
  tool,
  typeText,
  viewport,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { capture } from '../tests/support/screenshots.ts'
import {
  type ApiVoteState,
  closeWorkshopPopover,
  openWorkshopPopover,
  workshopState,
} from '../tests/support/workshops.ts'
import {
  badge,
  clickElement,
  dot,
  expect,
  expectItemsEverywhere,
  focusCanvas,
  markedShapeIds,
  post,
  reachableCenter,
  reloadBoard,
  seed,
  showAll,
  test,
  type WorkshopCanvasSession,
} from './workshops-kit.ts'

// ---- shared steps ----------------------------------------------------------------------------------------

/** The facilitator opens "Start a vote" from the top bar and starts one. */
async function startVoteFromTopBar(
  s: WorkshopCanvasSession,
  opts: { perPerson: number; onePerObject?: boolean; frameId?: string; notesOnly?: boolean },
) {
  const pop = await openWorkshopPopover(s.page)
  await pop.getByTestId('vote-start').click()
  await fillVoteSetup(s, opts)
}

async function fillVoteSetup(
  s: WorkshopCanvasSession,
  opts: { perPerson: number; onePerObject?: boolean; frameId?: string; notesOnly?: boolean },
) {
  const dialog = s.page.getByTestId('vote-setup-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('vote-per-person').fill(String(opts.perPerson))
  if (opts.onePerObject) await dialog.getByTestId('vote-one-per-object').check()
  if (opts.frameId) await dialog.getByTestId('vote-scope').selectOption(`shape:${opts.frameId}`)
  if (opts.notesOnly) await dialog.getByTestId('vote-types').selectOption('note')
  await dialog.getByTestId('vote-setup-submit').click()
  await expect(dialog).toHaveCount(0)
  // Starting a vote opens the voting panel for the facilitator.
  await expect(s.page.getByTestId('dock-panel-voting')).toBeVisible()
  await expect(s.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'open')
}

/** A participant accepts the join prompt; the voting bar then shows their allowance. */
async function joinVote(s: WorkshopCanvasSession, votes: number) {
  const prompt = s.page.getByTestId('vote-join-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText(`${votes} vote${votes === 1 ? '' : 's'}`)
  await prompt.getByTestId('vote-join').click()
  await expect(prompt).toHaveCount(0)
  await expect(s.page.getByTestId('vote-bar')).toBeVisible()
  await expect(s.page.getByTestId('vote-remaining')).toHaveAttribute('data-remaining', String(votes))
}

const remaining = (s: WorkshopCanvasSession) => s.page.getByTestId('vote-remaining')

async function openVotingPanel(page: Page) {
  const panel = page.getByTestId('dock-panel-voting')
  if (!(await panel.isVisible())) {
    const toggle = page.getByTestId('dock-rail-toggle')
    if (await toggle.isVisible()) await toggle.click()
    await page.getByTestId('dock-tab-voting').click()
  }
  await expect(panel).toBeVisible()
  return panel
}

// ---- [P0] ballot privacy + the whole vote ------------------------------------------------------------------

const NOTE = { alice: 'wk-alice-only', bob: 'wk-bob-only', shared: 'wk-shared', carol: 'wk-carol-only' }
const REF = Object.fromEntries(Object.entries(NOTE).map(([k, v]) => [k, `shape:${v}`])) as typeof NOTE

test('ballot privacy: before the reveal nobody receives anyone else’s ballot, then everyone sees the same ranked counts', async ({
  join,
  board,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  const everyone = [a, b, c]

  await seed(a.page, {
    notes: [
      { id: NOTE.alice, x: 0, y: 0, text: 'Alice idea' },
      { id: NOTE.bob, x: 260, y: 0, text: 'Bob idea' },
      { id: NOTE.shared, x: 520, y: 0, text: 'Shared idea' },
      { id: NOTE.carol, x: 780, y: 0, text: 'Carol idea' },
    ],
  })
  await expectItemsEverywhere(everyone, Object.values(NOTE))

  let sid = ''
  await test.step('alice starts a 3-dot vote; bob and carol join from the prompt', async () => {
    await startVoteFromTopBar(a, { perPerson: 3 })
    sid = (await workshopState(a.api, board)).vote?.session.id ?? ''
    expect(sid).toMatch(/^vot_/)
    await joinVote(b, 3)
    await joinVote(c, 3)
    for (const s of everyone) await showAll(s.page)
  })

  await test.step('everyone votes by clicking notes and sees only their own dots and allowance', async () => {
    await clickElement(a.page, NOTE.alice)
    await expect(dot(a.page, NOTE.alice)).toHaveAttribute('data-count', '1')
    await expect(remaining(a)).toHaveAttribute('data-remaining', '2')

    // bob: two on his note, one on the shared one (a different note in between, so none is a double-click)
    await clickElement(b.page, NOTE.bob)
    await expect(dot(b.page, NOTE.bob)).toHaveAttribute('data-count', '1')
    await clickElement(b.page, NOTE.shared)
    await expect(dot(b.page, NOTE.shared)).toHaveAttribute('data-count', '1')
    await clickElement(b.page, NOTE.bob)
    await expect(dot(b.page, NOTE.bob)).toHaveAttribute('data-count', '2')
    await expect(remaining(b)).toHaveAttribute('data-remaining', '0')
    await expect(remaining(b)).toHaveText('0 of 3 left')
    // a 4th vote is refused with a message, and nothing changes
    await clickElement(b.page, NOTE.shared)
    await expect(b.page.getByTestId('vote-toast')).toContainText('used all your votes')
    await expect(dot(b.page, NOTE.shared)).toHaveAttribute('data-count', '1')
    // Voting clicks do not select (a selection is presence that everyone sees).
    expect(await selection(b.page)).toEqual([])

    await clickElement(c.page, NOTE.shared)
    await expect(dot(c.page, NOTE.shared)).toHaveAttribute('data-count', '1')
    await clickElement(c.page, NOTE.carol)
    await expect(dot(c.page, NOTE.carol)).toHaveAttribute('data-count', '1')
    await expect(remaining(c)).toHaveAttribute('data-remaining', '1')
    await c.page.getByTestId('vote-done').click()
    await expect(c.page.getByTestId('vote-bar')).toContainText("You're done voting.")
    await expect(c.page.getByTestId('vote-undone')).toBeVisible()
  })

  await test.step('the facilitator sees totals and "N of M done", but no per-note counts', async () => {
    const panel = await openVotingPanel(a.page)
    await expect(panel.getByTestId('vote-progress')).toHaveText('1 of 3 done · 6 votes cast')
    await expect(a.page.getByTestId('vote-count')).toHaveCount(0)
    await expect(a.page.getByTestId('vote-result-row')).toHaveCount(0)
    await expect(panel.getByTestId('vote-mine-row')).toHaveCount(1)
    // bob may facilitate too (editor): same totals, nothing per note
    const bobPanel = await openVotingPanel(b.page)
    await expect(bobPanel.getByTestId('vote-progress')).toHaveText('1 of 3 done · 6 votes cast')
    // carol (viewer) has no facilitator view at all
    const carolPanel = await openVotingPanel(c.page)
    await expect(carolPanel.getByTestId('vote-current')).toBeVisible()
    await expect(carolPanel.getByTestId('vote-facilitator')).toHaveCount(0)
    await expect(carolPanel.getByTestId('vote-progress')).toHaveCount(0)
    await capture('lc-workshops-vote-facilitator.png', a.page, testInfo)
  })

  await test.step('bob reloads: his own dots come back from the server, nobody else’s', async () => {
    await reloadBoard(b)
    await showAll(b.page)
    await expect(dot(b.page, NOTE.bob)).toHaveAttribute('data-count', '2')
    await expect(dot(b.page, NOTE.shared)).toHaveAttribute('data-count', '1')
    await expect(remaining(b)).toHaveAttribute('data-remaining', '0')
    await expect(b.page.getByTestId('vote-join-prompt')).toHaveCount(0)
    await openVotingPanel(b.page)
  })

  await test.step('before the reveal: no DOM, response or event anywhere carries another person’s ballot', async () => {
    const bobView = (await workshopState(b.api, board)).vote as ApiVoteState
    expect(bobView.myVotes).toEqual({ [REF.bob]: 2, [REF.shared]: 1 })
    expect(bobView.results).toBeNull()
    expect(bobView.totalVotesCast).toBe(6)
    const carolView = (await workshopState(c.api, board)).vote as ApiVoteState
    expect(carolView.myVotes).toEqual({ [REF.shared]: 1, [REF.carol]: 1 })
    expect(carolView.done).toBe(true)
    for (const s of everyone) {
      const res = await s.api.fetch('GET', `/api/votes/${sid}/results`)
      expect(res.status(), `${s.user}: results before reveal`).toBe(409)
    }

    // DOM, over the whole session: only one's own notes ever carried a vote marker.
    expect(await markedShapeIds(a.page)).toEqual([REF.alice])
    expect(await markedShapeIds(b.page)).toEqual([REF.bob, REF.shared].sort())
    expect(await markedShapeIds(c.page)).toEqual([REF.carol, REF.shared].sort())

    // The wire: nothing any browser received names a note only someone else voted on.
    expect(await a.net.containing([REF.bob, REF.shared, REF.carol])).toEqual([])
    expect(await b.net.containing([REF.alice, REF.carol])).toEqual([])
    expect(await c.net.containing([REF.alice, REF.bob])).toEqual([])
    expect((await b.net.containing([REF.bob])).length).toBeGreaterThan(0)
    expect(b.net.eventsOf('workshop.vote').length).toBeGreaterThan(0)
    expect(b.net.responses.some((r) => r.path === `/api/boards/${board}/workshop`)).toBe(true)
    expect(b.net.responses.some((r) => r.path === `/api/boards/${board}/votes`)).toBe(true)
    expect(b.net.eventsOf('workshop.vote.results')).toEqual([])
    const AGGREGATE_KEYS = [
      'endsAt',
      'participants',
      'participantsDone',
      'sessionId',
      'status',
      'totalVotesCast',
    ]
    for (const s of everyone) {
      for (const e of s.net.eventsOf('workshop.vote'))
        expect(Object.keys(e.data as object).sort(), `${s.user}: ${e.raw}`).toEqual(AGGREGATE_KEYS)
    }
    // Ballots never travel on the canvas socket either: not as vote data, and not as presence.
    expect(b.net.wsFrames.length).toBeGreaterThan(0)
    expect(b.net.wsFrames.filter((f) => f.includes(sid) || f.includes('myVotes'))).toEqual([])
    const voted = Object.values(REF)
    for (const s of everyone) {
      expect(
        s.net.presenceSelections().filter((id) => voted.includes(id)),
        `${s.user}: other people's selections on voted notes`,
      ).toEqual([])
    }
  })

  const expected = [
    { shapeId: REF.bob, count: 2, rank: 1 },
    { shapeId: REF.shared, count: 2, rank: 1 },
    { shapeId: REF.alice, count: 1, rank: 3 },
    { shapeId: REF.carol, count: 1, rank: 3 },
  ]

  await test.step('alice reveals (twice is one result): counts on the notes and a ranked list for everyone', async () => {
    await a.page.getByTestId('vote-reveal').click()
    const again = await post(a, `/api/votes/${sid}/reveal`)
    expect(again.status()).toBe(200)
    expect(((await again.json()) as ApiVoteState).results).toEqual(expected)

    for (const s of everyone) {
      await expect(s.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'revealed')
      for (const r of expected) {
        const id = r.shapeId.slice('shape:'.length)
        await expect(badge(s.page, id), `${s.user}: badge on ${id}`).toHaveAttribute(
          'data-rank',
          String(r.rank),
        )
        await expect(badge(s.page, id)).toContainText(String(r.count))
      }
      const rows = s.page.getByTestId('vote-results').getByTestId('vote-result-row')
      await expect(rows).toHaveCount(4)
      expect(
        await rows.evaluateAll((els) =>
          els.map((e) => ({
            shapeId: e.getAttribute('data-shape-id'),
            rank: Number(e.getAttribute('data-rank')),
          })),
        ),
      ).toEqual(expected.map((r) => ({ shapeId: r.shapeId, rank: r.rank })))
      await expect(s.page.getByTestId('vote-results')).toContainText('6 votes from 3 people')
    }
    await expect.poll(() => b.net.eventsOf('workshop.vote.results').length).toBe(1)
    const [resultsEvent] = b.net.eventsOf('workshop.vote.results')
    expect((resultsEvent?.data as { results?: unknown } | undefined)?.results).toEqual(expected)
    const stored = await c.api.fetch('GET', `/api/votes/${sid}/results`)
    expect(stored.status()).toBe(200)
    expect(((await stored.json()) as { results: unknown }).results).toEqual(expected)
    await showAll(c.page)
    await capture('lc-workshops-vote-revealed.png', c.page, testInfo)
  })

  await test.step('control: the same recorders do see these ids once they are meant to arrive', async () => {
    expect((await b.net.containing([REF.alice])).length).toBeGreaterThan(0)
    expect((await b.net.containing([REF.carol])).length).toBeGreaterThan(0)
    expect(await markedShapeIds(b.page)).toEqual(Object.values(REF).sort())
    // A deliberate selection (not a vote) is presence, and reaches the others.
    await select(b.page, [NOTE.carol])
    await expect.poll(() => a.net.presenceSelections()).toContain(REF.carol)
  })

  await test.step('the results persist: carol reloads and still sees the badges and ranking', async () => {
    await reloadBoard(c)
    await showAll(c.page)
    for (const r of expected) await expect(badge(c.page, r.shapeId.slice(6))).toContainText(String(r.count))
    await openVotingPanel(c.page)
    await expect(c.page.getByTestId('vote-results').getByTestId('vote-result-row')).toHaveCount(4)
  })

  await test.step('the ranking downloads as CSV', async () => {
    const title = (await a.api.getBoard(board)).board.title
    const download = a.page.waitForEvent('download')
    await a.page.getByTestId('vote-results-csv').click()
    const file = await download
    expect(file.suggestedFilename()).toBe(`${title} - Dot vote.csv`)
    expect(readFileSync(await file.path(), 'utf8').split('\r\n')).toEqual([
      'Rank,Votes,Object type,Text,Object id',
      `1,2,Sticky note,Bob idea,${REF.bob}`,
      `1,2,Sticky note,Shared idea,${REF.shared}`,
      `3,1,Sticky note,Alice idea,${REF.alice}`,
      `3,1,Sticky note,Carol idea,${REF.carol}`,
      '',
    ])
  })
})

// ---- [P1] vote setup: frame scope, one per object, sticky notes only ------------------------------------------

const FRAME = 'wk-frame'
const IN1 = 'wk-in-1'
const IN2 = 'wk-in-2'
const GEO_IN = 'wk-geo-in'
const IN3 = 'wk-in-3'
const OUT = 'wk-out'

test('vote setup: one vote per object on sticky notes inside one frame; the server refuses what the UI prevents; "I’m done" shows in the progress', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')

  await seed(a.page, {
    frames: [{ id: FRAME, x: 0, y: 0, w: 820, h: 620, name: 'Ideas' }],
    shapes: [{ id: GEO_IN, kind: 'rectangle', x: 580, y: 80, w: 200, h: 200, frameId: FRAME }],
    notes: [
      { id: IN1, x: 40, y: 80, text: 'Inside one', frameId: FRAME },
      { id: IN2, x: 310, y: 80, text: 'Inside two', frameId: FRAME },
      { id: IN3, x: 40, y: 340, text: 'Inside three', frameId: FRAME },
      { id: OUT, x: 1000, y: 80, text: 'Outside' },
    ],
  })
  await expectItemsEverywhere([a, b, c], [FRAME, GEO_IN, IN1, IN2, IN3, OUT])

  await test.step('alice sets up the vote; the server stores exactly that', async () => {
    await startVoteFromTopBar(a, { perPerson: 3, onePerObject: true, frameId: FRAME, notesOnly: true })
    const v = (await workshopState(b.api, board)).vote as ApiVoteState
    expect(v.session).toMatchObject({
      status: 'open',
      votesPerPerson: 3,
      onePerObject: true,
      scope: 'frame',
      frameId: `shape:${FRAME}`,
      shapeTypes: ['note'],
    })
    await expect(a.page.getByTestId('vote-current')).toContainText('one per object')
    await expect(a.page.getByTestId('vote-current')).toContainText('sticky notes only')
    await expect(a.page.getByTestId('vote-current')).toContainText('in frame “Ideas”')
  })

  await test.step('bob can only vote on notes inside the frame, once each', async () => {
    await expect(b.page.getByTestId('vote-join-prompt')).toContainText('objects in one frame')
    await joinVote(b, 3)
    await showAll(b.page)
    await clickElement(b.page, OUT) // outside the frame: nothing
    await clickElement(b.page, GEO_IN) // not a sticky note: nothing
    await clickElement(b.page, IN1)
    await expect(dot(b.page, IN1)).toHaveAttribute('data-count', '1')
    await expect(remaining(b)).toHaveAttribute('data-remaining', '2')
    await clickElement(b.page, IN2)
    await expect(dot(b.page, IN2)).toHaveAttribute('data-count', '1')
    await clickElement(b.page, IN1) // a second dot on the same note
    await expect(b.page.getByTestId('vote-toast')).toContainText('One vote per object')
    await expect(dot(b.page, IN1)).toHaveAttribute('data-count', '1')
    await expect(remaining(b)).toHaveAttribute('data-remaining', '1')
    expect(await markedShapeIds(b.page)).not.toContain(`shape:${OUT}`)
    expect(await markedShapeIds(b.page)).not.toContain(`shape:${GEO_IN}`)
  })

  await test.step('forged casts outside the rules are refused by the server', async () => {
    const sid = (await workshopState(b.api, board)).vote?.session.id ?? ''
    const cast = (id: string) => post(b, `/api/votes/${sid}/cast`, { shapeId: `shape:${id}`, delta: 1 })
    for (const [id, code] of [
      [OUT, 'NOT_ELIGIBLE'],
      [GEO_IN, 'NOT_ELIGIBLE'],
      [FRAME, 'NOT_ELIGIBLE'],
    ] as const) {
      const res = await cast(id)
      expect(res.status(), id).toBe(400)
      expect(await res.text()).toContain(code)
    }
    const twice = await cast(IN1)
    expect(twice.status()).toBe(409)
    expect(await twice.text()).toContain('ONE_PER_OBJECT')
    const v = (await workshopState(b.api, board)).vote as ApiVoteState
    expect(v.myVotes).toEqual({ [`shape:${IN1}`]: 1, [`shape:${IN2}`]: 1 })
    expect(v.myRemaining).toBe(1)
  })

  await test.step('while voting, a plain drag on a note neither moves it nor votes; Shift+drag moves it', async () => {
    const x0 = (await b.page.evaluate((id) => window.lobbyCanvas?.get(id)?.x, IN3)) ?? Number.NaN
    const from = await reachableCenter(b.page, IN3)
    const drag = async (shift: boolean) => {
      if (shift) await b.page.keyboard.down('Shift')
      await b.page.mouse.move(from.x, from.y)
      await b.page.mouse.down()
      await b.page.mouse.move(from.x + 30, from.y + 4, { steps: 4 })
      await b.page.mouse.move(from.x + 60, from.y + 8, { steps: 4 })
      await b.page.mouse.up()
      if (shift) await b.page.keyboard.up('Shift')
    }
    await drag(false)
    expect(await b.page.evaluate((id) => window.lobbyCanvas?.get(id)?.x, IN3)).toBe(x0)
    expect((await workshopState(b.api, board)).vote?.myVotes).toEqual({
      [`shape:${IN1}`]: 1,
      [`shape:${IN2}`]: 1,
    })
    await drag(true)
    await expect
      .poll(async () => (await a.page.evaluate((id) => window.lobbyCanvas?.get(id)?.x, IN3)) ?? x0)
      .toBeGreaterThan(x0 + 20)
    expect((await workshopState(b.api, board)).vote?.myVotes).toEqual({
      [`shape:${IN1}`]: 1,
      [`shape:${IN2}`]: 1,
    })
    await selectNone(b.page)
  })

  await test.step('carol votes and says she is done; alice sees "N of M done"', async () => {
    await joinVote(c, 3)
    await showAll(c.page)
    await clickElement(c.page, IN2)
    await expect(dot(c.page, IN2)).toHaveAttribute('data-count', '1')
    await c.page.getByTestId('vote-done').click()
    await expect(c.page.getByTestId('vote-bar')).toContainText("You're done voting.")
    await expect(a.page.getByTestId('vote-progress')).toHaveText('1 of 2 done · 3 votes cast')
    await b.page.getByTestId('vote-done').click()
    await expect(a.page.getByTestId('vote-progress')).toHaveText('2 of 2 done · 3 votes cast')
    // Done: clicks are ordinary again (they select, they do not vote).
    await selectNone(b.page)
    await clickElement(b.page, OUT)
    await expect.poll(() => selection(b.page)).toEqual([OUT])
    expect((await workshopState(b.api, board)).vote?.myVotes).toEqual({
      [`shape:${IN1}`]: 1,
      [`shape:${IN2}`]: 1,
    })
    // "Keep voting" takes it back.
    await b.page.getByTestId('vote-undone').click()
    await expect(a.page.getByTestId('vote-progress')).toHaveText('1 of 2 done · 3 votes cast')
    expect((await workshopState(a.api, board)).vote).toMatchObject({ participantsDone: 1, participants: 2 })
  })
})

// ---- [P1] end without results; roles -----------------------------------------------------------------------

test('end without results: casting stops, results stay hidden and the vote is listed as past; viewers and commenters vote but cannot facilitate', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const c = await join('carol', 'viewer')
  const d = await join('dave', 'commenter')
  const N1 = 'wk-end-1'
  const N2 = 'wk-end-2'
  await seed(a.page, {
    notes: [
      { id: N1, x: 0, y: 0, text: 'First' },
      { id: N2, x: 300, y: 0, text: 'Second' },
    ],
  })
  await expectItemsEverywhere([a, c, d], [N1, N2])

  let sid = ''
  await test.step('alice starts a vote from the voting panel; carol (viewer) and dave (commenter) vote', async () => {
    const panel = await openVotingPanel(a.page)
    await expect(panel).toContainText('No votes on this board yet.')
    await panel.getByTestId('vote-start-panel').click()
    await fillVoteSetup(a, { perPerson: 2 })
    sid = (await workshopState(a.api, board)).vote?.session.id ?? ''
    for (const s of [c, d]) {
      await joinVote(s, 2)
      await showAll(s.page)
    }
    await clickElement(c.page, N1)
    await expect(dot(c.page, N1)).toHaveAttribute('data-count', '1')
    await clickElement(d.page, N2)
    await expect(dot(d.page, N2)).toHaveAttribute('data-count', '1')
  })

  await test.step('viewer and commenter have no facilitator controls, and the API refuses forged ones', async () => {
    for (const s of [c, d]) {
      const pop = await openWorkshopPopover(s.page)
      for (const id of ['timer-start', 'vote-start', 'summon-button'])
        await expect(pop.getByTestId(id), `${s.user}: ${id}`).toHaveCount(0)
      await expect(pop.getByTestId('vote-open-panel')).toBeVisible()
      await closeWorkshopPopover(s.page)
      const panel = await openVotingPanel(s.page)
      await expect(panel.getByTestId('vote-current')).toHaveAttribute('data-status', 'open')
      for (const id of ['vote-facilitator', 'vote-progress', 'vote-reveal', 'vote-close'])
        await expect(panel.getByTestId(id), `${s.user}: ${id}`).toHaveCount(0)
      for (const [path, body] of [
        [`/api/boards/${board}/timer`, { action: 'start', durationMs: 60_000 }],
        [`/api/boards/${board}/votes`, { votesPerPerson: 1, onePerObject: false, scope: 'board' }],
        [`/api/votes/${sid}/reveal`, {}],
        [`/api/votes/${sid}/close`, {}],
        [`/api/votes/${sid}/extend`, { addMs: 60_000 }],
        [`/api/boards/${board}/summon`, {}],
      ] as const) {
        expect((await post(s, path, body)).status(), `${s.user}: POST ${path}`).toBe(403)
      }
    }
    const v = (await workshopState(a.api, board)).vote as ApiVoteState
    expect(v.session.status).toBe('open')
    // RT-03 (wave J3): an open vote's counts move once per counting window (5 s), not at each cast
    await expect
      .poll(async () => ((await workshopState(a.api, board)).vote as ApiVoteState).totalVotesCast, {
        timeout: 15_000,
      })
      .toBe(2)
    expect((await workshopState(a.api, board)).timer).toBeNull()
  })

  await test.step('alice ends it without results: no more casting, nothing revealed', async () => {
    await a.page.getByTestId('vote-close').click()
    for (const s of [a, c, d])
      await expect(s.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'closed')
    await expect(c.page.getByTestId('vote-bar')).toHaveCount(0)
    await expect(c.page.getByTestId('vote-current')).toContainText('results stay hidden')
    await clickElement(c.page, N2)
    await expect(c.page.getByTestId('vote-dot')).toHaveCount(0)
    const cast = await post(c, `/api/votes/${sid}/cast`, { shapeId: `shape:${N2}`, delta: 1 })
    expect(cast.status()).toBe(409)
    expect(await cast.text()).toContain('VOTE_CLOSED')
    for (const s of [a, c, d]) {
      expect((await s.api.fetch('GET', `/api/votes/${sid}/results`)).status(), s.user).toBe(409)
      await expect(s.page.getByTestId('vote-count')).toHaveCount(0)
    }
    const v = (await workshopState(c.api, board)).vote as ApiVoteState
    expect(v.session.status).toBe('closed')
    expect(v.results).toBeNull()
    expect(v.myVotes).toEqual({ [`shape:${N1}`]: 1 })
  })

  await test.step('alice starts a new vote from the panel; the ended one is listed under past votes', async () => {
    const panel = await openVotingPanel(a.page)
    await panel.getByTestId('vote-start-panel').click()
    await fillVoteSetup(a, { perPerson: 1 })
    const newSid = (await workshopState(a.api, board)).vote?.session.id ?? ''
    expect(newSid).not.toBe(sid)
    await panel.getByTestId('vote-history').locator('summary').click()
    const row = panel.locator(`[data-testid="vote-history-row"][data-session-id="${sid}"]`)
    await expect(row).toBeVisible()
    await expect(row).toContainText('2 votes')
    await expect(row).toContainText('Not revealed')
    await expect(c.page.getByTestId('vote-join-prompt')).toContainText('1 vote')
  })
})

// ---- RETRO-06 keyboard voting, RETRO-08 the results card (facilitation-review.fix) ---------------------------

const NOTES = ['fr-v1', 'fr-v2', 'fr-v3']

async function addVoteNotes(page: Page) {
  await seed(page, {
    notes: NOTES.map((id, i) => ({ id, x: i * 260, y: 0, text: ['Alpha', 'Beta', 'Gamma'][i] ?? '' })),
  })
  await showAll(page)
}

async function startVoteByApi(s: WorkshopCanvasSession, board: string) {
  const res = await post(s, `/api/boards/${board}/votes`, {
    title: 'Pick a direction',
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(res.status()).toBeLessThan(300)
  return ((await res.json()) as { session: { id: string } }).session.id
}

test('RETRO-06: a keyboard-only participant votes: Tab to an object’s +, Enter/Space, Tab to the next object, until 0 of 3 left', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'viewer')
  await addVoteNotes(a.page)
  await expectItemsEverywhere([b], NOTES)
  await showAll(b.page)
  await startVoteByApi(a, board)

  const prompt = b.page.getByTestId('vote-join-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt.getByTestId('vote-keys-hint')).toContainText('Tab')
  await prompt.getByTestId('vote-join').press('Enter')
  await expect(b.page.getByTestId('vote-remaining')).toHaveText('3 of 3 left')

  const announce = b.page.getByTestId('vote-announce')
  const focused = () => b.page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)
  await focusCanvas(b.page)
  await b.page.keyboard.press('Tab')
  await expect.poll(() => selection(b.page)).toEqual([NOTES[0]])
  await expect.poll(focused).toBe('vote-plus')
  await b.page.keyboard.press('Enter')
  await expect(announce).toHaveText('Voted. 2 of 3 left')
  await b.page.keyboard.press(' ')
  await expect(announce).toHaveText('Voted. 1 of 3 left')
  await b.page.keyboard.press('Tab')
  await expect.poll(() => selection(b.page)).toEqual([NOTES[1]])
  await expect.poll(focused).toBe('vote-plus')
  await b.page.keyboard.press('Enter')
  await expect(announce).toHaveText('Voted. 0 of 3 left')
  await expect(b.page.getByTestId('vote-remaining')).toHaveText('0 of 3 left')
  // The keyboard is still in the stepper (the + cannot act now, but keeps the focus).
  expect(await focused()).toBe('vote-plus')
  await b.page.keyboard.press('Escape')
  await expect.poll(() => b.page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)

  const mine = await workshopState(b.api, board)
  expect(mine.vote?.myRemaining).toBe(0)
  expect(mine.vote?.myVotes).toEqual({ [`shape:${NOTES[0]}`]: 2, [`shape:${NOTES[1]}`]: 1 })
  // Enter and Space never started editing a note or changed the board.
  expect(await b.page.evaluate(() => window.lobbyCanvas?.editingId() ?? null)).toBeNull()
  expect(
    await b.page.evaluate(() => window.lobbyCanvas?.items().filter((e) => e.type === 'stickynote').length),
  ).toBe(3)
})

test('RETRO-08 + RETRO-23a: when Maya ends the vote, bob sees the top-3 card within 2 s, and "See all results" opens the Voting panel', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await addVoteNotes(a.page)
  await expectItemsEverywhere([b], NOTES)

  await test.step('the vote-setup selects have room around their text', async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('vote-start').click()
    const dialog = a.page.getByTestId('vote-setup-dialog')
    for (const id of ['vote-scope', 'vote-types', 'vote-duration']) {
      const pad = await dialog.getByTestId(id).evaluate((el) => {
        const cs = getComputedStyle(el)
        return { left: Number.parseFloat(cs.paddingLeft), right: Number.parseFloat(cs.paddingRight) }
      })
      expect(pad.left).toBeGreaterThanOrEqual(10)
      expect(pad.right).toBeGreaterThanOrEqual(24)
    }
    await dialog.getByTestId('vote-setup-submit').click()
    await expect(dialog).toHaveCount(0)
  })

  const sid = (await workshopState(a.api, board)).vote?.session.id ?? ''
  for (const [id, n] of [
    [NOTES[1], 2],
    [NOTES[0], 1],
  ] as const) {
    for (let i = 0; i < n; i++)
      expect((await post(b, `/api/votes/${sid}/cast`, { shapeId: `shape:${id}`, delta: 1 })).status()).toBe(
        200,
      )
  }
  await expect(a.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'open')
  const started = Date.now()
  await a.page.getByTestId('vote-reveal').click()
  const card = b.page.getByTestId('vote-results-card')
  await expect(card).toBeVisible({ timeout: 2_000 })
  expect(Date.now() - started).toBeLessThan(2_000)
  await expect(card).toContainText('Results are in')
  const rows = card.getByTestId('vote-results-card-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Beta')
  await expect(rows.nth(0)).toContainText('2')
  await expect(rows.nth(1)).toContainText('Alpha')
  await card.getByTestId('vote-results-card-all').click()
  await expect(b.page.getByTestId('dock-panel-voting')).toBeVisible()
  await expect(b.page.getByTestId('vote-results')).toBeVisible()
  await expect(card).toHaveCount(0)
})

// ---- F3 + F17: the result badges (workshops-2.fix) ------------------------------------------------------------

const EIGHT = Array.from({ length: 8 }, (_, i) => `vote${i}`)

/** Puts scene point `p` at the client point `at` with zoom `z` (no animation). */
async function pinPoint(page: Page, p: { x: number; y: number }, at: { x: number; y: number }, z: number) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  await setViewport(page, { x: p.x - (at.x - box.x) / z, y: p.y - (at.y - box.y) / z, zoom: z })
}

test('vote results: badges shrink (to a minimum size) and group when zoomed out, stay under the workshop popover, and read well', async ({
  join,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  const a = alice.page
  await seed(a, {
    frames: [{ id: 'retro', x: 0, y: 0, w: 1000, h: 560, name: 'Retro' }],
    notes: EIGHT.map((id, i) => ({
      id,
      x: 40 + (i % 4) * 224,
      y: 40 + Math.floor(i / 4) * 240,
      text: `Idea ${i}\nOwner: producer`,
      frameId: 'retro',
    })),
  })
  await expectItemsEverywhere([bob], EIGHT)

  const created = await post(alice, `/api/boards/${board}/votes`, {
    votesPerPerson: 5,
    onePerObject: false,
    scope: 'board',
  })
  expect(created.status(), await created.text()).toBe(201)
  const sid = (await workshopState(alice.api, board)).vote?.session.id ?? ''

  await test.step('F17: before anyone votes, the facilitator reads "Waiting for votes"', async () => {
    const panel = await openVotingPanel(a)
    await expect.soft(panel.getByTestId('vote-progress')).toHaveText('Waiting for votes')
  })

  for (const [s, picks] of [
    [alice, [0, 0, 1, 2, 3]],
    [bob, [0, 4, 5, 6, 7]],
  ] as const) {
    for (const i of picks) {
      const res = await post(s, `/api/votes/${sid}/cast`, { shapeId: `shape:${EIGHT[i]}`, delta: 1 })
      expect(res.status(), await res.text()).toBe(200)
    }
  }
  expect((await post(alice, `/api/votes/${sid}/reveal`)).status()).toBe(200)
  const singles = a.locator('.dr-wk-badge[data-testid="vote-count"]')
  await expect(singles).toHaveCount(8)

  await test.step('F17: a note’s lines are joined with " · " in the ranking', async () => {
    const panel = await openVotingPanel(a)
    const first = panel.getByTestId('vote-results').getByTestId('vote-result-row').first()
    await expect.soft(first).toContainText('Idea 0 · Owner: producer')
    await a.getByTestId('dock-tab-voting').click() // close the panel: the whole canvas is free
  })

  await test.step('F3: at 100% every badge is full size and on its own', async () => {
    await pinPoint(a, { x: 0, y: 0 }, { x: 80, y: 120 }, 1)
    await expect(a.getByTestId('vote-count-group')).toHaveCount(0)
    const h = await singles.first().evaluate((el) => el.getBoundingClientRect().height)
    expect(h).toBeCloseTo(28, 0)
  })

  await test.step('F3: under the workshop popover, the popover wins', async () => {
    const card = a.getByTestId('vote-results-card')
    await expect(card).toBeVisible()
    const pop = await openWorkshopPopover(a)
    const box = await pop.boundingBox()
    if (!box) throw new Error('no popover box')
    const note0 = await a.evaluate((id) => window.lobbyCanvas?.bounds(id), EIGHT[0] as string)
    if (!note0) throw new Error('no note bounds')
    await pinPoint(
      a,
      { x: note0.x + note0.width, y: note0.y },
      { x: box.x + box.width / 2, y: box.y + 140 },
      1,
    )
    await capture('lc-vote-badges-under-popover.png', a, testInfo)
    const badgeEl = a.locator(`.dr-wk-badge[data-shape-id="shape:${EIGHT[0]}"]`)
    await expect(badgeEl).toHaveCount(1)
    const bb = await badgeEl.boundingBox()
    if (!bb) throw new Error('no badge box')
    const on = await a.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y)
        return {
          inPopover: !!el?.closest('[data-testid="workshop-popover"]'),
          badge: !!el?.closest('.dr-wk-badge'),
        }
      },
      { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 },
    )
    expect(on).toEqual({ inPopover: true, badge: false })
    await a.keyboard.press('Escape')
  })

  await test.step('F3: zoomed out, badges shrink and group so none overlaps another', async () => {
    await pinPoint(a, { x: 0, y: 0 }, { x: 300, y: 300 }, 0.12)
    await expect(a.locator('.dr-wk-badge').first()).toBeVisible()
    await capture('lc-vote-badges-zoomed-out.png', a, testInfo)
    const groups = a.getByTestId('vote-count-group')
    await expect(groups.first()).toBeVisible()
    const boxes = await a
      .locator('.dr-wk-badge')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect))
    // R2-10 (wave C3): a badge shrinks with the zoom but keeps its figure at about 11 px (85 % of full size)
    for (const r of boxes) {
      expect(r.height).toBeLessThanOrEqual(28 + 1)
      expect(r.height).toBeGreaterThanOrEqual(28 * 0.85 - 1)
    }
    const overlap = (p: DOMRect, q: DOMRect) =>
      p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++)
        expect(overlap(boxes[i] as DOMRect, boxes[j] as DOMRect), `badges ${i} and ${j} overlap`).toBe(false)
    await expect(a.locator('[data-testid="vote-count"]')).toHaveCount(8)
    await expect(groups.first()).toHaveAttribute('aria-label', /results here, \d+ votes in all/)
    // A group zooms in to what it stands for, where the badges come apart again.
    const before = (await viewport(a)).zoom
    await groups.first().click()
    await expect.poll(async () => (await viewport(a)).zoom).toBeGreaterThan(before * 2)
  })
})

// ---- the vote pointer tool (new on this page: docs/research/excalidraw/wave3/3F.md D7) ------------------------

test('the vote tool: for a viewer too, a click on an object casts a dot and selects nothing; a drag casts nothing', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const c = await join('carol', 'viewer')
  await seed(a.page, { notes: [{ id: 'wk-tool-1', x: 0, y: 0, text: 'Tool' }] })
  await expectItemsEverywhere([c], ['wk-tool-1'])
  await post(a, `/api/boards/${board}/votes`, { votesPerPerson: 2, onePerObject: false, scope: 'board' })
  await joinVote(c, 2)
  await showAll(c.page)
  expect(await setTool(c.page, 'vote')).toBe(true)
  expect(await tool(c.page)).toBe('vote')
  const at = await reachableCenter(c.page, 'wk-tool-1')
  await c.page.mouse.move(at.x, at.y)
  await c.page.mouse.down()
  await c.page.mouse.move(at.x + 40, at.y + 30, { steps: 4 })
  await c.page.mouse.up()
  await expect(remaining(c)).toHaveAttribute('data-remaining', '2')
  await c.page.mouse.click(at.x, at.y)
  await expect(dot(c.page, 'wk-tool-1')).toHaveAttribute('data-count', '1')
  await expect(remaining(c)).toHaveAttribute('data-remaining', '1')
  expect(await selection(c.page)).toEqual([])
  expect(await setTool(c.page, 'select')).toBe(true)
})

// ---- W5-03: the topmost object decides what a click votes on -------------------------------------------------

const OV = { frame: 'wk-ov-frame', inside: 'wk-ov-in', under: 'wk-ov-under', loose: 'wk-ov-loose' }

/** The screen point of a scene point, checked to reach the canvas (no overlay or bar on top). */
async function canvasPoint(page: Page, p: { x: number; y: number }) {
  const at = await sceneToScreen(page, p)
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return el?.tagName === 'CANVAS' && !!el.closest('.excalidraw')
  }, at)
  expect(hit, `the canvas is under ${JSON.stringify(at)}`).toBe(true)
  return at
}

test('W5-03: a click on a note the vote does not take, lying over one it takes, casts nothing and says so (select and hand tools, the vote tool); only clicked notes are ranked', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, {
    frames: [{ id: OV.frame, x: 0, y: 0, w: 900, h: 600, name: 'Ideas' }],
    notes: [
      { id: OV.inside, x: 40, y: 80, text: 'Nice trailer music', frameId: OV.frame },
      { id: OV.under, x: 340, y: 80, text: 'Pairing on the boss fight', frameId: OV.frame },
      // on top of the right half of OV.under, outside the vote's frame (a note made with N stays out of
      // its frame until W5-01 lands; any note outside the frame lying over one inside does the same)
      { id: OV.loose, x: 460, y: 140, text: 'Daily build was green' },
    ],
  })
  await expectItemsEverywhere([a, b], Object.values(OV))
  const under = await itemBounds(b.page, OV.under)
  const loose = await itemBounds(b.page, OV.loose)
  if (!under || !loose) throw new Error('no bounds')
  // the setup: the loose note paints above the frame's note, and only the frame's note is in the frame
  const order = (await items(b.page)).map((e) => e.id)
  expect(order.indexOf(OV.loose)).toBeGreaterThan(order.indexOf(OV.under))
  expect((await item(b.page, OV.under))?.frameId).toBe(OV.frame)
  expect((await item(b.page, OV.loose))?.frameId ?? null).toBeNull()
  const overlap = { x: (loose.x + under.x + under.width) / 2, y: (loose.y + under.y + under.height) / 2 }
  expect(overlap.x).toBeGreaterThan(loose.x)
  expect(overlap.x).toBeLessThan(under.x + under.width)
  expect(overlap.y).toBeGreaterThan(loose.y)
  expect(overlap.y).toBeLessThan(under.y + under.height)
  const underOnly = { x: under.x + 30, y: under.y + under.height / 2 }
  expect(underOnly.x).toBeLessThan(loose.x)

  await startVoteFromTopBar(a, { perPerson: 3, frameId: OV.frame, notesOnly: true })
  await joinVote(b, 3)
  await showAll(b.page)
  const toast = b.page.getByTestId('vote-toast')
  const NOT_IN = 'Not part of this vote: only sticky notes in “Ideas” take votes.'
  const noVotesYet = async () => {
    await expect(remaining(b)).toHaveAttribute('data-remaining', '3')
    expect((await workshopState(b.api, board)).vote?.myVotes).toEqual({})
    await expect(dot(b.page, OV.under)).toHaveCount(0)
    await expect(dot(b.page, OV.loose)).toHaveCount(0)
  }
  const dismiss = async () => {
    await toast.getByRole('button', { name: 'Dismiss' }).click()
    await expect(toast).toHaveCount(0)
  }

  await test.step('select tool: a click on the loose note over the frame’s note casts nothing, and says why', async () => {
    const at = await canvasPoint(b.page, overlap)
    await b.page.mouse.click(at.x, at.y)
    await expect(toast).toHaveText(NOT_IN)
    await noVotesYet()
    await dismiss()
  })

  await test.step('hand tool and the vote tool: the same click casts nothing either', async () => {
    for (const name of ['hand', 'vote']) {
      expect(await setTool(b.page, name)).toBe(true)
      const at = await canvasPoint(b.page, overlap)
      await b.page.mouse.click(at.x, at.y)
      await expect(toast, name).toHaveText(NOT_IN)
      await noVotesYet()
      await dismiss()
    }
    expect(await setTool(b.page, 'select')).toBe(true)
    await selectNone(b.page)
  })

  await test.step('the part of the frame’s note nobody covers takes the vote, and so does the other note', async () => {
    const at = await canvasPoint(b.page, underOnly)
    await b.page.mouse.click(at.x, at.y)
    await expect(dot(b.page, OV.under)).toHaveAttribute('data-count', '1')
    await clickElement(b.page, OV.inside)
    await expect(dot(b.page, OV.inside)).toHaveAttribute('data-count', '1')
    await expect(remaining(b)).toHaveAttribute('data-remaining', '1')
    expect((await workshopState(b.api, board)).vote?.myVotes).toEqual({
      [`shape:${OV.under}`]: 1,
      [`shape:${OV.inside}`]: 1,
    })
  })

  await test.step('the results rank exactly the notes bob clicked', async () => {
    const sid = (await workshopState(a.api, board)).vote?.session.id ?? ''
    const res = await post(a, `/api/votes/${sid}/reveal`)
    expect(res.status(), await res.text()).toBe(200)
    const clicked = [`shape:${OV.inside}`, `shape:${OV.under}`].sort()
    for (const id of [OV.inside, OV.under]) await expect(badge(b.page, id), id).toHaveCount(1)
    await expect(badge(b.page, OV.loose)).toHaveCount(0)
    const results = (await workshopState(a.api, board)).vote?.results ?? []
    expect(results.map((r) => r.shapeId).sort()).toEqual(clicked)
  })
})

test('W5-01: a note made with N inside the vote’s frame joins the frame and takes votes', async ({
  join,
}) => {
  // W5-01 (2C): a note made with N and a click inside a frame joins it (merged at the wave-5 engine integration)
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { frames: [{ id: OV.frame, x: 0, y: 0, w: 900, h: 600, name: 'Ideas' }] })
  await expectItemsEverywhere([b], [OV.frame])
  await showAll(b.page)
  const before = new Set((await items(b.page)).map((e) => e.id))
  await focusCanvas(b.page)
  await b.page.keyboard.press('n')
  const at = await canvasPoint(b.page, { x: 450, y: 300 })
  await b.page.mouse.click(at.x, at.y)
  let made = ''
  await expect
    .poll(async () => {
      made = (await items(b.page)).find((e) => e.type === 'stickynote' && !before.has(e.id))?.id ?? ''
      return made
    })
    .not.toBe('')
  // words in it, so no clean-up of an empty note can take it away (W5-20)
  await waitForTextEditor(b.page, made)
  await typeText(b.page, 'Made with N')
  await stopTextEditing(b.page)
  await expect.poll(async () => (await item(b.page, made))?.frameId ?? null).toBe(OV.frame)
  await startVoteFromTopBar(a, { perPerson: 3, frameId: OV.frame, notesOnly: true })
  await joinVote(b, 3)
  await selectNone(b.page)
  await clickElement(b.page, made)
  await expect(dot(b.page, made)).toHaveAttribute('data-count', '1')
})

// ---- RETRO-10: a vote over the selection (migration 0024) -------------------------------------------------------

const RETRO = {
  went: 'wk-went',
  improve: 'wk-improve',
  later: 'wk-later',
  w1: 'wk-went-1',
  i1: 'wk-improve-1',
  p1: 'wk-later-1',
  loose: 'wk-loose',
}

test('RETRO-10: a vote over two selected frames takes votes on their contents only; a tab from before 0024 reads it as a board vote and the server keeps it to the selection', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, {
    frames: [
      { id: RETRO.went, x: 0, y: 0, w: 500, h: 400, name: 'Went well' },
      { id: RETRO.improve, x: 600, y: 0, w: 500, h: 400, name: 'To improve' },
      { id: RETRO.later, x: 1200, y: 0, w: 500, h: 400, name: 'Parking lot' },
    ],
    notes: [
      { id: RETRO.w1, x: 40, y: 80, text: 'Trailer music', frameId: RETRO.went },
      { id: RETRO.i1, x: 640, y: 80, text: 'Build times', frameId: RETRO.improve },
      { id: RETRO.p1, x: 1240, y: 80, text: 'Merch', frameId: RETRO.later },
      { id: RETRO.loose, x: 0, y: 600, text: 'Standup' },
    ],
  })
  await expectItemsEverywhere([a, b], Object.values(RETRO))
  const ref = (id: string) => `shape:${id}`

  await test.step('alice selects the two columns: the setup starts on "Only the selection"', async () => {
    await select(a.page, [RETRO.went, RETRO.improve])
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('vote-start').click()
    const dialog = a.page.getByTestId('vote-setup-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('vote-scope')).toHaveValue('selection')
    await expect(dialog.getByTestId('vote-scope-selection')).toHaveText('Only the selection (2 frames)')
    await dialog.getByTestId('vote-per-person').fill('3')
    await dialog.getByTestId('vote-setup-submit').click()
    await expect(dialog).toHaveCount(0)
    await expect(a.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'open')
    await expect(a.page.getByTestId('vote-current')).toContainText('in frames “Went well” and “To improve”')
  })

  await test.step('the server stores the list; a build from before 0024 reads a board vote', async () => {
    const res = await a.page.request.get(`/api/boards/${board}/workshop`, {
      headers: { 'x-lobby-client': '1' },
    })
    expect(res.status()).toBe(200)
    const now = (await res.json()) as { vote: { session: Record<string, unknown> } | null }
    expect(now.vote?.session).toMatchObject({
      scope: 'selection',
      frameId: null,
      selection: [ref(RETRO.went), ref(RETRO.improve)],
    })
    // workshopState sends no revision header: what a tab opened before the 0024 web deploy is answered
    const old = (await workshopState(b.api, board)).vote as ApiVoteState
    expect(old.session).toMatchObject({ scope: 'board', frameId: null })
    expect(JSON.stringify(old)).not.toContain(ref(RETRO.improve))
  })

  await test.step('bob votes on notes in the two columns; the third column and a loose note take none', async () => {
    await expect(b.page.getByTestId('vote-join-prompt')).toContainText('the selected frames and objects')
    await joinVote(b, 3)
    await showAll(b.page)
    await clickElement(b.page, RETRO.w1)
    await expect(dot(b.page, RETRO.w1)).toHaveAttribute('data-count', '1')
    await clickElement(b.page, RETRO.i1)
    await expect(dot(b.page, RETRO.i1)).toHaveAttribute('data-count', '1')
    await clickElement(b.page, RETRO.p1)
    await expect(b.page.getByTestId('vote-toast')).toContainText(
      'Not part of this vote: only objects in the selection take votes.',
    )
    await clickElement(b.page, RETRO.loose)
    await expect(remaining(b)).toHaveAttribute('data-remaining', '1')
    const marked = await markedShapeIds(b.page)
    expect(marked).toEqual(expect.arrayContaining([ref(RETRO.w1), ref(RETRO.i1)]))
    expect(marked).not.toContain(ref(RETRO.p1))
    expect(marked).not.toContain(ref(RETRO.loose))
  })

  await test.step('forged casts outside the selection are refused, also from a build that reads a board vote', async () => {
    const sid = (await workshopState(b.api, board)).vote?.session.id ?? ''
    for (const id of [RETRO.p1, RETRO.loose, RETRO.went]) {
      const res = await post(b, `/api/votes/${sid}/cast`, { shapeId: ref(id), delta: 1 })
      expect(res.status(), id).toBe(400)
      expect(await res.text()).toContain('NOT_ELIGIBLE')
    }
    const v = (await workshopState(b.api, board)).vote as ApiVoteState
    expect(v.myVotes).toEqual({ [ref(RETRO.w1)]: 1, [ref(RETRO.i1)]: 1 })
  })
})

// ---- R2-05: no +1 while a dot vote is open (workshops-3.fix) ----------------------------------------------------

test('+1 is not offered on notes while a dot vote is open (R2-05)', async ({ join, board }, testInfo) => {
  const alice = await join('alice', 'owner')
  await seed(alice.page, { notes: [{ id: 'slow', x: 0, y: 0 }] })
  await select(alice.page, ['slow'])
  await setViewport(alice.page, { x: -200, y: -200, zoom: 1 })
  const control = alice.page.locator('[data-testid="plusone"][data-shape-id="shape:slow"]')
  await expect(control).toHaveAttribute('data-active', 'true')
  const res = await post(alice, `/api/boards/${board}/votes`, {
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(res.status(), await res.text()).toBe(201)
  await expect(control).toHaveCount(0)
  await capture('lc-workshops3-no-plusone-during-vote.png', alice.page, testInfo)
})

// ---- export-control: the vote CSV is off for a limited viewer, live (workshops-2.fix, the vote half) ------------

const OFF_TEXT = 'The board owner turned off exporting for viewers.'

test('vote results: the CSV export is off for a limited viewer, live (export-control)', async ({
  join,
  board,
}) => {
  const alice = await join('alice', 'owner')
  const carol = await join('carol', 'viewer')
  const c = carol.page
  await seed(alice.page, { notes: [{ id: 'one', x: 0, y: 0 }] })
  await expectItemsEverywhere([carol], ['one'])
  expect(
    (
      await post(alice, `/api/boards/${board}/votes`, {
        votesPerPerson: 1,
        onePerObject: false,
        scope: 'board',
      })
    ).status(),
  ).toBe(201)
  const sid = (await workshopState(alice.api, board)).vote?.session.id ?? ''
  expect((await post(alice, `/api/votes/${sid}/cast`, { shapeId: 'shape:one', delta: 1 })).status()).toBe(200)
  expect((await post(alice, `/api/votes/${sid}/reveal`)).status()).toBe(200)

  const setPolicy = async (exportPolicy: 'everyone' | 'editors') => {
    const res = await alice.api.fetch('PUT', `/api/boards/${board}/export-policy`, { exportPolicy })
    expect(res.status(), await res.text()).toBe(200)
  }
  await setPolicy('editors')

  const voting = await openVotingPanel(c)
  const csv = voting.getByTestId('vote-results-csv')
  await expect(csv).toBeVisible()
  await expect(csv).toBeDisabled()
  await expect(voting.getByTestId('vote-results-csv-off')).toHaveText(OFF_TEXT)

  // The owner turns exporting back on: carol's button comes back without a reload.
  await setPolicy('everyone')
  await expect(csv).toBeEnabled()
  await expect(voting.getByTestId('vote-results-csv-off')).toHaveCount(0)
  const download = c.waitForEvent('download')
  await csv.click()
  expect((await download).suggestedFilename()).toMatch(/\.csv$/)
})
