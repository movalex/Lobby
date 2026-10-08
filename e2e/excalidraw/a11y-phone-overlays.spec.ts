// PORTED from e2e/tests/phone-overlays.spec.ts (the tldraw spec keeps running on the default build) to the
// Excalidraw board page (owner 3i, docs/EXCALIDRAW-MIGRATION.md §4.8):
//   A11Y2-06: a phone multi-selection keeps the selection bar on screen; arrange folds into "More" (3a);
//   R2-04: "Gather everyone" shows a phone the leader's view at a readable zoom (3f, follow is 3c's);
//   R13 / A11Y-06: on a phone the rail folds behind one button and a panel is a full-width sheet;
//   R2-07: an open workshop popover sits above the notices and the canvas's cursors (3f);
//   A11Y2-05: top-bar popovers (People, Reactions, Notifications) close when the keyboard leaves (3c, 3f).
//
// Deviations from the tldraw spec: R13 checks the board menu (3a's host slot; 2C places it) beside the fold
// button where the tldraw spec checked tldraw's page menu, and that nothing covers either; camera moves use
// the viewport ({x, y, zoom}) instead of tldraw's camera. The other tests exercise other owners' features
// (their `needs` marks came off as those ports landed; R2-04's with CR-3F-3 at wave 3b).
import type { Page } from '@playwright/test'
import { expect, itemBounds, select, setViewport, test, viewport } from '../tests/support/canvas.ts'
import { openWorkshopPopover } from '../tests/support/workshops.ts'
import { openReactionBar } from '../tests/support/workshops-2.ts'
import { MISSING_FEATURE_MS, note, PHONE, waitForA11y } from './a11y-kit.ts'

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
const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

test('A11Y2-06: on a phone a multi-selection keeps the selection bar on screen; arrange waits behind More', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await a.page.setViewportSize(PHONE)
  // the canvas reports its new size a render later: place the notes in the phone's view, not the old one
  // (the wave-3 integration: 3b's first view no longer moves the camera onto them afterwards)
  await expect
    .poll(async () => {
      const w = await viewport(a.page)
      return w.width * w.zoom <= PHONE.width
    })
    .toBe(true)
  const v = await viewport(a.page)
  const ids: string[] = []
  for (let i = 0; i < 3; i++)
    ids.push(
      await note(a.page, v.x + v.width / 2 - 330 + i * 230, v.y + v.height / 2 - 100 - i * 40, `n${i}`),
    )
  await select(a.page, ids)
  const bar = a.page.getByTestId('selection-bar')
  await expect(bar).toBeVisible({ timeout: MISSING_FEATURE_MS })
  await expect(bar).toHaveAttribute('data-compact', 'true')
  expect(within(await boxOf(a.page, 'selection-bar'), PHONE.width)).toBe(true)
  await expect(bar.getByTestId('align-left')).toHaveCount(0)
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
  await bar.getByTestId('align-top').click()
  await expect
    .poll(
      async () =>
        new Set(await Promise.all(ids.map(async (id) => Math.round((await itemBounds(a.page, id))?.y ?? 0))))
          .size,
    )
    .toBe(1)
  await a.page.setViewportSize({ width: 1280, height: 720 })
  await expect(bar).not.toHaveAttribute('data-compact', 'true')
  await expect(bar.getByTestId('align-left')).toBeVisible()
  await expect(bar.getByTestId('selection-more')).toHaveCount(0)
})

