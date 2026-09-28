// Phones and overlays from the second review (docs/BACKLOG.md), driven through the real UI:
//   A11Y2-06: with a multi-selection on a phone, the selection bar stays on screen; align, distribute
//     and arrange fold into "More";
//   R2-04: "Gather everyone" shows a phone the leader's view at a readable zoom, not about 11%;
//   R13 / A11Y-06: on a phone the rail folds behind one button and a panel is a full-width sheet;
//   R2-07: an open workshop popover sits above the notices and the canvas's cursors;
//   A11Y2-05: top-bar popovers (People, Reactions, Notifications) close when the keyboard leaves.
import type { Page } from '@playwright/test'
import { edit, read } from './support/board.ts'
import { capture } from './support/screenshots.ts'
import { center, expect, moveCamera, openWorkshopPopover, test, viewState } from './support/workshops.ts'

const PHONE = { width: 390, height: 844 }

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function boxOf(page: Page, testId: string): Promise<Box> {
  const b = await page.getByTestId(testId).boundingBox()
  if (!b) throw new Error(`${testId} has no box`)
  return b
}

const within = (b: Box, w: number) => b.x >= 0 && b.x + b.width <= w

/** The canvas width tldraw has measured (it follows a window resize a moment later). */
const screenWidth = (page: Page) =>
  read(
    page,
    (ed) => (ed as unknown as { getViewportScreenBounds(): { w: number } }).getViewportScreenBounds().w,
  )

/** Three notes side by side in the middle of the view, all selected. */
async function selectThreeNotes(page: Page) {
  await expect.poll(() => screenWidth(page)).toBeLessThanOrEqual(PHONE.width)
  await edit(page, (ed) => {
    const e = ed as unknown as {
      getViewportPageBounds(): { x: number; y: number; w: number; h: number }
      createShapes(s: unknown[]): void
      select(...ids: string[]): void
    }
    const b = e.getViewportPageBounds()
    const ids = ['shape:phone-sel-0', 'shape:phone-sel-1', 'shape:phone-sel-2']
    e.createShapes(
      ids.map((id, i) => ({
        id,
        type: 'note',
        x: b.x + b.w / 2 - 330 + i * 230,
        y: b.y + b.h / 2 - 100 - i * 40,
      })),
    )
    e.select(...ids)
  })
}

test('A11Y2-06: on a phone a multi-selection keeps the selection bar on screen; arrange waits behind More', async ({
  join,
}, testInfo) => {
  const a = await join('alice')
  await a.page.setViewportSize(PHONE)
  await selectThreeNotes(a.page)
  const bar = a.page.getByTestId('selection-bar')
  await expect(bar).toBeVisible()
  await expect(bar).toHaveAttribute('data-compact', 'true')
  expect(within(await boxOf(a.page, 'selection-bar'), PHONE.width)).toBe(true)
  await expect(bar.getByTestId('align-left')).toHaveCount(0)
  await capture('phone-overlays-01-selbar-folded.png', a.page, testInfo)

  const more = bar.getByTestId('selection-more')
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await expect(bar.getByTestId('selection-more-row')).toBeVisible()
  for (const id of [
    'align-left',
    'align-bottom',
    'distribute-horizontal',
    'distribute-vertical',
    'arrange-grid',
  ]) {
    const b = await boxOf(a.page, id)
    expect(within(b, PHONE.width), `${id} at x=${b.x}`).toBe(true)
  }
  expect(within(await boxOf(a.page, 'selection-bar'), PHONE.width)).toBe(true)
  await capture('phone-overlays-02-selbar-more-open.png', a.page, testInfo)

  const ys = () =>
    read(a.page, (ed) =>
      ['shape:phone-sel-0', 'shape:phone-sel-1', 'shape:phone-sel-2'].map((id) =>
        Math.round((ed.getShape(id) as { y: number } | undefined)?.y ?? 0),
      ),
    )
  await bar.getByTestId('align-top').click()
  await expect.poll(async () => new Set(await ys()).size).toBe(1)

  await test.step('a desktop-width canvas keeps every button in the bar', async () => {
    await a.page.setViewportSize({ width: 1280, height: 720 })
    await expect(bar).not.toHaveAttribute('data-compact', 'true')
    await expect(bar.getByTestId('align-left')).toBeVisible()
    await expect(bar.getByTestId('selection-more')).toHaveCount(0)
  })
})

