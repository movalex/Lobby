// Workshops (docs/E2E-PLAN.md [workshops]; checklist FAC-02..06, PRF-07): the shared timer, anonymous
// dot voting and "Gather everyone", driven through the real UI by three people at once:
//   alice = board owner and facilitator, bob = editor (may facilitate too), carol = viewer.
// Everything a person "sees" is asserted in their own browser; what the server stored and refuses is
// asserted through the API as that person. Ballot privacy is checked on the wire: every /api
// response body and every server-sent event each browser received (DevTools Network domain).
import type { Page } from '@playwright/test'
import { edit, getShape, read } from './support/board.ts'
import { richText } from './support/editor.ts'
import { capture } from './support/screenshots.ts'
import {
  type ApiVoteState,
  badge,
  center,
  clickEmptyCanvas,
  clickShape,
  clockSeconds,
  closeWorkshopPopover,
  dot,
  expect,
  expectPillsAgree,
  markedShapeIds,
  moveCamera,
  type NoteSpec,
  openWorkshopPopover,
  oscillatorStarts,
  ownCamera,
  pillSeconds,
  pillSpread,
  presenceCamera,
  reachableCenter,
  reloadBoard,
  showAll,
  test,
  viewState,
  type WorkshopSession,
  workshopState,
} from './support/workshops.ts'

// ---- shared steps ----------------------------------------------------------------------------------

async function addNotes(page: Page, notes: NoteSpec[]) {
  await edit(
    page,
    (ed, list) =>
      ed.createShapes(
        list.map((n) => ({
          id: n.id,
          type: 'note',
          x: n.x,
          y: n.y,
          ...(n.parentId ? { parentId: n.parentId } : {}),
          props: { richText: n.rich },
        })),
      ),
    notes.map((n) => ({ ...n, rich: richText(n.text) })),
  )
}

/** Waits until every session holds the shapes (they arrive over the sync socket). */
async function expectShapesEverywhere(sessions: WorkshopSession[], ids: string[]) {
  for (const s of sessions) {
    await expect
      .poll(async () => (await Promise.all(ids.map((id) => getShape(s.page, id)))).every((x) => x !== null), {
        message: `${s.user} has the shapes`,
      })
      .toBe(true)
  }
}

/** The facilitator opens "Start a vote" from the top bar and starts one. */
async function startVoteFromTopBar(
  s: WorkshopSession,
  opts: { perPerson: number; onePerObject?: boolean; frameId?: string; notesOnly?: boolean },
) {
  const pop = await openWorkshopPopover(s.page)
  await pop.getByTestId('vote-start').click()
  await fillVoteSetup(s, opts)
}

