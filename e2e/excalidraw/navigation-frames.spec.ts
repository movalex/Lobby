// 3b navigation on the Excalidraw board page: the Frames panel (ported from canvas-ux.spec.ts "frame
// outline" and canvas-ux.fix.spec.ts "Frames panel"). The order is `customData.lobby.present` on the new
// canvas (the tldraw board: meta.presentationIndex / presentationSkip). Present mode's use of the order
// is 3e's (present-export) and is not checked here.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-frames
import type { Page } from '@playwright/test'
import { createItem, createNote, expect, expectSaved, item, test } from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'
import {
  boundsOf,
  cameraIdle,
  cameraSteps,
  inView,
  redoKey,
  seed,
  setFrame,
  setView,
  sortedSelection,
  undoKey,
  waitForNavigation,
  zoom,
} from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const frameRows = (page: Page) => page.locator('[data-testid="frame-row"]')
const frameRowIds = (page: Page) =>
  frameRows(page).evaluateAll((rows) => rows.map((r) => r.getAttribute('data-frame-id')))
const frameRow = (page: Page, id: string) => page.locator(`[data-testid="frame-row"][data-frame-id="${id}"]`)
const present = async (page: Page, id: string) =>
  ((await item(page, id))?.customData?.lobby?.present ?? null) as { index?: number; skip?: boolean } | null

test('frame outline: rows in presentation order, a click goes to the frame (a second selects it), drag reorders (bob sees it within 2 s), undo and redo, auto-order, skip; a viewer cannot reorder', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForNavigation(a.page)
  const [F1, F2, F3] = (await seed(a.page, [
    () => createItem(a.page, 'frame', { x: 0, y: 0, width: 480, height: 320, name: 'Intro' }),
    () => createItem(a.page, 'frame', { x: 700, y: 0, width: 480, height: 320, name: 'Conflict' }),
    () => createItem(a.page, 'frame', { x: 1400, y: 0, width: 480, height: 320, name: 'Resolution' }),
  ])) as [string, string, string]
  for (const s of [a, b]) {
    await waitForNavigation(s.page)
    await s.page.getByTestId('dock-tab-frames').click()
    await expect(s.page.getByTestId('frame-outline')).toBeVisible()
    await expect.poll(() => frameRowIds(s.page)).toEqual([F1, F2, F3])
  }

  await test.step('a row click brings its frame into view without selecting it (DANA2-03); a second click selects it', async () => {
    await setView(a.page, { x: 30_000, y: 30_000, zoom: 1 })
    expect(await inView(a.page, [F3])).toBe(false)
    await frameRow(a.page, F3).locator('.dr-cux-frame__name').click()
    expect(await sortedSelection(a.page)).toEqual([])
    await expect.poll(() => inView(a.page, [F3])).toBe(true)
    await cameraIdle(a.page)
    await frameRow(a.page, F3).locator('.dr-cux-frame__name').click()
    expect(await sortedSelection(a.page)).toEqual([F3])
  })

  await test.step('dragging the last row onto the first: explicit indexes on every frame; bob’s panel follows within 2 s', async () => {
    await frameRow(a.page, F3)
      .locator('.dr-cux-frame__handle')
      .dragTo(frameRow(a.page, F1), { targetPosition: { x: 40, y: 3 } })
    await expect.poll(() => frameRowIds(a.page)).toEqual([F3, F1, F2])
    expect(await Promise.all([F1, F2, F3].map((id) => present(a.page, id)))).toEqual([
      { index: 1 },
      { index: 2 },
      { index: 0 },
    ])
    await expect.poll(() => frameRowIds(b.page), { timeout: 2_000 }).toEqual([F3, F1, F2])
    await expect(a.page.getByTestId('frames-order-mode')).toHaveText('Custom order')
  })

  await test.step('Ctrl+Z restores the layout order (for bob too); Ctrl+Shift+Z brings the custom order back', async () => {
    await focusBoard(a.page)
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => frameRowIds(a.page)).toEqual([F1, F2, F3])
    await expect.poll(() => frameRowIds(b.page)).toEqual([F1, F2, F3])
    expect(await Promise.all([F1, F2, F3].map((id) => present(a.page, id)))).toEqual([null, null, null])
    await a.page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => frameRowIds(a.page)).toEqual([F3, F1, F2])
  })

  await test.step('Auto-order returns a custom order to the layout order, and one undo brings the custom order back', async () => {
    await a.page.getByTestId('frames-auto-order').click()
    await expect.poll(() => frameRowIds(a.page)).toEqual([F1, F2, F3])
    await expect.poll(() => frameRowIds(b.page)).toEqual([F1, F2, F3])
    await expect(a.page.getByTestId('frames-order-mode')).toHaveText('Order follows the layout')
    await undoKey(a.page)
    await expect.poll(() => frameRowIds(a.page)).toEqual([F3, F1, F2])
    await expect.poll(() => frameRowIds(b.page)).toEqual([F3, F1, F2])
    await redoKey(a.page)
    await expect.poll(() => frameRowIds(a.page)).toEqual([F1, F2, F3])
    await undoKey(a.page)
    await expect.poll(() => frameRowIds(a.page)).toEqual([F3, F1, F2])
  })

  await test.step('Skip marks the frame for everyone (its place in the order stays)', async () => {
    await frameRow(a.page, F2).getByTestId('frame-skip').click()
    await expect.poll(() => present(a.page, F2)).toEqual({ index: 2, skip: true })
    await expect.poll(() => present(b.page, F2)).toEqual({ index: 2, skip: true })
    await expect(frameRow(b.page, F2)).toHaveAttribute('data-skipped', 'true')
    await frameRow(a.page, F2).getByTestId('frame-skip').click()
    await expect.poll(() => present(a.page, F2)).toEqual({ index: 2 })
    await frameRow(a.page, F2).getByTestId('frame-skip').click()
    await expectSaved(a.page)
  })

  await test.step('a viewer sees the order but has no reorder, auto-order or skip controls', async () => {
    const v = await canvasSession('carol', { role: 'viewer' })
    await waitForNavigation(v.page)
    await v.page.getByTestId('dock-tab-frames').click()
    await expect.poll(() => frameRowIds(v.page)).toEqual([F3, F1, F2])
    await expect(v.page.getByTestId('frames-auto-order')).toHaveCount(0)
    await expect(v.page.getByTestId('frame-skip')).toHaveCount(0)
    await expect(v.page.locator('.dr-cux-frame__handle')).toHaveCount(0)
    await expect(frameRows(v.page).first()).toHaveAttribute('draggable', 'false')
    await expect(frameRow(v.page, F2)).toHaveAttribute('data-skipped', 'true')
    await expect(v.page.getByTestId('frame-copy-link')).toHaveCount(3)
  })
})

