// L5-1 (wave L) Run of show: minutes per frame in the Frames panel, a section timer that starts as the presenter
// moves, and the agenda strip with presenter-only drift. Two browsers: alice (owner) plans a 2 minute and a 1
// minute section and presents to everyone; bob follows. The api's timer is the second witness.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- l5-agenda
import type { Page } from '@playwright/test'
import { CONNECT_URL } from '../spike-b/support/relay.ts'
import { item } from '../tests/support/canvas.ts'
import { focusBoard, pushCount } from './board-kit.ts'
import { startPresenting } from './present-kit.ts'
import {
  expect,
  expectItemsEverywhere,
  post,
  reloadBoard,
  seed,
  test,
  type WorkshopCanvasSession,
} from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const row = (page: Page, id: string) => page.locator(`[data-testid="frame-row"][data-frame-id="${id}"]`)
const minsOf = async (page: Page, id: string) =>
  ((await item(page, id))?.customData?.lobby?.present as { mins?: number } | undefined)?.mins ?? null
const strip = (page: Page) => page.getByTestId('agenda-strip')

/** "m:ss" in a strip's line as seconds (the first time shown), or null. */
const clockOf = async (page: Page): Promise<number | null> => {
  const text =
    (await strip(page)
      .getByTestId('agenda-line')
      .textContent({ timeout: 2_000 })
      .catch(() => null)) ?? ''
  const m = /(\d+):(\d\d) left/.exec(text)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

interface Timer {
  status: string
  durationMs: number
  startedBy: string | null
}
const timerOf = async (s: WorkshopCanvasSession, board: string): Promise<Timer | null> => {
  const res = await s.api.fetch('GET', `/api/boards/${board}/workshop`)
  expect(res.status()).toBe(200)
  return ((await res.json()) as { timer: Timer | null }).timer
}

/** Wakes the presentation controls (they hide after 2 s without pointer movement). */
async function wake(page: Page) {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 }
  await page.mouse.move(vp.width / 2 + Math.random() * 40, vp.height / 2 + Math.random() * 40, { steps: 2 })
}

/** Plans `target` minutes on the frame's row with the stepper (5 first, then down by one). */
async function planMinutes(page: Page, id: string, target: number) {
  await row(page, id).getByTestId('frame-mins-add').click()
  for (let m = 5; m > target; m--) await row(page, id).getByTestId('frame-mins-down').click()
  await expect(row(page, id).getByTestId('frame-mins')).toContainText(`${target} min`)
}

async function twoSections(a: WorkshopCanvasSession, others: WorkshopCanvasSession[]) {
  await seed(a.page, {
    frames: [
      { id: 'l5-one', x: 0, y: 0, w: 800, h: 450, name: 'Alpha' },
      { id: 'l5-two', x: 1000, y: 0, w: 800, h: 450, name: 'Beta' },
    ],
  })
  await expectItemsEverywhere(others, ['l5-one', 'l5-two'])
}

test('L5-1: minutes per frame, one undo step each; the follower sees the section and its time, and Next starts the next timer; the follower pushes nothing', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoSections(a, [b])

  await test.step('the Frames panel plans minutes: 2 and 1; bob sees them; one Ctrl+Z takes the last press back', async () => {
    await a.page.getByTestId('dock-tab-frames').click()
    await expect(a.page.getByTestId('frame-outline')).toBeVisible()
    await planMinutes(a.page, 'l5-one', 2)
    await row(a.page, 'l5-two').getByTestId('frame-mins-add').click()
    await expect.poll(() => minsOf(a.page, 'l5-two')).toBe(5)
    // the whole press is one undo step: Ctrl+Z restores the frame to no minutes
    await focusBoard(a.page)
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => minsOf(a.page, 'l5-two')).toBeNull()
    await expect(row(a.page, 'l5-two').getByTestId('frame-mins-add')).toBeVisible()
    await a.page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => minsOf(a.page, 'l5-two')).toBe(5)
    for (let m = 5; m > 1; m--) await row(a.page, 'l5-two').getByTestId('frame-mins-down').click()
    await expect(row(a.page, 'l5-two').getByTestId('frame-mins')).toContainText('1 min')
    await expect.poll(() => minsOf(a.page, 'l5-one')).toBe(2)
    await expect.poll(() => minsOf(a.page, 'l5-two')).toBe(1)
    // bob receives them through sync (his panel shows them as text: his stepper is there too, he edits)
    await expect.poll(() => minsOf(b.page, 'l5-one')).toBe(2)
    await expect.poll(() => minsOf(b.page, 'l5-two')).toBe(1)
  })

  const before = await pushCount(b.page)

  await test.step('alice presents to everyone: bob follows and sees "1 of 2 · Alpha · 1:5x" within the event latency', async () => {
    await startPresenting(a.page.getByTestId('present-button'))
    await expect(a.page.getByTestId('live-presenting')).toBeVisible()
    await expect(b.page.getByTestId('live-invite')).toBeVisible({ timeout: 5_000 })
    await b.page.getByTestId('live-join').click()
    await expect(b.page.getByTestId('live-following')).toBeVisible()
    for (const s of [a, b]) {
      await expect(strip(s.page).getByTestId('agenda-line')).toContainText('Section 1 of 2 · Alpha · 1:5', {
        timeout: 8_000,
      })
      await expect(strip(s.page).getByTestId('agenda-line')).toContainText('next: Beta')
    }
    // the api's timer is the second witness: alice's, 2 minutes
    const timer = await timerOf(a, board)
    expect(timer).toMatchObject({ status: 'running', durationMs: 120_000, startedBy: a.id })
  })

  await test.step('drift is the presenter’s: "Planned 3 min · on time" for alice, nothing for bob', async () => {
    await expect(a.page.getByTestId('agenda-drift')).toHaveText('Planned 3 min · on time')
    await expect(b.page.getByTestId('agenda-drift')).toHaveCount(0)
    await expect(a.page.getByTestId('agenda-autotime')).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('Next: both see about 1:00 on "2 of 2 · Beta", the same on both', async () => {
    await a.page.keyboard.press('ArrowRight')
    for (const s of [a, b]) {
      await expect(strip(s.page).getByTestId('agenda-line')).toContainText('Section 2 of 2 · Beta', {
        timeout: 8_000,
      })
      await expect
        .poll(async () => (await clockOf(s.page)) ?? -1, { message: `${s.name} sees about 1:00` })
        .toBeGreaterThanOrEqual(50)
      expect(await clockOf(s.page)).toBeLessThanOrEqual(60)
    }
    const [x, y] = await Promise.all([clockOf(a.page), clockOf(b.page)])
    expect(Math.abs((x ?? 0) - (y ?? 0))).toBeLessThanOrEqual(3)
    expect(await timerOf(a, board)).toMatchObject({ status: 'running', durationMs: 60_000, startedBy: a.id })
    // the last section has no next one
    await expect(strip(b.page).getByTestId('agenda-line')).not.toContainText('next:')
  })

  await test.step('bob pushed nothing to the board while following (the receive-only rule)', async () => {
    expect(await pushCount(b.page)).toBe(before)
  })

  await test.step('"Times each section" off: the next slide change starts no timer', async () => {
    await wake(a.page)
    await expect(a.page.getByTestId('agenda-autotime')).toHaveText('Times each section')
    await a.page.getByTestId('agenda-autotime').click()
    await expect(a.page.getByTestId('agenda-autotime')).toHaveAttribute('aria-pressed', 'false')
    const started = (await timerOf(a, board))?.durationMs
    await a.page.keyboard.press('ArrowLeft')
    await expect(strip(a.page).getByTestId('agenda-line')).toContainText('Section 1 of 2 · Alpha')
    await a.page.waitForTimeout(800)
    expect((await timerOf(a, board))?.durationMs).toBe(started) // still the 1 minute timer of Beta
  })

  await a.page.keyboard.press('Escape')
  await expect(b.page.getByTestId('present-overlay')).toHaveCount(0)
})

