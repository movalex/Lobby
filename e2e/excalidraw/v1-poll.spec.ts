// OWNER: WS2 (wave V, V1; docs/WAVE-V-CONTRACTS.md §2). A poll in a live session, end to end on the Excalidraw board
// page with the real api (WS1), sync and web:
//  - the facilitator (an owner with an account) starts it from the Facilitate menu;
//  - three people answer: an editor, a viewer and a name-only guest on a workshop link on a 375 px phone (the start
//    notice's "Answer" opens the panel, a full-width sheet there);
//  - the facilitator sees the windowed count and the live results, the participants do not until the reveal;
//  - Results to board: ONE undo step by the facilitator's tab; every placed element is tagged 'poll-chart', stored with
//    the facilitator as its author and carries no participant's id or name (the anonymity rule's placement half);
//    the others see it and push nothing while they only receive;
//  - no request leaves Lobby's origins.
import type { BrowserContext } from '@playwright/test'
import { expectSaved, pushedOps } from '../tests/support/canvas.ts'
import { serverSnapshot } from '../tests/support/excalidraw.ts'
import {
  answerPoll,
  expect,
  expectAnswered,
  focusCanvas,
  foreignRequestsOf,
  guestJoins,
  openActivityPanel,
  panel,
  placed,
  startActivity,
  stringsIn,
  test,
  withLive,
  workshopLink,
} from './v1-kit.ts'

const KIND = 'poll-chart'

test('a poll: three people answer (a guest on a 375 px phone), reveal, Results to board is one undo step by the facilitator alone', async ({
  join,
  board,
  browser,
  stack,
}) => {
  const alice = await withLive(await join('alice'))
  const bob = await withLive(await join('bob', 'editor'))
  const carol = await withLive(await join('carol', 'viewer'))
  const foreign = [alice, bob, carol].map((s) => foreignRequestsOf(s.context))
  const opened: BrowserContext[] = []
  try {
    const guest = await guestJoins(browser, await workshopLink(alice, board), 'Gus Guest', opened)

    await startActivity(alice.page, {
      kind: 'poll',
      prompt: 'Which day suits the offsite?',
      options: ['Monday', 'Wednesday', 'Friday'],
    })
    await expect(alice.page.getByTestId('facilitate-pill-activities')).toHaveText('Poll')

    // the others are told, and answer in the panel
    await expect(bob.page.getByTestId('la-start-toast')).toContainText('Which day suits the offsite?')
    await answerPoll(bob.page, [2])
    await answerPoll(carol.page, [0])
    // the phone: the notice's Answer opens the panel as a sheet as wide as the screen
    await expect(guest.page.getByTestId('la-start-toast')).toBeVisible()
    const sheet = await openActivityPanel(guest.page)
    const box = await sheet.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 375 + 1).toBe(true)
    const send = await sheet.getByTestId('la-answer-send').boundingBox()
    expect(send && send.height >= 44 && send.x + send.width <= 375 + 1).toBe(true)
    await answerPoll(guest.page, [2])

    // the facilitator sees the count and the live results; participants see neither until the reveal
    await expectAnswered(alice.page, 3)
    await expect(panel(alice.page).getByTestId('la-poll-results')).toBeVisible()
    await expect(panel(bob.page).getByTestId('la-poll-results')).toHaveCount(0)
    await expect(panel(bob.page).getByTestId('la-results-later')).toBeVisible()
    // a changed answer replaces the old one (one answer each)
    await panel(carol.page).getByTestId('la-choice-1').check()
    await panel(carol.page).getByTestId('la-answer-send').click()
    await expect(panel(carol.page).getByTestId('la-answer-status')).toContainText('Your answer is in')
    await expectAnswered(alice.page, 3)

    await panel(alice.page).getByTestId('la-reveal').click()
    for (const page of [alice.page, bob.page, carol.page, guest.page]) {
      const rows = panel(page).locator('[data-testid="la-poll-results"] > li')
      await expect(rows).toHaveCount(3)
      await expect
        .poll(() => rows.evaluateAll((l) => l.map((e) => e.getAttribute('data-count'))))
        .toEqual(['0', '1', '2'])
    }
    await expect(alice.page.getByTestId('facilitate-pill-activities')).toHaveCount(0)

    // the receivers' pushes so far: they write nothing from here on
    const before = await Promise.all(
      [bob.page, carol.page, guest.page].map(async (p) => (await pushedOps(p)).length),
    )

    await panel(alice.page).getByTestId('la-to-board').click()
    await expect(alice.page.getByTestId('la-toast')).toContainText('on the board')
    await expectSaved(alice.page)
    const mine = await placed(alice.page, KIND)
    expect(mine.filter((e) => e.type === 'frame')).toHaveLength(1)
    expect(mine.filter((e) => e.type === 'rectangle')).toHaveLength(2)
    const texts = mine.filter((e) => e.type === 'text').map((e) => (e as unknown as { text: string }).text)
    expect(texts).toEqual(expect.arrayContaining(['Monday', 'Wednesday', 'Friday', '2 · 67%']))
    await expect(panel(alice.page).getByTestId('la-placed')).toBeVisible()

    // stored: the facilitator wrote every one; no participant is named anywhere in them
    const stored = (await serverSnapshot(stack, board)).elements.filter(
      (e) =>
        !e.isDeleted && (e.customData as { lobby?: { kind?: unknown } } | undefined)?.lobby?.kind === KIND,
    )
    expect(stored).toHaveLength(mine.length)
    const people = [bob.id, carol.id, guest.id, bob.name, carol.name, guest.name]
    for (const e of stored) {
      expect(
        (e.customData as { lobbyServer?: { createdBy?: { uid?: unknown } } }).lobbyServer?.createdBy?.uid,
        e.id,
      ).toBe(alice.id)
      const all = stringsIn(e).join('\n')
      for (const who of people) expect(all, e.id).not.toContain(who)
      expect(all).not.toMatch(/data:|blob:/)
    }

    // the others see it, and push nothing while they only receive
    for (const page of [bob.page, carol.page, guest.page])
      await expect.poll(async () => (await placed(page, KIND)).length).toBe(mine.length)
    const after = await Promise.all(
      [bob.page, carol.page, guest.page].map(async (p) => (await pushedOps(p)).length),
    )
    expect(after).toEqual(before)

    // one undo step takes it all back
    await focusCanvas(alice.page)
    await alice.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await placed(alice.page, KIND)).length).toBe(0)
    await expectSaved(alice.page)
    await expect.poll(async () => (await placed(bob.page, KIND)).length).toBe(0)

    expect([...foreign.flat(), ...guest.foreign]).toEqual([])
  } finally {
    for (const c of opened) await c.close()
  }
})