test('R2-04: "Gather everyone" shows a phone the leader view at a readable zoom', async ({
  join,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await a.page.setViewportSize({ width: 1440, height: 900 })
  await b.page.setViewportSize(PHONE)
  await moveCamera(a.page, { x: 400, y: 200, z: 0.44 })
  const pop = await openWorkshopPopover(a.page)
  await pop.getByTestId('summon-button').click()
  await expect(b.page.getByTestId('follow-toast')).toBeVisible()
  await expect.poll(async () => (await viewState(b.page)).following).toBe(`user:${a.id}`)
  // tldraw alone fits alice's whole 1440 px view into 390 px: about 0.12.
  await expect.poll(async () => (await viewState(b.page)).zoom, { timeout: 10_000 }).toBeGreaterThan(0.43)
  const [bv, av] = await Promise.all([viewState(b.page), viewState(a.page)])
  expect(bv.zoom).toBeLessThan(0.45)
  const bc = center(bv.bounds)
  const ac = center(av.bounds)
  expect(Math.abs(bc.x - ac.x)).toBeLessThanOrEqual(3)
  expect(Math.abs(bc.y - ac.y)).toBeLessThanOrEqual(3)
  await capture('phone-overlays-03-gathered-phone.png', b.page, testInfo)
  // It still follows: alice moves, bob's view goes with her.
  await moveCamera(a.page, { x: -600, y: 100, z: 0.44 })
  await expect
    .poll(async () => {
      const [f, l] = await Promise.all([viewState(b.page), viewState(a.page)])
      return Math.abs(center(f.bounds).x - center(l.bounds).x) <= 3
    })
    .toBe(true)
})

test('R13 / A11Y-06: on a phone the rail folds behind one button and a panel opens as a full-width sheet', async ({
  join,
}, testInfo) => {
  const a = await join('alice')
  await a.page.setViewportSize(PHONE)
  const canvasWidth = () =>
    a.page.evaluate(() => document.querySelector('.dr-board__canvas')?.getBoundingClientRect().width ?? 0)
  await expect.poll(canvasWidth).toBe(PHONE.width)
  const toggle = a.page.getByTestId('dock-rail-toggle')
  await expect(toggle).toBeVisible()
  await expect(a.page.getByTestId('dock-tab-history')).toBeHidden()
  // tldraw's page menu sits beside the fold button, not under it.
  const menu = await a.page.locator('.tlui-layout__top__left .tlui-menu-zone').boundingBox()
  const t = await boxOf(a.page, 'dock-rail-toggle')
  expect(menu && menu.x >= t.x + t.width).toBe(true)
  await capture('phone-overlays-04-rail-folded.png', a.page, testInfo)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(a.page.getByTestId('dock-tab-history')).toBeVisible()
  await expect(a.page.getByTestId('dock-tab-history')).toContainText('History')
  await capture('phone-overlays-05-rail-open.png', a.page, testInfo)
  // A press on the board beside the open list folds it away.
  await a.page.mouse.click(330, 500)
  await expect(a.page.getByTestId('dock-tab-history')).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()

  await a.page.getByTestId('dock-tab-history').click()
  const panel = a.page.getByTestId('dock-panel-history')
  await expect(panel).toBeVisible()
  const p = await boxOf(a.page, 'dock-panel-history')
  expect(Math.round(p.x)).toBe(0)
  expect(Math.round(p.width)).toBe(PHONE.width)
  // The canvas keeps its size under the sheet (tldraw's controls are not pushed off-screen).
  expect(await canvasWidth()).toBe(PHONE.width)
  await expect(toggle).toBeHidden()
  await capture('phone-overlays-06-panel-sheet.png', a.page, testInfo)

  await a.page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(toggle).toBeFocused()
  await expect(a.page.getByTestId('dock-tab-history')).toBeHidden()

  await test.step('on a desktop the rail is a column with every button and no fold button', async () => {
    await a.page.setViewportSize({ width: 1280, height: 720 })
    await expect(toggle).toBeHidden()
    await expect(a.page.getByTestId('dock-tab-history')).toBeVisible()
  })
})

test('R2-07: an open workshop popover stays above the notices and the canvas cursors; no "Show queue" toast over an open queue', async ({
  join,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const pop = await openWorkshopPopover(a.page)
  const zIndex = () =>
    a.page.evaluate(() => Number(getComputedStyle(document.querySelector('.dr-topbar') as Element).zIndex))
  // Above tldraw's panels (300) and collaborator cursors (245).
  expect(await zIndex()).toBeGreaterThan(300)
  await b.page.getByTestId('reactions-button').click()
  await b.page.getByTestId('hand-toggle').click()
  await expect(pop.getByTestId('hands-queue')).toContainText(b.name)
  await a.page.waitForTimeout(500)
  await expect(a.page.getByTestId('hand-toast-open')).toHaveCount(0)
  // Whatever notice shows, the popover's own buttons are the top element where they are drawn.
  // (Buttons scrolled below the popover's own edge are left out.)
  const hits = await pop.evaluate((root) =>
    [...root.querySelectorAll('button')].flatMap((el) => {
      const r = el.getBoundingClientRect()
      const box = root.getBoundingClientRect()
      const x = r.x + r.width / 2
      const y = r.y + r.height / 2
      if (r.width === 0 || y > box.bottom - 8) return []
      const at = document.elementFromPoint(x, y)
      return [{ label: el.textContent ?? '', inside: !!at && root.contains(at) }]
    }),
  )
  expect(hits.length).toBeGreaterThan(5)
  for (const h of hits) expect(h.inside, h.label).toBe(true)
  await capture('phone-overlays-07-queue-open.png', a.page, testInfo)
  await a.page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  expect(await zIndex()).toBe(20)
})

test('A11Y2-05: People, Reactions and Notifications close when the keyboard leaves them', async ({
  join,
}) => {
  const a = await join('alice')

  await test.step('People: Tab stays in the list; focus moving elsewhere closes it', async () => {
    await a.page.getByTestId('people-open').click()
    const panel = a.page.getByTestId('people-panel')
    await expect(panel).toBeVisible()
    for (let i = 0; i < 8; i++) await a.page.keyboard.press('Tab')
    await expect(panel).toBeVisible()
    expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await a.page.getByTestId('share-button').focus()
    await expect(panel).toHaveCount(0)
  })

  await test.step('Reactions: Tab past the bar closes it', async () => {
    await a.page.getByTestId('reactions-button').click()
    const bar = a.page.getByTestId('reaction-bar')
    await expect(bar).toBeVisible()
    const stops = await bar.locator('button').count()
    for (let i = 0; i < stops + 1; i++) await a.page.keyboard.press('Tab')
    await expect(bar).toHaveCount(0)
  })

  await test.step('Notifications: focus moving out of the inbox closes it', async () => {
    await a.page.getByTestId('notifications-bell').click()
    const inbox = a.page.getByTestId('notifications-panel')
    await expect(inbox).toBeVisible()
    await inbox.focus()
    await a.page.getByTestId('share-button').focus()
    await expect(inbox).toHaveCount(0)
  })
})