test('Frames panel: no doubled numbers (F20); "go to frame" shows its heading and bottom clear of the chrome, at most 100% (PRI-10); Shift-click selects several frames (F12)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  // a retrospective's frames: a wide strip, then three tall columns
  const frames = (await seed(a.page, [
    () => createItem(a.page, 'frame', { x: 0, y: 0, width: 2560, height: 480, name: '1 · Check-in' }),
    () => createItem(a.page, 'frame', { x: 0, y: 640, width: 800, height: 1400, name: '2 · What went well' }),
    () =>
      createItem(a.page, 'frame', { x: 880, y: 640, width: 800, height: 1400, name: '3 · What to improve' }),
    () => createItem(a.page, 'frame', { x: 1760, y: 640, width: 800, height: 1400, name: '4 · Actions' }),
  ])) as string[]
  const inside = await createNote(a.page, { x: 40, y: 700, text: 'Good pace' })
  await expectSaved(a.page)
  await setFrame(a.page, [inside], frames[1] as string)
  await a.page.getByTestId('dock-tab-frames').click()
  const rows = frameRows(a.page)
  await expect(rows).toHaveCount(4)
  const names = await rows.locator('.dr-cux-frame__name').allTextContents()
  for (const n of names) expect(n).toMatch(/^\d · /)
  await expect(rows.locator('.dr-cux-frame__num')).toHaveCount(0)

  await test.step('go to frame: the heading below the board menu, the bottom above the toolbar, clear of the dock, zoom <= 100%', async () => {
    for (const i of [0, 2]) {
      const id = frames[i] as string
      await rows.nth(i).locator('.dr-cux-frame__name').click()
      await a.page.waitForTimeout(400) // the 280 ms camera animation
      await cameraIdle(a.page)
      expect(await zoom(a.page)).toBeLessThanOrEqual(1)
      expect(await inView(a.page, [id])).toBe(true)
      const fb = await boundsOf(a.page, [id])
      if (!fb) throw new Error('no frame bounds')
      const toScreen = (p: { x: number; y: number }) =>
        a.page.evaluate(
          (q) =>
            (
              window as unknown as { lobbyCanvas: { sceneToScreen(p: unknown): { x: number; y: number } } }
            ).lobbyCanvas.sceneToScreen(q),
          p,
        )
      const top = await toScreen({ x: fb.x, y: fb.y })
      const bottom = await toScreen({ x: fb.x + fb.width / 2, y: fb.y + fb.height })
      const canvasBox = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
      if (!canvasBox) throw new Error('no canvas')
      // the frame's name sits above its top edge: at least a heading's height below the canvas top
      expect(top.y).toBeGreaterThanOrEqual(canvasBox.y + 24)
      for (const slot of ['toolbar', 'navigation']) {
        // the toolbar slot is 3a's (not on the page until its toolbar lands); the navigation panel is ours
        const chrome = a.page.locator(`[data-lobby-slot="${slot}"] > *`)
        if (!(await chrome.count())) continue
        const s = await chrome.first().boundingBox()
        if (s) expect(bottom.y).toBeLessThanOrEqual(s.y + 0.5)
      }
      const dock = await a.page.getByTestId('feature-dock').boundingBox()
      expect(top.x).toBeGreaterThanOrEqual((dock?.x ?? 0) + (dock?.width ?? 0) - 0.5)
    }
  })

  await test.step('Shift-click three frames: 3 frames selected; Ctrl-click takes one out', async () => {
    for (const i of [0, 1, 2])
      await rows
        .nth(i)
        .locator('.dr-cux-frame__name')
        .click({ modifiers: ['Shift'] })
    expect(await sortedSelection(a.page)).toEqual(frames.slice(0, 3).sort())
    await expect(rows.nth(2)).toHaveAttribute('data-selected', 'true')
    await rows
      .nth(1)
      .locator('.dr-cux-frame__name')
      .click({ modifiers: ['Control'] })
    expect(await sortedSelection(a.page)).toEqual([frames[0], frames[2]].sort())
  })
})