test('R2-04: "Gather everyone" shows a phone the leader view at a readable zoom', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForA11y(a.page)
  await waitForA11y(b.page)
  await a.page.setViewportSize({ width: 1440, height: 900 })
  await b.page.setViewportSize(PHONE)
  await setViewport(a.page, { x: 400, y: 200, zoom: 0.44 })
  await openWorkshopPopover(a.page)
  const pop = a.page.getByTestId('workshop-popover')
  await pop.getByTestId('summon-button').click()
  await expect(b.page.getByTestId('follow-toast')).toBeVisible()
  // the phone's zoom AND centre are the leader's: one poll on both (waiting for `zoom > 0.43` alone and then
  // reading the centre once raced the camera, the failure seen in wave B's gate)
  const followed = async () => {
    const [bv, av] = await Promise.all([viewport(b.page), viewport(a.page)])
    return {
      zoom: bv.zoom > 0.43 && bv.zoom < 0.45,
      centreX: Math.abs(centre(bv).x - centre(av).x) <= 3,
      centreY: Math.abs(centre(bv).y - centre(av).y) <= 3,
    }
  }
  await expect.poll(followed, { timeout: 10_000 }).toEqual({ zoom: true, centreX: true, centreY: true })
  await setViewport(a.page, { x: -600, y: 100, zoom: 0.44 })
  await expect
    .poll(async () => {
      const [f, l] = await Promise.all([viewport(b.page), viewport(a.page)])
      return Math.abs(centre(f).x - centre(l).x) <= 3
    })
    .toBe(true)
})

test('R13 / A11Y-06: on a phone the rail folds behind one button and a panel opens as a full-width sheet', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await a.page.setViewportSize(PHONE)
  const canvasWidth = () =>
    a.page.evaluate(() => document.querySelector('.dr-board__canvas')?.getBoundingClientRect().width ?? 0)
  await expect.poll(canvasWidth).toBe(PHONE.width)
  const toggle = a.page.getByTestId('dock-rail-toggle')
  await expect(toggle).toBeVisible()
  await expect(a.page.getByTestId('dock-tab-history')).toBeHidden()
  // the board menu sits beside the fold button, not under it (the tldraw spec: tldraw's page menu), and
  // nothing sits on either
  const t = await boxOf(a.page, 'dock-rail-toggle')
  const menu = await boxOf(a.page, 'main-menu.button')
  expect(menu.x, 'the board menu starts right of the fold button').toBeGreaterThanOrEqual(t.x + t.width)
  expect(within(menu, PHONE.width)).toBe(true)
  const topAt = (b: Box) =>
    a.page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'),
      centre(b),
    )
  expect(await topAt(t)).toBe('dock-rail-toggle')
  expect(await topAt(menu)).toBe('main-menu.button')
  await a.page.screenshot({ path: testInfo.outputPath('phone-overlays-04-rail-folded.png') })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(a.page.getByTestId('dock-tab-history')).toBeVisible()
  await expect(a.page.getByTestId('dock-tab-history')).toContainText('History')
  await a.page.screenshot({ path: testInfo.outputPath('phone-overlays-05-rail-open.png') })
  // a press on the board beside the open list folds it away
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
  // the canvas keeps its size under the sheet
  expect(await canvasWidth()).toBe(PHONE.width)
  await expect(toggle).toBeHidden()
  await a.page.screenshot({ path: testInfo.outputPath('phone-overlays-06-panel-sheet.png') })

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
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForA11y(a.page)
  await waitForA11y(b.page)
  const pop = await openWorkshopPopover(a.page)
  const zIndex = () =>
    a.page.evaluate(() => Number(getComputedStyle(document.querySelector('.dr-topbar') as Element).zIndex))
  expect(await zIndex()).toBeGreaterThan(300)
  await openReactionBar(b.page)
  await b.page.getByTestId('hand-toggle').click()
  await expect(pop.getByTestId('hands-queue')).toContainText(b.name)
  await a.page.waitForTimeout(500)
  await expect(a.page.getByTestId('hand-toast-open')).toHaveCount(0)
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
  await a.page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  expect(await zIndex()).toBe(20)
})

test('A11Y2-05: People, Reactions and Notifications close when the keyboard leaves them', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)

  await test.step('People: Tab stays in the list; focus moving elsewhere closes it', async () => {
    await a.page.getByTestId('people-open').click({ timeout: MISSING_FEATURE_MS })
    const panel = a.page.getByTestId('people-panel')
    await expect(panel).toBeVisible()
    for (let i = 0; i < 8; i++) await a.page.keyboard.press('Tab')
    await expect(panel).toBeVisible()
    expect(await panel.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await a.page.getByTestId('share-button').focus()
    await expect(panel).toHaveCount(0)
  })

  await test.step('Reactions: Tab past the bar closes it', async () => {
    const bar = await openReactionBar(a.page)
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
