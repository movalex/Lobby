// B12, phone flows (docs/EXCALIDRAW-MIGRATION.md §8.3, §4.8): guest, sheet, timer and voting under
// Playwright touch emulation at 390 px. (Phone editing through the lease, B3 L11, is O2's.)
//
// A: the board's owner and facilitator (desktop). G: a name-only guest (a workshop link, A3's `guest`
// claim) in a 390 × 844 touch browser. Pass: G's board loads with the guest claim (roster says guest);
// nothing scrolls sideways; the sheet opens, fits and offers the tools (no facilitator actions for a
// guest); A's timer counts down on G; G taps the Vote tool and a note: the dot is cast, the note is not
// selected, +1 is off while the vote runs; G pushes 0 ops for all of it; every map converges.
// Evidence: docs/research/excalidraw/spike-b/B12.md.
import { expect, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import { stackFromEnv } from '../support/ports.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import {
  centreOf,
  createNote,
  featuresReady,
  joinAsGuest,
  noSidewaysScroll,
  saved,
  seen,
} from './b7-b12-kit.ts'

test.describe.configure({ mode: 'serial' })

let stack: SpikeBStack
let A: BrowserProcess
let G: BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack({ base: stackFromEnv().base })
  const alice = harness.devUser('b12-alice')
  ;({ boardId } = await stack.createBoard({ owner: alice }))
  A = await harness.launchBrowser(stack, alice, { name: 'A' })
  G = await harness.launchBrowser(stack, harness.devUser('b12-guest'), {
    name: 'G',
    guest: true,
    touch: true,
    viewport: { width: 390, height: 844 },
  })
  await A.openBoard(boardId)
  await featuresReady(A.page)
})

test.afterAll(async () => {
  await G?.close()
  await A?.close()
  await stack?.stop()
})

test('guest at 390 px: the board, the sheet, the timer and a vote by tap; 0 ops pushed', async () => {
  const horizonAtStart = (await harness.readSnapshot(stack, boardId)).horizon
  const n1 = await createNote(A.page, 40, 80, 'Idea one')
  const n2 = await createNote(A.page, 40, 320, 'Idea two')
  await saved(A.page)

  const guestUid = await joinAsGuest(A, G, boardId, 'Sam')
  await featuresReady(G.page)
  await seen([G], n1)
  const me = await G.page.evaluate(() => window.lobbySpikeFeatures?.me())
  expect(me).toMatchObject({ uid: guestUid, guest: true, role: 'editor' })
  await expect
    .poll(() =>
      A.page.evaluate(
        (uid) => window.lobbyCanvas?.collaborators().find((c) => c.uid === uid)?.guest,
        guestUid,
      ),
    )
    .toBe(true)
  const gPushes = await harness.recordPushes(G.page)
  expect(await noSidewaysScroll(G.page)).toBe(true)

  // ---- the sheet: opens by tap, fits 390 px, offers the tools; a guest never facilitates ----
  await expect(G.page.locator('[data-lobby-features-toolbar]')).toHaveCount(0) // the desktop bar is off
  const open = G.page.locator('[data-lobby-sheet-open]')
  await expect(open).toBeVisible()
  await open.tap()
  const sheet = G.page.locator('[data-lobby-sheet]')
  await expect(sheet).toBeVisible()
  const box = await sheet.boundingBox()
  expect(box?.width ?? 999).toBeLessThanOrEqual(390)
  expect(await noSidewaysScroll(G.page)).toBe(true)
  await expect(sheet.locator('[data-lobby-tool="vote"]')).toBeVisible()
  await expect(sheet.locator('[data-lobby-tool="comment"]')).toBeVisible()
  await expect(sheet.locator('[data-lobby-action="vote-start"]')).toHaveCount(0)
  await expect(sheet.locator('[data-lobby-action="timer-start"]')).toHaveCount(0)
  await G.page.locator('[data-lobby-sheet-close]').tap()
  await expect(sheet).toHaveCount(0)

  // ---- the timer: A starts 5:00; G sees it count down ----
  await A.page.evaluate(() => window.lobbySpikeFeatures?.startTimer(5 * 60_000))
  const timer = G.page.locator('[data-lobby-timer]')
  await expect(timer).toBeVisible({ timeout: 10_000 })
  await expect(timer).toHaveText(/^[45]:\d\d$/)
  const r1 = Number(await timer.getAttribute('data-remaining-ms'))
  await G.page.waitForTimeout(1_500)
  const r2 = Number(await timer.getAttribute('data-remaining-ms'))
  expect(r2).toBeLessThan(r1)

  // ---- voting by tap: A opens a vote; G taps Vote in the sheet, then the note ----
  await A.page.evaluate(() => window.lobbySpikeFeatures?.startVote({ votesPerPerson: 3 }))
  await expect
    .poll(async () => (await G.page.evaluate(() => window.lobbySpikeFeatures?.workshop()))?.voteOpen)
    .toBe(true)
  await open.tap()
  const voteBtn = G.page.locator('[data-lobby-sheet] [data-lobby-tool="vote"]')
  await expect(voteBtn).toBeEnabled()
  await expect(G.page.locator('[data-lobby-sheet] [data-lobby-action="plus-one"]')).toBeDisabled()
  await voteBtn.tap()
  await expect(sheet).toHaveCount(0)
  expect(await G.page.evaluate(() => window.lobbyCanvas?.tool())).toBe('vote')
  const at = await centreOf(G.page, n1)
  await G.page.touchscreen.tap(at.x, at.y)
  await expect
    .poll(
      async () =>
        (await G.page.evaluate(() => window.lobbySpikeFeatures?.workshop()))?.myVotes[`shape:${n1}`],
    )
    .toBe(1)
  expect(await G.page.evaluate(() => window.lobbyCanvas?.selection() ?? [])).toEqual([])
  // +1 is off while the vote runs (the server refuses it too: F13, O1's)
  expect(await G.page.evaluate((id) => window.lobbySpikeFeatures?.plusOne(id, true), n2)).toBe(false)
  expect(await noSidewaysScroll(G.page)).toBe(true)

  // ---- G wrote nothing to the canvas; everyone converges ----
  expect(await gPushes.count()).toBe(0)
  const report = await harness.converged(stack, boardId, [A, G], { horizonAtStart })
  expect(report.horizonMoved).toBe(false)
  expect(report.ok).toBe(true)
  expect(harness.checkInvariants(report.snapshot).violations).toEqual([])
  await A.page.evaluate(() => window.lobbySpikeFeatures?.stopTimer())
  console.log(
    'B12-METRICS phone',
    JSON.stringify({
      guest: guestUid,
      sheetWidth: box?.width,
      timer: [r1, r2],
      gPushes: await gPushes.count(),
    }),
  )
})