test('W5-21: with reduced motion “go to frame” and a search result move the camera at once (they animate otherwise)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const [F1, F2] = (await seed(a.page, [
    () => createItem(a.page, 'frame', { x: 0, y: 0, width: 800, height: 600, name: 'One' }),
    () => createItem(a.page, 'frame', { x: 9000, y: 4000, width: 800, height: 600, name: 'Two' }),
  ])) as [string, string]
  const far = await createNote(a.page, { x: -9000, y: 6000, text: 'Hidden treasure' })
  await expectSaved(a.page)
  await a.page.getByTestId('dock-tab-frames').click()
  const rows = frameRows(a.page)
  await expect(rows).toHaveCount(2)
  const go = (i: number) => () => rows.nth(i).locator('.dr-cux-frame__name').click()
  await setView(a.page, { x: -20_000, y: -20_000, zoom: 1 })
  expect(await cameraSteps(a.page, go(1))).toBeGreaterThan(3)
  expect(await inView(a.page, [F2])).toBe(true)

  await a.page.emulateMedia({ reducedMotion: 'reduce' })
  await setView(a.page, { x: -20_000, y: -20_000, zoom: 1 })
  expect(await cameraSteps(a.page, go(0))).toBe(1)
  expect(await inView(a.page, [F1])).toBe(true)
  // a board search result (3b's zoomTo): one step too
  await a.page.getByTestId('dock-tab-search').click()
  await a.page.getByTestId('search-input').fill('treasure')
  const hit = a.page.getByTestId('search-result').first()
  await expect(hit).toBeVisible()
  expect(await cameraSteps(a.page, () => hit.click())).toBe(1)
  expect(await inView(a.page, [far])).toBe(true)
})
