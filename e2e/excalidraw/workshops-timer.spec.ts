// OWNER: 3f. The shared workshop timer on the Excalidraw board page, ported from tests/workshops.spec.ts
// ("timer sync", "time's up") and tests/workshops-3.fix.spec.ts (R3: a teammate's running timer is theirs).
// alice = board owner and facilitator, bob = editor, carol = viewer; dave and erin join late.
//
// Split from the tldraw tests: the steps that present the board need present mode (3e's `present-button`
// on this page). They are their own tests, marked as expected to fail until 3e's present mode is on the
// Excalidraw page (remove the marks at the wave-3 integration).
import { createItem } from '../tests/support/canvas.ts'
import { capture } from '../tests/support/screenshots.ts'
import {
  clockSeconds,
  closeWorkshopPopover,
  expectPillsAgree,
  openWorkshopPopover,
  pillSeconds,
  pillSpread,
  workshopState,
} from '../tests/support/workshops.ts'
import {
  expect,
  expectItemsEverywhere,
  oscillatorStarts,
  post,
  reloadBoard,
  seed,
  test,
  type WorkshopCanvasSession,
} from './workshops-kit.ts'

test('timer sync: start, pause, +1 min, resume and stop look the same to everyone; late joiners agree within 1 s; a viewer cannot set it', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'viewer')
  const pages = [a.page, b.page, c.page]

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
    for (const p of pages) expect(await pillSeconds(p)).toBeLessThanOrEqual(300)
    const t = (await workshopState(c.api, board)).timer
    expect(t).toMatchObject({ status: 'running', durationMs: 300_000 })
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
    const e = await join('erin', 'viewer', { busyAfterEventStreamMs: 2_000 })
    await expect(e.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')
    await expectPillsAgree([a.page, e.page])
    await e.context.close()
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
    await a.page.waitForTimeout(1_500) // frozen: the duration is what is under test
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

test('timer sync: while carol presents, the timer floats over the slides (3e present mode)', async ({
  join,
  board,
}, testInfo) => {
  const a = await join('alice')
  const c = await join('carol', 'viewer')
  await seed(a.page, { frames: [{ id: 'wk-agenda', x: 0, y: 0, w: 800, h: 450, name: 'Agenda' }] })
  await expectItemsEverywhere([c], ['wk-agenda'])
  expect(
    (await post(a, `/api/boards/${board}/timer`, { action: 'start', durationMs: 300_000 })).status(),
  ).toBe(200)
  await expect(c.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')
  await c.page.getByTestId('present-button').click({ timeout: 5_000 })
  await expect(c.page.getByTestId('present-overlay')).toBeVisible()
  const floating = c.page.getByTestId('timer-floating')
  await expect(floating).toBeVisible()
  await expect(floating).toHaveAttribute('data-state', 'running')
  await expect
    .poll(async () => Math.abs(clockSeconds(await floating.innerText()) - (await pillSeconds(a.page))))
    .toBeLessThanOrEqual(1)
  await capture('lc-workshops-timer-presenting.png', c.page, testInfo)
  await c.page.keyboard.press('Escape')
  await expect(c.page.getByTestId('present-overlay')).toHaveCount(0)
  await expect(floating).toHaveCount(0)
})

// ---- [P1] time's up ---------------------------------------------------------------------------------------

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
    await Promise.all(
      everyone.map((s) => expect(s.page.getByTestId('timer-flash')).toBeVisible({ timeout: 10_000 })),
    )
    zeroAt = Date.now()
    for (const s of everyone) {
      await expect(s.page.getByTestId('timer-finished')).toContainText("Time's up")
      // One message only (RETRO-23a): the flash's, no toast on top of it (the board itself is called
      // "Time's up" here, so only the canvas and the notices are counted).
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
    expect(Date.now() - zeroAt).toBeGreaterThan(5_000)
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
})

test("time's up: presenting a board whose timer has finished shows no floating timer (3e present mode)", async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const c = await join('carol', 'viewer')
  expect((await post(a, `/api/boards/${board}/timer`, { action: 'start', durationMs: 2_000 })).status()).toBe(
    200,
  )
  await expect(c.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'finished', {
    timeout: 10_000,
  })
  await createItem(a.page, 'frame', { id: 'wk-tu-frame', x: 0, y: 0, width: 400, height: 300, name: 'Slide' })
  await expectItemsEverywhere([c], ['wk-tu-frame'])
  await c.page.getByTestId('present-button').click({ timeout: 5_000 })
  await expect(c.page.getByTestId('present-overlay')).toBeVisible()
  await expect(c.page.getByTestId('timer-floating')).toHaveCount(0)
  await c.page.keyboard.press('Escape')
  await expect(c.page.getByTestId('present-overlay')).toHaveCount(0)
})

// ---- R3: someone else's running timer (workshops-3.fix) -----------------------------------------------------

test("the timer: a teammate can't pause the facilitator's running timer; the owner and its starter can (R3)", async ({
  join,
  board,
}, testInfo) => {
  const alice = await join('alice', 'owner')
  const bob = await join('bob', 'editor')
  const carol = await join('carol', 'editor')
  const timer = (s: WorkshopCanvasSession, body: unknown) => post(s, `/api/boards/${board}/timer`, body)
  expect((await timer(bob, { action: 'start', durationMs: 5 * 60_000 })).status()).toBe(200)
  await expect(carol.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')

  const pop = await openWorkshopPopover(carol.page)
  await expect(pop.getByTestId('timer-held-hint')).toHaveText(
    /Bob .* is running this timer\. Only they or the board owner can pause, stop or change it\./,
  )
  for (const id of ['timer-pause', 'timer-stop', 'timer-add-1m', 'timer-start'])
    await expect(pop.getByTestId(id), id).toHaveCount(0)
  await capture('lc-workshops3-teammate-timer-popover.png', carol.page, testInfo)
  const refused = await timer(carol, { action: 'pause' })
  expect(refused.status()).toBe(403)
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('TIMER_NOT_YOURS')
  await expect(bob.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')

  const bobPop = await openWorkshopPopover(bob.page)
  await expect(bobPop.getByTestId('timer-pause')).toBeVisible()
  const alicePop = await openWorkshopPopover(alice.page)
  await alicePop.getByTestId('timer-pause').click()
  await expect(carol.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'paused')
})