test('L5-1: with a second facilitator holding the timer, a slide change leaves that timer running and the strip names the holder', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const c = await join('carol', 'editor')
  await twoSections(a, [b, c])
  await a.page.getByTestId('dock-tab-frames').click()
  await planMinutes(a.page, 'l5-one', 2)
  await planMinutes(a.page, 'l5-two', 1)
  await expect.poll(() => minsOf(c.page, 'l5-two')).toBe(1)

  // carol runs her own 10 minute timer before alice presents
  const r = await post(c, `/api/boards/${board}/timer`, { action: 'start', durationMs: 600_000 })
  expect(r.status(), await r.text()).toBe(200)

  await startPresenting(a.page.getByTestId('present-button'))
  await expect(a.page.getByTestId('live-presenting')).toBeVisible()
  await expect(b.page.getByTestId('live-invite')).toBeVisible({ timeout: 5_000 })
  await b.page.getByTestId('live-join').click()

  for (const s of [a, b]) {
    await expect(strip(s.page).getByTestId('agenda-line')).toContainText(
      `Section 1 of 2 · Alpha · ${c.name} holds the timer`,
      { timeout: 8_000 },
    )
  }
  await a.page.keyboard.press('ArrowRight')
  for (const s of [a, b])
    await expect(strip(s.page).getByTestId('agenda-line')).toContainText(
      `Section 2 of 2 · Beta · ${c.name} holds the timer`,
      { timeout: 8_000 },
    )
  // carol's timer was neither stopped nor restarted by the slide changes
  await a.page.waitForTimeout(500)
  expect(await timerOf(a, board)).toMatchObject({ status: 'running', durationMs: 600_000, startedBy: c.id })
  await a.page.keyboard.press('Escape')
})

test('L5-1: in a room that says revision 11 (a sync from before wave L) the minutes stepper is not offered, and the minutes already there are plain text', async ({
  join,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await twoSections(a, [b])
  await a.page.getByTestId('dock-tab-frames').click()
  await planMinutes(a.page, 'l5-one', 2)

  // bob's tab is told by its room that the room is revision 11: the `contracts` frame is rewritten on the way
  await b.page.routeWebSocket(CONNECT_URL, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) =>
      ws.send(
        typeof m === 'string'
          ? m.replace('{"type":"contracts","rev":12}', '{"type":"contracts","rev":11}')
          : m,
      ),
    )
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
  })
  await reloadBoard(b)
  await expectItemsEverywhere([b], ['l5-one', 'l5-two'])
  await b.page.getByTestId('dock-tab-frames').click()
  await expect(b.page.getByTestId('frame-outline')).toBeVisible()
  await expect(row(b.page, 'l5-one').getByTestId('frame-mins-read')).toHaveText('2 min')
  await expect(b.page.getByTestId('frame-mins-stepper')).toHaveCount(0)
  await expect(b.page.getByTestId('frame-mins-add')).toHaveCount(0)
  // and in a room that says 12, the same person gets it
  await expect(a.page.getByTestId('frame-mins-stepper')).toHaveCount(2)
})