async function fillVoteSetup(
  s: WorkshopSession,
  opts: { perPerson: number; onePerObject?: boolean; frameId?: string; notesOnly?: boolean },
) {
  const dialog = s.page.getByTestId('vote-setup-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('vote-per-person').fill(String(opts.perPerson))
  if (opts.onePerObject) await dialog.getByTestId('vote-one-per-object').check()
  if (opts.frameId) await dialog.getByTestId('vote-scope').selectOption(opts.frameId)
  if (opts.notesOnly) await dialog.getByTestId('vote-types').selectOption('note')
  await dialog.getByTestId('vote-setup-submit').click()
  await expect(dialog).toHaveCount(0)
  // Starting a vote opens the voting panel for the facilitator.
  await expect(s.page.getByTestId('dock-panel-voting')).toBeVisible()
  await expect(s.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'open')
}

/** A participant accepts the join prompt; the voting bar then shows their allowance. */
async function joinVote(s: WorkshopSession, votes: number) {
  const prompt = s.page.getByTestId('vote-join-prompt')
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText(`${votes} vote${votes === 1 ? '' : 's'}`)
  await prompt.getByTestId('vote-join').click()
  await expect(prompt).toHaveCount(0)
  await expect(s.page.getByTestId('vote-bar')).toBeVisible()
  await expect(s.page.getByTestId('vote-remaining')).toHaveAttribute('data-remaining', String(votes))
}

const remaining = (s: WorkshopSession) => s.page.getByTestId('vote-remaining')

async function openVotingPanel(s: WorkshopSession) {
  const panel = s.page.getByTestId('dock-panel-voting')
  if (!(await panel.isVisible())) await s.page.getByTestId('dock-tab-voting').click()
  await expect(panel).toBeVisible()
  return panel
}

const post = (s: WorkshopSession, path: string, body?: unknown) => s.api.fetch('POST', path, body ?? {})

// ---- [P0] ballot privacy + the whole vote -----------------------------------------------------------

const NOTE = {
  alice: 'shape:wk-alice-only',
  bob: 'shape:wk-bob-only',
  shared: 'shape:wk-shared',
  carol: 'shape:wk-carol-only',
}

test('ballot privacy: before the reveal nobody receives anyone else’s ballot, then everyone sees the same ranked counts', async ({
  join,
  board,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  const everyone = [a, b, c]

  await addNotes(a.page, [
    { id: NOTE.alice, x: 0, y: 0, text: 'Alice idea' },
    { id: NOTE.bob, x: 260, y: 0, text: 'Bob idea' },
    { id: NOTE.shared, x: 520, y: 0, text: 'Shared idea' },
    { id: NOTE.carol, x: 780, y: 0, text: 'Carol idea' },
  ])
  await expectShapesEverywhere(everyone, Object.values(NOTE))

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
    await clickShape(a.page, NOTE.alice)
    await expect(dot(a.page, NOTE.alice)).toHaveAttribute('data-count', '1')
    await expect(remaining(a)).toHaveAttribute('data-remaining', '2')

    // bob: two on his note, one on the shared one (a different note in between, so none is a double-click)
    await clickShape(b.page, NOTE.bob)
    await expect(dot(b.page, NOTE.bob)).toHaveAttribute('data-count', '1')
    await clickShape(b.page, NOTE.shared)
    await expect(dot(b.page, NOTE.shared)).toHaveAttribute('data-count', '1')
    await clickShape(b.page, NOTE.bob)
    await expect(dot(b.page, NOTE.bob)).toHaveAttribute('data-count', '2')
    await expect(remaining(b)).toHaveAttribute('data-remaining', '0')
    await expect(remaining(b)).toHaveText('0 of 3 left')
    // a 4th vote is refused with a message, and nothing changes
    await clickShape(b.page, NOTE.shared)
    await expect(b.page.getByTestId('vote-toast')).toContainText('used all your votes')
    await expect(dot(b.page, NOTE.shared)).toHaveAttribute('data-count', '1')
    // Voting clicks do not select (a selection is presence that everyone sees).
    expect(await read(b.page, (ed) => ed.getSelectedShapeIds())).toEqual([])

    await clickShape(c.page, NOTE.shared)
    await expect(dot(c.page, NOTE.shared)).toHaveAttribute('data-count', '1')
    await clickShape(c.page, NOTE.carol)
    await expect(dot(c.page, NOTE.carol)).toHaveAttribute('data-count', '1')
    await expect(remaining(c)).toHaveAttribute('data-remaining', '1')
    await c.page.getByTestId('vote-done').click()
    await expect(c.page.getByTestId('vote-bar')).toContainText("You're done voting.")
    await expect(c.page.getByTestId('vote-undone')).toBeVisible()
  })

  await test.step('the facilitator sees totals and "N of M done", but no per-note counts', async () => {
    const panel = await openVotingPanel(a)
    await expect(panel.getByTestId('vote-progress')).toHaveText('1 of 3 done · 6 votes cast')
    await expect(a.page.getByTestId('vote-count')).toHaveCount(0)
    await expect(a.page.getByTestId('vote-result-row')).toHaveCount(0)
    await expect(panel.getByTestId('vote-mine-row')).toHaveCount(1)
    // bob may facilitate too (editor): same totals, nothing per note
    const bobPanel = await openVotingPanel(b)
    await expect(bobPanel.getByTestId('vote-progress')).toHaveText('1 of 3 done · 6 votes cast')
    // carol (viewer) has no facilitator view at all
    const carolPanel = await openVotingPanel(c)
    await expect(carolPanel.getByTestId('vote-current')).toBeVisible()
    await expect(carolPanel.getByTestId('vote-facilitator')).toHaveCount(0)
    await expect(carolPanel.getByTestId('vote-progress')).toHaveCount(0)
    await capture('workshops-vote-facilitator.png', a.page, testInfo)
  })

  await test.step('bob reloads: his own dots come back from the server, nobody else’s', async () => {
    await reloadBoard(b)
    await showAll(b.page)
    await expect(dot(b.page, NOTE.bob)).toHaveAttribute('data-count', '2')
    await expect(dot(b.page, NOTE.shared)).toHaveAttribute('data-count', '1')
    await expect(remaining(b)).toHaveAttribute('data-remaining', '0')
    await expect(b.page.getByTestId('vote-join-prompt')).toHaveCount(0)
    await openVotingPanel(b)
  })

  await test.step('before the reveal: no DOM, response or event anywhere carries another person’s ballot', async () => {
    // The server's view per person: own ballot only, no results, 409 on the results route.
    const bobView = (await workshopState(b.api, board)).vote as ApiVoteState
    expect(bobView.myVotes).toEqual({ [NOTE.bob]: 2, [NOTE.shared]: 1 })
    expect(bobView.results).toBeNull()
    expect(bobView.totalVotesCast).toBe(6)
    const carolView = (await workshopState(c.api, board)).vote as ApiVoteState
    expect(carolView.myVotes).toEqual({ [NOTE.shared]: 1, [NOTE.carol]: 1 })
    expect(carolView.done).toBe(true)
    for (const s of everyone) {
      const res = await s.api.fetch('GET', `/api/votes/${sid}/results`)
      expect(res.status(), `${s.user}: results before reveal`).toBe(409)
    }

    // DOM, over the whole session: only one's own notes ever carried a vote marker.
    expect(await markedShapeIds(a.page)).toEqual([NOTE.alice])
    expect(await markedShapeIds(b.page)).toEqual([NOTE.bob, NOTE.shared].sort())
    expect(await markedShapeIds(c.page)).toEqual([NOTE.carol, NOTE.shared].sort())

    // The wire: nothing any browser received names a note only someone else voted on.
    expect(await a.net.containing([NOTE.bob, NOTE.shared, NOTE.carol])).toEqual([])
    expect(await b.net.containing([NOTE.alice, NOTE.carol])).toEqual([])
    expect(await c.net.containing([NOTE.alice, NOTE.bob])).toEqual([])
    // ...and the recording is not empty: bob's own ballot is on the wire, the vote events and the
    // state/list routes were received.
    expect((await b.net.containing([NOTE.bob])).length).toBeGreaterThan(0)
    expect(b.net.eventsOf('workshop.vote').length).toBeGreaterThan(0)
    expect(b.net.responses.some((r) => r.path === `/api/boards/${board}/workshop`)).toBe(true)
    expect(b.net.responses.some((r) => r.path === `/api/boards/${board}/votes`)).toBe(true)
    expect(b.net.eventsOf('workshop.vote.results')).toEqual([])
    // Vote events are aggregates only (contract): no per-person or per-object field at all.
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
    // Ballots never travel on the canvas socket either: not as vote data, and not as presence. A
    // vote click must not select the note, or everyone's presence shows who clicked what.
    expect(b.net.wsFrames.length).toBeGreaterThan(0)
    expect(b.net.wsFrames.filter((f) => f.includes(sid) || f.includes('myVotes'))).toEqual([])
    const voted = Object.values(NOTE)
    for (const s of everyone) {
      expect(
        s.net.presenceSelections().filter((id) => voted.includes(id)),
        `${s.user}: other people's selections on voted notes`,
      ).toEqual([])
    }
  })

  const expected = [
    { shapeId: NOTE.bob, count: 2, rank: 1 },
    { shapeId: NOTE.shared, count: 2, rank: 1 },
    { shapeId: NOTE.alice, count: 1, rank: 3 },
    { shapeId: NOTE.carol, count: 1, rank: 3 },
  ]

  await test.step('alice reveals (twice is one result): counts on the notes and a ranked list for everyone', async () => {
    await a.page.getByTestId('vote-reveal').click()
    // A second "reveal" (another facilitator, a double-click) changes nothing.
    const again = await post(a, `/api/votes/${sid}/reveal`)
    expect(again.status()).toBe(200)
    expect(((await again.json()) as ApiVoteState).results).toEqual(expected)

    for (const s of everyone) {
      await expect(s.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'revealed')
      for (const r of expected) {
        await expect(badge(s.page, r.shapeId), `${s.user}: badge on ${r.shapeId}`).toHaveAttribute(
          'data-rank',
          String(r.rank),
        )
        await expect(badge(s.page, r.shapeId)).toContainText(String(r.count))
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
    // One results event reached bob, with exactly the stored results.
    await expect.poll(() => b.net.eventsOf('workshop.vote.results').length).toBe(1)
    const [resultsEvent] = b.net.eventsOf('workshop.vote.results')
    expect((resultsEvent?.data as { results?: unknown } | undefined)?.results).toEqual(expected)
    const stored = await c.api.fetch('GET', `/api/votes/${sid}/results`)
    expect(stored.status()).toBe(200)
    expect(((await stored.json()) as { results: unknown }).results).toEqual(expected)
    await showAll(c.page)
    await capture('workshops-vote-revealed.png', c.page, testInfo)
  })

  await test.step('control: the same recorders do see these ids once they are meant to arrive', async () => {
    // Revealed results name every note, on the wire and in the DOM.
    expect((await b.net.containing([NOTE.alice])).length).toBeGreaterThan(0)
    expect((await b.net.containing([NOTE.carol])).length).toBeGreaterThan(0)
    expect(await markedShapeIds(b.page)).toEqual(Object.values(NOTE).sort())
    // A deliberate selection (not a vote) is presence, and reaches the others.
    await edit(b.page, (ed, id) => ed.select(id), NOTE.carol)
    await expect.poll(() => a.net.presenceSelections()).toContain(NOTE.carol)
  })

  await test.step('the results persist: carol reloads and still sees the badges and ranking', async () => {
    await reloadBoard(c)
    await showAll(c.page)
    for (const r of expected) await expect(badge(c.page, r.shapeId)).toContainText(String(r.count))
    await openVotingPanel(c)
    await expect(c.page.getByTestId('vote-results').getByTestId('vote-result-row')).toHaveCount(4)
  })

  await test.step('the ranking downloads as CSV', async () => {
    const title = (await a.api.getBoard(board)).board.title
    const download = a.page.waitForEvent('download')
    await a.page.getByTestId('vote-results-csv').click()
    const file = await download
    expect(file.suggestedFilename()).toBe(`${title} - Dot vote.csv`)
    const path = await file.path()
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(path, 'utf8').split('\r\n')).toEqual([
      'Rank,Votes,Object type,Text,Object id',
      `1,2,Sticky note,Bob idea,${NOTE.bob}`,
      `1,2,Sticky note,Shared idea,${NOTE.shared}`,
      `3,1,Sticky note,Alice idea,${NOTE.alice}`,
      `3,1,Sticky note,Carol idea,${NOTE.carol}`,
      '',
    ])
  })
})

// ---- [P1] timer sync -----------------------------------------------------------------------------------

const AGENDA = 'shape:wk-agenda'

test('timer sync: start, pause, +1 min, resume and stop look the same to everyone; late joiners agree within 1 s; a viewer cannot set it', async ({
  join,
  board,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  const pages = [a.page, b.page, c.page]
  // A frame, so the board can be presented.
  await edit(
    a.page,
    (ed, id) => ed.createShape({ id, type: 'frame', x: 0, y: 0, props: { w: 800, h: 450, name: 'Agenda' } }),
    AGENDA,
  )
  await expectShapesEverywhere([a, b, c], [AGENDA])

  await test.step('carol (viewer) has no timer, vote or gather controls, and the API refuses them', async () => {
    for (const p of pages) await expect(p.getByTestId('timer-pill')).toHaveAttribute('data-state', 'idle')
    const pop = await openWorkshopPopover(c.page)
    await expect(pop).toContainText('Only editors and owners can set the timer')
    for (const id of [
      'timer-start',
      'timer-duration',
      'timer-preset-5',
      'timer-pause',
      'timer-stop',
      'vote-start',
      'summon-button',
    ])
      await expect(pop.getByTestId(id), id).toHaveCount(0)
    await expect(pop.getByTestId('timer-sound')).toBeVisible() // muting is everyone's choice
    await closeWorkshopPopover(c.page)

    expect(
      (await post(c, `/api/boards/${board}/timer`, { action: 'start', durationMs: 60_000 })).status(),
    ).toBe(403)
    expect(
      (
        await post(c, `/api/boards/${board}/votes`, {
          votesPerPerson: 3,
          onePerObject: false,
          scope: 'board',
        })
      ).status(),
    ).toBe(403)
    expect((await post(c, `/api/boards/${board}/summon`)).status()).toBe(403)
    expect((await workshopState(c.api, board)).timer).toBeNull()
  })

  await test.step('alice starts 5 minutes: every pill runs and shows the same time', async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('timer-preset-5').click()
    await expect(pop.getByTestId('timer-duration')).toHaveValue('5:00')
    await pop.getByTestId('timer-start').click()
    await closeWorkshopPopover(a.page)
    for (const p of pages) await expect(p.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')
    await expect.poll(() => pillSpread(pages), { message: 'pills agree within 1 s' }).toBeLessThanOrEqual(1)
    const first = await pillSeconds(a.page)
    expect(first).toBeGreaterThan(285)
    // Nobody's pill ever shows more than the 5:00 that was set (a clock-offset error once made it 5:01).
    for (const p of pages) expect(await pillSeconds(p)).toBeLessThanOrEqual(300)
    const t = (await workshopState(c.api, board)).timer
    expect(t).toMatchObject({ status: 'running', durationMs: 300_000 })
    // It counts down, and keeps agreeing.
    await expect.poll(() => pillSeconds(c.page)).toBeLessThan(first)
    await expectPillsAgree(pages)
  })

  await test.step('a late joiner and a reload show the same time within 1 s', async () => {
    const d = await join('dave', 'viewer')
    await expect(d.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')
    await expectPillsAgree([a.page, d.page])
    await reloadBoard(c)
    await expect(c.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')
    await expectPillsAgree([a.page, c.page, d.page])
    await d.context.close()
  })

  await test.step('a late joiner on a slow device (busy when the server time arrives) agrees too', async () => {
    // The event stream's hello is handled 2 s after it arrived. A clock offset taken from it alone
    // would make this pill run 2 s ahead of everyone else's.
    const e = await join('erin', 'viewer', { busyAfterEventStreamMs: 2_000 })
    await expect(e.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')
    await expectPillsAgree([a.page, e.page])
    await e.context.close()
  })

  await test.step('while carol presents, the timer floats over the slides', async () => {
    await c.page.getByTestId('present-button').click()
    await expect(c.page.getByTestId('present-overlay')).toBeVisible()
    const floating = c.page.getByTestId('timer-floating')
    await expect(floating).toBeVisible()
    await expect(floating).toHaveAttribute('data-state', 'running')
    await expect
      .poll(async () => Math.abs(clockSeconds(await floating.innerText()) - (await pillSeconds(a.page))))
      .toBeLessThanOrEqual(1)
    await capture('workshops-timer-presenting.png', c.page, testInfo)
    await c.page.keyboard.press('Escape')
    await expect(c.page.getByTestId('present-overlay')).toHaveCount(0)
    await expect(floating).toHaveCount(0)
  })

  let paused = 0
  await test.step("bob (editor) can't pause alice's timer (R3); alice pauses: every pill freezes on the same value", async () => {
    const bobPop = await openWorkshopPopover(b.page)
    await expect(bobPop.getByTestId('timer-held-hint')).toContainText('is running this timer')
    await expect(bobPop.getByTestId('timer-pause')).toHaveCount(0)
    await closeWorkshopPopover(b.page)
    expect((await post(b, `/api/boards/${board}/timer`, { action: 'pause' })).status()).toBe(403)
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('timer-pause').click()
    await expect(pop.getByTestId('timer-resume')).toBeVisible()
    await closeWorkshopPopover(a.page)
    for (const p of pages) await expect(p.getByTestId('timer-pill')).toHaveAttribute('data-state', 'paused')
    paused = await pillSeconds(a.page)
    for (const p of pages)
      await expect(p.getByTestId('timer-remaining')).toHaveText(
        await a.page.getByTestId('timer-remaining').innerText(),
      )
    const t = (await workshopState(a.api, board)).timer
    expect(t?.status).toBe('paused')
    expect(Math.ceil((t?.remainingMs ?? 0) / 1000)).toBe(paused)
    // Frozen: a second and a half later nothing has moved (the duration is what is under test).
    await a.page.waitForTimeout(1_500)
    expect(await Promise.all(pages.map((p) => pillSeconds(p)))).toEqual([paused, paused, paused])
  })

  await test.step('alice adds a minute while paused: +60 s everywhere, still paused', async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('timer-add-1m').click()
    await closeWorkshopPopover(a.page)
    for (const p of pages) {
      await expect.poll(() => pillSeconds(p)).toBe(paused + 60)
      await expect(p.getByTestId('timer-pill')).toHaveAttribute('data-state', 'paused')
    }
    expect(Math.ceil(((await workshopState(b.api, board)).timer?.remainingMs ?? 0) / 1000)).toBe(paused + 60)
  })

  await test.step('alice resumes: everyone counts down again from there, together', async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('timer-resume').click()
    await closeWorkshopPopover(a.page)
    for (const p of pages) await expect(p.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')
    await expectPillsAgree(pages)
    expect(await pillSeconds(b.page)).toBeLessThanOrEqual(paused + 60)
    await expect.poll(() => pillSeconds(b.page)).toBeLessThan(paused + 59)
  })

  await test.step('alice stops: the countdown disappears for everyone', async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('timer-stop').click()
    await closeWorkshopPopover(a.page)
    for (const p of pages) {
      await expect(p.getByTestId('timer-pill')).toHaveAttribute('data-state', 'stopped')
      await expect(p.getByTestId('timer-remaining')).toHaveCount(0)
    }
    expect((await workshopState(c.api, board)).timer?.status).toBe('stopped')
  })
})

// ---- [P1] time's up ---------------------------------------------------------------------------------

test("time's up: everyone gets the flash and one message at zero; the chime plays unless muted, muting survives a reload, and about 10 s later the pill is back to Timer", async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  const everyone = [a, b, c]

  await test.step('carol mutes the sound; bob leaves it on', async () => {
    const pop = await openWorkshopPopover(c.page)
    await expect(pop.getByTestId('timer-sound')).toBeChecked()
    await pop.getByTestId('timer-sound').uncheck()
    await closeWorkshopPopover(c.page)
    const bobPop = await openWorkshopPopover(b.page)
    await expect(bobPop.getByTestId('timer-sound')).toBeChecked()
    await closeWorkshopPopover(b.page)
  })

  await test.step('alice types 0:03 and starts', async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('timer-duration').fill('0:03')
    await expect(pop.getByTestId('timer-start')).toHaveText('Start 0:03')
    await pop.getByTestId('timer-start').click()
    await closeWorkshopPopover(a.page)
    for (const s of everyone)
      await expect(s.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')
  })

  let zeroAt = 0
  await test.step('at zero: the flash with one "Time\'s up" message and "finished" everywhere; the chime only where it is not muted', async () => {
    // The flash lasts 4 s: watch all three pages at once.
    await Promise.all(
      everyone.map((s) => expect(s.page.getByTestId('timer-flash')).toBeVisible({ timeout: 10_000 })),
    )
    zeroAt = Date.now()
    for (const s of everyone) {
      await expect(s.page.getByTestId('timer-finished')).toContainText("Time's up")
      // One message only (RETRO-23a): the flash's, no toast on top of it. (The board itself is called
      // "Time's up" here, so only the canvas and the notices are counted.)
      await expect(s.page.getByRole('main').getByText("Time's up", { exact: true })).toHaveCount(1)
      await expect(s.page.locator('.dr-notices')).not.toContainText("Time's up")
      await expect(s.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'finished')
      await expect(s.page.getByTestId('timer-remaining')).toHaveText('0:00')
    }
    await expect.poll(() => oscillatorStarts(a.page), { message: 'alice heard the chime' }).toBe(6)
    await expect.poll(() => oscillatorStarts(b.page), { message: 'bob heard the chime' }).toBe(6)
    expect(await oscillatorStarts(c.page)).toBe(0)
    expect((await workshopState(c.api, board)).timer).toMatchObject({ status: 'finished', remainingMs: 0 })
  })

  await test.step('carol reloads: still muted, and no second alert', async () => {
    await reloadBoard(c)
    const pop = await openWorkshopPopover(c.page)
    await expect(pop.getByTestId('timer-sound')).not.toBeChecked()
    await closeWorkshopPopover(c.page)
    await expect(c.page.getByTestId('timer-flash')).toHaveCount(0)
    await expect(c.page.getByTestId('timer-finished')).toHaveCount(0)
  })

  await test.step('about 10 s after zero the pills go back to "Timer" (the server stays finished; Reset stays)', async () => {
    for (const s of everyone) {
      await expect(s.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'ended', {
        timeout: 15_000,
      })
      await expect(s.page.getByTestId('timer-pill')).toHaveText('Timer')
      await expect(s.page.getByTestId('timer-remaining')).toHaveCount(0)
    }
    expect(Date.now() - zeroAt).toBeGreaterThan(5_000) // it stayed red for a while, not just the flash
    expect((await workshopState(a.api, board)).timer?.status).toBe('finished')
    const pop = await openWorkshopPopover(a.page)
    await expect(pop.getByTestId('timer-stop')).toHaveText('Reset')
    await closeWorkshopPopover(a.page)
  })

  await test.step('a late joiner (more than 10 s after zero) sees no red 0:00', async () => {
    await reloadBoard(b)
    await expect(b.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'ended')
    await expect(b.page.getByTestId('timer-remaining')).toHaveCount(0)
    await expect(b.page.getByTestId('timer-flash')).toHaveCount(0)
  })

  await test.step('presenting a board whose timer has finished shows no floating timer', async () => {
    await edit(a.page, (ed) =>
      ed.createShape({
        id: 'shape:wk-tu-frame',
        type: 'frame',
        x: 0,
        y: 0,
        props: { w: 400, h: 300, name: 'Slide' },
      }),
    )
    await expect.poll(() => getShape(c.page, 'shape:wk-tu-frame')).not.toBeNull()
    await c.page.getByTestId('present-button').click()
    await expect(c.page.getByTestId('present-overlay')).toBeVisible()
    await expect(c.page.getByTestId('timer-floating')).toHaveCount(0)
    await c.page.keyboard.press('Escape')
    await expect(c.page.getByTestId('present-overlay')).toHaveCount(0)
  })
})

// ---- [P1] vote setup: frame scope, one per object, sticky notes only ---------------------------------------

const FRAME = 'shape:wk-frame'
const IN1 = 'shape:wk-in-1'
const IN2 = 'shape:wk-in-2'
const GEO_IN = 'shape:wk-geo-in'
const IN3 = 'shape:wk-in-3'
const OUT = 'shape:wk-out'

test('vote setup: one vote per object on sticky notes inside one frame; the server refuses what the UI prevents; "I’m done" shows in the progress', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')

  await edit(
    a.page,
    (ed, ids) => {
      ed.createShape({ id: ids.frame, type: 'frame', x: 0, y: 0, props: { w: 820, h: 620, name: 'Ideas' } })
      ed.createShape({
        id: ids.geo,
        type: 'geo',
        parentId: ids.frame,
        x: 580,
        y: 80,
        props: { w: 200, h: 200 },
      })
    },
    { frame: FRAME, geo: GEO_IN },
  )
  await addNotes(a.page, [
    { id: IN1, x: 40, y: 80, text: 'Inside one', parentId: FRAME },
    { id: IN2, x: 310, y: 80, text: 'Inside two', parentId: FRAME },
    { id: IN3, x: 40, y: 340, text: 'Inside three', parentId: FRAME },
    { id: OUT, x: 1000, y: 80, text: 'Outside' },
  ])
  await expectShapesEverywhere([a, b, c], [FRAME, GEO_IN, IN1, IN2, IN3, OUT])

  await test.step('alice sets up the vote; the server stores exactly that', async () => {
    await startVoteFromTopBar(a, { perPerson: 3, onePerObject: true, frameId: FRAME, notesOnly: true })
    const v = (await workshopState(b.api, board)).vote as ApiVoteState
    expect(v.session).toMatchObject({
      status: 'open',
      votesPerPerson: 3,
      onePerObject: true,
      scope: 'frame',
      frameId: FRAME,
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
    await clickShape(b.page, OUT) // outside the frame: nothing
    await clickShape(b.page, GEO_IN) // not a sticky note: nothing
    await clickShape(b.page, IN1)
    await expect(dot(b.page, IN1)).toHaveAttribute('data-count', '1')
    await expect(remaining(b)).toHaveAttribute('data-remaining', '2')
    await clickShape(b.page, IN2)
    await expect(dot(b.page, IN2)).toHaveAttribute('data-count', '1')
    await clickShape(b.page, IN1) // a second dot on the same note
    await expect(b.page.getByTestId('vote-toast')).toContainText('One vote per object')
    await expect(dot(b.page, IN1)).toHaveAttribute('data-count', '1')
    await expect(remaining(b)).toHaveAttribute('data-remaining', '1')
    expect(await markedShapeIds(b.page)).not.toContain(OUT)
    expect(await markedShapeIds(b.page)).not.toContain(GEO_IN)
  })

  await test.step('forged casts outside the rules are refused by the server', async () => {
    const sid = (await workshopState(b.api, board)).vote?.session.id ?? ''
    const cast = (shapeId: string) => post(b, `/api/votes/${sid}/cast`, { shapeId, delta: 1 })
    for (const [shapeId, code] of [
      [OUT, 'NOT_ELIGIBLE'],
      [GEO_IN, 'NOT_ELIGIBLE'],
      [FRAME, 'NOT_ELIGIBLE'],
    ] as const) {
      const res = await cast(shapeId)
      expect(res.status(), shapeId).toBe(400)
      expect(await res.text()).toContain(code)
    }
    const twice = await cast(IN1)
    expect(twice.status()).toBe(409)
    expect(await twice.text()).toContain('ONE_PER_OBJECT')
    const v = (await workshopState(b.api, board)).vote as ApiVoteState
    expect(v.myVotes).toEqual({ [IN1]: 1, [IN2]: 1 })
    expect(v.myRemaining).toBe(1)
  })

  await test.step('while voting, a plain drag on a note neither moves it nor votes; Shift+drag moves it', async () => {
    const x0 = (await getShape(b.page, IN3))?.x ?? Number.NaN
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
    expect((await getShape(b.page, IN3))?.x).toBe(x0)
    expect((await workshopState(b.api, board)).vote?.myVotes).toEqual({ [IN1]: 1, [IN2]: 1 })
    await drag(true)
    await expect.poll(async () => (await getShape(a.page, IN3))?.x ?? x0).toBeGreaterThan(x0 + 20)
    expect((await workshopState(b.api, board)).vote?.myVotes).toEqual({ [IN1]: 1, [IN2]: 1 })
    await edit(b.page, (ed) => ed.selectNone())
  })

  await test.step('carol votes and says she is done; alice sees "N of M done"', async () => {
    await joinVote(c, 3)
    await showAll(c.page)
    await clickShape(c.page, IN2)
    await expect(dot(c.page, IN2)).toHaveAttribute('data-count', '1')
    await c.page.getByTestId('vote-done').click()
    await expect(c.page.getByTestId('vote-bar')).toContainText("You're done voting.")
    await expect(a.page.getByTestId('vote-progress')).toHaveText('1 of 2 done · 3 votes cast')
    await b.page.getByTestId('vote-done').click()
    await expect(a.page.getByTestId('vote-progress')).toHaveText('2 of 2 done · 3 votes cast')
    // Done: clicks are ordinary again (they select, they do not vote). The geo shape bob clicked
    // earlier is still selected (not a vote target, so tldraw selected it): clear it so its style
    // panel does not cover the note.
    await edit(b.page, (ed) => ed.selectNone())
    await clickShape(b.page, OUT)
    await expect.poll(() => read(b.page, (ed) => ed.getSelectedShapeIds())).toEqual([OUT])
    expect((await workshopState(b.api, board)).vote?.myVotes).toEqual({ [IN1]: 1, [IN2]: 1 })
    // "Keep voting" takes it back.
    await b.page.getByTestId('vote-undone').click()
    await expect(a.page.getByTestId('vote-progress')).toHaveText('1 of 2 done · 3 votes cast')
    expect((await workshopState(a.api, board)).vote).toMatchObject({ participantsDone: 1, participants: 2 })
  })
})

// ---- [P1] end without results; roles ---------------------------------------------------------------------

test('end without results: casting stops, results stay hidden and the vote is listed as past; viewers and commenters vote but cannot facilitate', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const c = await join('carol', 'viewer')
  const d = await join('dave', 'commenter')
  const N1 = 'shape:wk-end-1'
  const N2 = 'shape:wk-end-2'
  await addNotes(a.page, [
    { id: N1, x: 0, y: 0, text: 'First' },
    { id: N2, x: 300, y: 0, text: 'Second' },
  ])
  await expectShapesEverywhere([a, c, d], [N1, N2])

  let sid = ''
  await test.step('alice starts a vote from the voting panel; carol (viewer) and dave (commenter) vote', async () => {
    const panel = await openVotingPanel(a)
    await expect(panel).toContainText('No votes on this board yet.')
    await panel.getByTestId('vote-start-panel').click()
    await fillVoteSetup(a, { perPerson: 2 })
    sid = (await workshopState(a.api, board)).vote?.session.id ?? ''
    for (const s of [c, d]) {
      await joinVote(s, 2)
      await showAll(s.page)
    }
    await clickShape(c.page, N1)
    await expect(dot(c.page, N1)).toHaveAttribute('data-count', '1')
    await clickShape(d.page, N2)
    await expect(dot(d.page, N2)).toHaveAttribute('data-count', '1')
  })

  await test.step('viewer and commenter have no facilitator controls, and the API refuses forged ones', async () => {
    for (const s of [c, d]) {
      const pop = await openWorkshopPopover(s.page)
      for (const id of ['timer-start', 'vote-start', 'summon-button'])
        await expect(pop.getByTestId(id), `${s.user}: ${id}`).toHaveCount(0)
      await expect(pop.getByTestId('vote-open-panel')).toBeVisible()
      await closeWorkshopPopover(s.page)
      const panel = await openVotingPanel(s)
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
    expect(v.totalVotesCast).toBe(2)
    expect((await workshopState(a.api, board)).timer).toBeNull()
  })

  await test.step('alice ends it without results: no more casting, nothing revealed', async () => {
    await a.page.getByTestId('vote-close').click()
    for (const s of [a, c, d])
      await expect(s.page.getByTestId('vote-current')).toHaveAttribute('data-status', 'closed')
    await expect(c.page.getByTestId('vote-bar')).toHaveCount(0)
    await expect(c.page.getByTestId('vote-current')).toContainText('results stay hidden')
    await clickShape(c.page, N2)
    await expect(c.page.getByTestId('vote-dot')).toHaveCount(0)
    const cast = await post(c, `/api/votes/${sid}/cast`, { shapeId: N2, delta: 1 })
    expect(cast.status()).toBe(409)
    expect(await cast.text()).toContain('VOTE_CLOSED')
    for (const s of [a, c, d]) {
      expect((await s.api.fetch('GET', `/api/votes/${sid}/results`)).status(), s.user).toBe(409)
      await expect(s.page.getByTestId('vote-count')).toHaveCount(0)
    }
    const v = (await workshopState(c.api, board)).vote as ApiVoteState
    expect(v.session.status).toBe('closed')
    expect(v.results).toBeNull()
    expect(v.myVotes).toEqual({ [N1]: 1 })
  })

  await test.step('alice starts a new vote from the panel; the ended one is listed under past votes', async () => {
    const panel = await openVotingPanel(a)
    await panel.getByTestId('vote-start-panel').click()
    await fillVoteSetup(a, { perPerson: 1 })
    const newSid = (await workshopState(a.api, board)).vote?.session.id ?? ''
    expect(newSid).not.toBe(sid)
    await panel.getByTestId('vote-history').locator('summary').click()
    const row = panel.locator(`[data-testid="vote-history-row"][data-session-id="${sid}"]`)
    await expect(row).toBeVisible()
    await expect(row).toContainText('2 votes')
    await expect(row).toContainText('Not revealed')
    // Everyone is asked to join the new vote.
    await expect(c.page.getByTestId('vote-join-prompt')).toContainText('1 vote')
  })
})

// ---- [P1] gather everyone ------------------------------------------------------------------------------

/** The follower's viewport shows what the leader's shows (same window size: same bounds). */
async function expectSameView(follower: Page, leader: Page) {
  await expect
    .poll(
      async () => {
        const [f, l] = await Promise.all([viewState(follower), viewState(leader)])
        const fc = center(f.bounds)
        const lc = center(l.bounds)
        return (
          Math.abs(fc.x - lc.x) <= 2 && Math.abs(fc.y - lc.y) <= 2 && Math.abs(f.zoom / l.zoom - 1) < 0.01
        )
      },
      { message: 'follower shows the leader’s view' },
    )
    .toBe(true)
}

test('gather everyone: bob and carol follow alice’s view until they stop, click or scroll; a second summon within 3 s is refused', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  await addNotes(a.page, [
    { id: 'shape:wk-far-1', x: -3000, y: -2000, text: 'Over here' },
    { id: 'shape:wk-far-2', x: 2000, y: 1500, text: 'And here' },
  ])
  await expectShapesEverywhere([a, b, c], ['shape:wk-far-1', 'shape:wk-far-2'])

  const summon = async () => {
    const pop = await openWorkshopPopover(a.page)
    await pop.getByTestId('summon-button').click()
    await expect(a.page.getByTestId('summon-toast')).toContainText('Everyone here now follows your view')
    await expect(pop).toHaveCount(0)
  }

  let summonedAt = 0
  await test.step('alice pans away and gathers everyone: bob and carol (viewer) follow her view', async () => {
    await moveCamera(a.page, { x: 3200, y: 2200, z: 0.8 })
    const before = await viewState(b.page)
    expect(center(before.bounds)).not.toEqual(center((await viewState(a.page)).bounds))
    await summon()
    summonedAt = Date.now()
    // Right after: a second summon is refused (3 s cooldown) with a message.
    const again = await post(a, `/api/boards/${board}/summon`)
    expect(again.status()).toBe(429)
    for (const s of [b, c]) {
      await expect(s.page.getByTestId('follow-toast')).toContainText(`Following ${a.name}`)
      await expectSameView(s.page, a.page)
      expect((await viewState(s.page)).following).toBe(`user:${a.id}`)
    }
    expect((await viewState(a.page)).following).toBeNull()
  })

  await test.step('they keep following while alice moves', async () => {
    await moveCamera(a.page, { x: -1500, y: -800, z: 1.25 })
    await expectSameView(b.page, a.page)
    await expectSameView(c.page, a.page)
  })

  await test.step('bob clicks "Stop following"; carol keeps following', async () => {
    // One stop-following control on screen (RETRO-11): tldraw's own, top left; the notice explains it.
    await expect(b.page.getByTestId('follow-stop')).toHaveCount(0)
    await expect(b.page.getByTestId('follow-toast')).toContainText('Stop following at the top left')
    await b.page.getByTestId('helper-buttons.stop-following').click()
    await expect(b.page.getByTestId('follow-toast')).toHaveCount(0)
    expect((await viewState(b.page)).following).toBeNull()
    const bobView = await viewState(b.page)
    await moveCamera(a.page, { x: 500, y: 300, z: 1 })
    await expectSameView(c.page, a.page)
    // bob's browser has received alice's new camera, and his own view did not move.
    const aliceCam = await ownCamera(a.page)
    await expect.poll(() => presenceCamera(b.page, a.id)).toEqual(aliceCam)
    expect((await viewState(b.page)).bounds).toEqual(bobView.bounds)
  })

  await test.step('a plain click on the canvas ends carol’s following', async () => {
    await clickEmptyCanvas(c.page)
    await expect(c.page.getByTestId('follow-toast')).toHaveCount(0)
    await expect.poll(async () => (await viewState(c.page)).following).toBeNull()
    const carolView = await viewState(c.page)
    await moveCamera(a.page, { x: -200, y: -900, z: 0.9 })
    const aliceCam = await ownCamera(a.page)
    await expect.poll(() => presenceCamera(c.page, a.id)).toEqual(aliceCam)
    expect((await viewState(c.page)).bounds).toEqual(carolView.bounds)
  })

  await test.step('after the cooldown alice gathers again; a click ends bob’s, a scroll ends carol’s', async () => {
    // The 3 s cooldown is the duration under test.
    await a.page.waitForTimeout(Math.max(0, 3_200 - (Date.now() - summonedAt)))
    await summon()
    for (const s of [b, c]) {
      await expect(s.page.getByTestId('follow-toast')).toBeVisible()
      await expectSameView(s.page, a.page)
    }
    await clickEmptyCanvas(b.page)
    await expect(b.page.getByTestId('follow-toast')).toHaveCount(0)
    await expect.poll(async () => (await viewState(b.page)).following).toBeNull()
    const vp = c.page.viewportSize() ?? { width: 1280, height: 720 }
    await c.page.mouse.move(vp.width / 2, vp.height / 2)
    await c.page.mouse.wheel(0, 300)
    await expect(c.page.getByTestId('follow-toast')).toHaveCount(0)
    await expect.poll(async () => (await viewState(c.page)).following).toBeNull()
  })
})
