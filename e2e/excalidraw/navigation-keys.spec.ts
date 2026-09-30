// 3b navigation on the Excalidraw board page: the zoom keys, the zoom menu, M and the minimap (ported
// from canvas-ux.spec.ts "Miro keys" (its zoom and minimap steps), canvas-ux.fix.spec.ts PERF-03 and
// PRI-13's Zoom to fit), and Lobby's own camera below Excalidraw's 0.1 (docs/EXCALIDRAW-MIGRATION.md
// §4.2, spike A's A14).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-keys
import { createItem, createNote, expect, select, test } from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'
import {
  boundsOf,
  contains,
  focusCanvas,
  inView,
  seed,
  setView,
  viewport,
  waitForNavigation,
  zoom,
} from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

test('zoom keys: Ctrl+0 = 100% (browser zoom untouched), Alt+1 fits all, Alt+2 goes to the selection (again: fits it); M shows and hides the minimap (closed on a fresh profile), and the choice survives a reload', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const [R1, R2, FAR] = await seed(a.page, [
    () => createItem(a.page, 'rectangle', { x: 300, y: 200, width: 200, height: 120 }),
    () => createItem(a.page, 'rectangle', { x: 360, y: 250, width: 200, height: 120 }),
    () => createItem(a.page, 'rectangle', { x: 3200, y: 2200, width: 200, height: 120 }),
  ])
  await focusBoard(a.page)

  await test.step('Ctrl+0 = 100%, Alt+1 fits every item, Alt+2 goes to the selection', async () => {
    await setView(a.page, { x: 0, y: 0, zoom: 0.5 })
    await a.page.keyboard.press('Control+0')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(1, 5)
    expect(await a.page.evaluate(() => window.devicePixelRatio)).toBe(1)

    await setView(a.page, { x: -20_000, y: -20_000, zoom: 1 })
    expect(await inView(a.page, [R1 as string])).toBe(false)
    await a.page.keyboard.press('Alt+1')
    await expect.poll(() => inView(a.page, [R1, R2, FAR] as string[])).toBe(true)
    expect(await zoom(a.page)).toBeLessThan(1)

    await select(a.page, [FAR as string])
    await a.page.keyboard.press('Alt+2')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(1, 5)
    await expect
      .poll(async () => {
        const [v, b] = [await viewport(a.page), await boundsOf(a.page, [FAR as string])]
        return b
          ? Math.round(
              Math.hypot(v.x + v.width / 2 - (b.x + b.width / 2), v.y + v.height / 2 - (b.y + b.height / 2)),
            )
          : -1
      })
      .toBeLessThanOrEqual(1)
    expect(await inView(a.page, [R1 as string])).toBe(false)
    // already at 100%: Alt+2 again fits the selection itself (zooms in on the one box)
    await a.page.keyboard.press('Alt+2')
    await expect.poll(() => zoom(a.page)).toBeGreaterThan(2)
    expect(await inView(a.page, [FAR as string])).toBe(true)
  })

  await test.step('Shift+1 fits too, and Ctrl+= / Ctrl+- step the zoom', async () => {
    await setView(a.page, { x: -20_000, y: -20_000, zoom: 1 })
    await a.page.keyboard.press('Shift+1')
    await expect.poll(() => inView(a.page, [R1, R2, FAR] as string[])).toBe(true)
    await setView(a.page, { x: 0, y: 0, zoom: 1 })
    await a.page.keyboard.press('Control+Equal')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(2, 5)
    await a.page.keyboard.press('Control+Minus')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(1, 5)
    await a.page.keyboard.press('Minus')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(0.5, 5)
  })

  await test.step('M shows and hides the minimap (closed on a fresh profile: PERF-03)', async () => {
    const minimap = a.page.getByTestId('minimap.canvas')
    await expect(a.page.getByTestId('navigation-panel')).toBeVisible()
    await expect(minimap).toHaveCount(0)
    await focusCanvas(a.page)
    await a.page.keyboard.press('m')
    await expect(minimap).toBeVisible()
    await a.page.keyboard.press('m')
    await expect(minimap).toHaveCount(0)
  })

  await test.step('the toggle opens it; the choice is kept across a reload; a press on it moves the view there', async () => {
    await a.page.getByTestId('minimap.toggle-button').click()
    await expect(a.page.getByTestId('minimap.canvas')).toBeVisible()
    await expect(a.page.getByTestId('minimap.zoom-in')).toBeVisible()
    await a.page.reload()
    await waitForNavigation(a.page)
    await expect(a.page.getByTestId('minimap.canvas')).toBeVisible()
    const before = await viewport(a.page)
    const box = await a.page.getByTestId('minimap.canvas').boundingBox()
    if (!box) throw new Error('no minimap')
    await a.page.mouse.click(box.x + box.width - 8, box.y + box.height - 8)
    await expect.poll(async () => (await viewport(a.page)).x).not.toBeCloseTo(before.x, 0)
    await a.page.getByTestId('minimap.toggle-button').click()
    await expect(a.page.getByTestId('minimap.canvas')).toHaveCount(0)
  })

  await test.step('the zoom menu: its button shows the zoom; 100%, fit and selection', async () => {
    await setView(a.page, { x: 0, y: 0, zoom: 0.5 })
    const button = a.page.getByTestId('minimap.zoom-menu-button')
    await expect(button).toHaveText('50%')
    await button.click()
    await a.page.getByTestId('zoom-menu.zoom-to-100').click()
    await expect.poll(() => zoom(a.page)).toBeCloseTo(1, 5)
    await expect(button).toHaveText('100%')
    await button.click()
    await a.page.getByTestId('zoom-menu.zoom-to-fit').click()
    await expect.poll(() => inView(a.page, [R1, R2, FAR] as string[])).toBe(true)
    await button.click()
    await a.page.getByTestId('zoom-menu.zoom-in').click()
    await expect(a.page.getByTestId('zoom-menu')).toBeVisible() // zoom in keeps the menu open
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('zoom-menu')).toHaveCount(0)
  })
})