test('a guest cannot start one, and a facilitator cannot start a second while one is open', async ({
  join,
  board,
  browser,
}) => {
  const alice = await withLive(await join('alice'))
  const opened: BrowserContext[] = []
  try {
    const guest = await guestJoins(browser, await workshopLink(alice, board), 'Gia Guest', opened, {
      viewport: { width: 1280, height: 800 },
    })
    // a name-only guest is offered no setup (and the api refuses one anyway: GUEST_ACCOUNT_REQUIRED)
    await guest.page.getByTestId('facilitate-button').click()
    await expect(guest.page.getByTestId('facilitate-activities')).toHaveCount(0)
    await guest.page.keyboard.press('Escape')
    const refused = await guest.page.evaluate(async (bid) => {
      const r = await fetch(`/api/boards/${bid}/activities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'words', prompt: 'x', config: { maxWords: 1 } }),
      })
      return r.status
    }, board)
    expect(refused).toBe(403)

    await startActivity(alice.page, { kind: 'words', prompt: 'One word for today?', maxWords: 1 })
    // the guest takes part
    await expect(guest.page.getByTestId('facilitate-pill-activities')).toHaveText('Words')
    // a second start is refused while this one is open (ACTIVITY_OPEN), and says so
    const r = await alice.api.fetch('POST', `/api/boards/${board}/activities`, {
      kind: 'poll',
      prompt: 'Another?',
      config: { options: ['a', 'b'] },
    })
    expect(r.status()).toBe(409)
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('ACTIVITY_OPEN')
    // cancel: nothing to show, the pill goes for everyone
    await panel(alice.page).getByTestId('la-cancel').click()
    await panel(alice.page).getByTestId('la-cancel-confirm').click()
    await expect(guest.page.getByTestId('facilitate-pill-activities')).toHaveCount(0)
    // the integration, against the real api: the cancel answers the board without the cancelled activity (none here)
    await expect(panel(alice.page)).toHaveAttribute('data-status', 'none')
    const after = await alice.api.fetch('GET', `/api/boards/${board}/activity`)
    expect(((await after.json()) as { activity: unknown }).activity).toBeNull()
  } finally {
    for (const c of opened) await c.close()
  }
})

// The integration, against the real api (WS1 answers an answer on an archived board 409 BOARD_READ_ONLY): the panel says
// the board is archived and offers no answer sheet any more, whichever way the page learns of the archive first.
test('an archived board: an answer the api refuses as read-only says so, and no answer sheet is offered', async ({
  join,
  board,
}) => {
  const alice = await withLive(await join('alice'))
  const bob = await withLive(await join('bob', 'editor'))
  await startActivity(alice.page, { kind: 'poll', prompt: 'Ship it this week?' })
  const p = await openActivityPanel(bob.page)
  await p.getByTestId('la-choice-0').check()
  const archived = await alice.api.fetch('POST', `/api/boards/${board}/archive`, {})
  expect(archived.status()).toBe(200)
  // the api refuses the answer itself
  const refused = await bob.api.fetch(
    'POST',
    `/api/activities/${await p.getAttribute('data-activity-id')}/answer`,
    {
      answer: { kind: 'poll', choices: [0] },
    },
  )
  expect(refused.status()).toBe(409)
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('BOARD_READ_ONLY')
  // the page may have learned of the archive on its own: archiving closed the activity (the fix wave, review m2: an
  // archived board's activities stop taking answers, and an anonymous one keeps no answer row), so the panel says
  // answers are closed and the sheet is gone; else the send meets the 409 and the panel says the board is archived
  const send = p.getByTestId('la-answer-send')
  if (await send.isVisible()) await send.click({ timeout: 5_000 }).catch(() => {})
  await expect(p).toContainText(/This board is archived: answers are closed\.|Answers are closed\./)
  await expect(p.getByTestId('la-answer-send')).toHaveCount(0)
})