test('a board wider than Excalidraw’s 0.1 floor allows fits whole on Lobby’s camera, and the zoom-out steps stop at that fit', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  // 60,000 scene px across: in a ~1,400 px canvas the whole board needs a zoom of about 0.02
  const [W, E] = await seed(a.page, [
    () => createNote(a.page, { x: -30_000, y: 0, text: 'West' }),
    () => createNote(a.page, { x: 30_000, y: 0, text: 'East' }),
  ])
  await focusBoard(a.page)
  await a.page.keyboard.press('Alt+1')
  await expect.poll(() => inView(a.page, [W, E] as string[])).toBe(true)
  const fit = await zoom(a.page)
  expect(fit).toBeLessThan(0.1)
  const v = await viewport(a.page)
  const both = await boundsOf(a.page, [W, E] as string[])
  expect(both && contains(v, both)).toBe(true)
  // zoom out from 100% steps down and stops at the fit, never below it
  await setView(a.page, { x: 0, y: 0, zoom: 0.25 })
  await a.page.keyboard.press('Control+Minus')
  await expect.poll(() => zoom(a.page)).toBeCloseTo(0.1, 5)
  await a.page.keyboard.press('Control+Minus')
  await expect.poll(async () => Math.abs((await zoom(a.page)) - fit)).toBeLessThan(0.001)
  await a.page.keyboard.press('Control+Minus')
  await a.page.waitForTimeout(400)
  expect(Math.abs((await zoom(a.page)) - fit)).toBeLessThan(0.001)
})

test('A11Y2-02: the camera keys and board search act from the chrome (Ctrl+=/-, Shift+=/-, Alt+1, Ctrl+F); M and Delete do not; on the canvas Shift+= zooms in at the pointer', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const [N1, N2] = (await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: 'One' }),
    () => createNote(a.page, { x: 2400, y: 1600, text: 'Two' }),
  ])) as [string, string]
  const share = a.page.getByTestId('share-button')

  await test.step('from the top bar: Ctrl+= / Ctrl+- step the zoom, Shift+= / Shift+- too, Alt+1 fits', async () => {
    await setView(a.page, { x: -200, y: -200, zoom: 1 })
    await share.focus()
    await a.page.keyboard.press('Control+Equal')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(2, 5)
    await a.page.keyboard.press('Control+Minus')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(1, 5)
    await a.page.keyboard.press('Shift+Equal')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(2, 5)
    await a.page.keyboard.press('Shift+Minus')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(1, 5)
    await a.page.keyboard.press('Alt+1')
    await expect.poll(() => inView(a.page, [N1, N2])).toBe(true)
    await expect(share).toBeFocused()
    expect(await a.page.evaluate(() => window.devicePixelRatio)).toBe(1)
  })

  await test.step('from the top bar: Ctrl+F opens board search; M and Delete leave the board alone', async () => {
    await share.focus()
    await a.page.keyboard.press('ControlOrMeta+f')
    await expect(a.page.getByTestId('search-input')).toBeFocused()
    await a.page.keyboard.press('Escape')
    await select(a.page, [N1])
    await share.focus()
    await a.page.keyboard.press('m')
    await a.page.keyboard.press('Delete')
    await a.page.waitForTimeout(300)
    await expect(a.page.getByTestId('minimap.canvas')).toHaveCount(0)
    expect(await boundsOf(a.page, [N1])).not.toBeNull()
  })

  await test.step('on the canvas: Shift+= zooms in around the pointer (tldraw’s zoom-in-on-cursor)', async () => {
    await select(a.page, [])
    await setView(a.page, { x: -200, y: -200, zoom: 1 })
    await focusCanvas(a.page)
    const box = await a.page.locator('canvas.excalidraw__canvas.interactive').boundingBox()
    if (!box) throw new Error('no canvas')
    const at = { x: box.x + box.width * 0.25, y: box.y + box.height * 0.7 }
    await a.page.mouse.move(at.x, at.y)
    const before = await viewport(a.page)
    await a.page.keyboard.press('Shift+Equal')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(2, 5)
    const after = await viewport(a.page)
    const sceneAt = (v: { x: number; y: number; zoom: number }) => ({
      x: v.x + (at.x - box.x) / v.zoom,
      y: v.y + (at.y - box.y) / v.zoom,
    })
    const [p, q] = [sceneAt(before), sceneAt(after)]
    expect(Math.hypot(p.x - q.x, p.y - q.y) * after.zoom).toBeLessThan(1.5)
  })
})

test('PRI-13: at phone width the navigation panel is one Zoom to fit button, and it fits the board', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const [N1, N2] = await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: 'One' }),
    () => createNote(a.page, { x: 2400, y: 1600, text: 'Two' }),
  ])
  await a.page.setViewportSize({ width: 390, height: 844 })
  const fit = a.page.getByTestId('navigation.zoom-to-fit')
  await expect(fit).toBeVisible()
  await expect(a.page.getByTestId('minimap.zoom-menu-button')).toHaveCount(0)
  await setView(a.page, { x: -20_000, y: -20_000, zoom: 1 })
  await fit.click()
  await expect.poll(() => inView(a.page, [N1, N2] as string[])).toBe(true)
})
