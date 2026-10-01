// 3b navigation on the Excalidraw board page: the zoom keys, the zoom menu, M and the minimap (ported
// from canvas-ux.spec.ts "Miro keys" (its zoom and minimap steps), canvas-ux.fix.spec.ts PERF-03 and
// PRI-13's Zoom to fit), and Lobby's own camera below Excalidraw's 0.1 (docs/EXCALIDRAW-MIGRATION.md
// §4.2, spike A's A14).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-keys
import {
  createItem,
  createNote,
  deleteItem,
  expect,
  expectSaved,
  select,
  selection,
  test,
} from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'
import {
  boundsOf,
  cameraIdle,
  cameraSteps,
  centreHitsItself,
  contains,
  focusCanvas,
  inView,
  overlaps,
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

test('PRI-13: at phone width the navigation panel is one Zoom to fit button, and it fits the board; W5-06 / W5-46: it covers no tool and the board menu is clear of the panels button (390, 412, and 720 × 450 with a panel open)', async ({
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

  // W5-06: the centre of each control is that control (nothing covers it), and the fit button's box is
  // clear of the tools' row
  const clear = async () => {
    await a.page.waitForTimeout(400)
    for (const id of ['navigation.zoom-to-fit', 'tools.select', 'main-menu.button', 'dock-rail-toggle']) {
      // the controls this layout shows (the panels button is the phone's only)
      if (!(await a.page.getByTestId(id).isVisible())) continue
      expect(await centreHitsItself(a.page, id), id).toBe(true)
    }
    // (a box only for what is on the page: boundingBox waits for a missing element)
    const box = async (id: string) =>
      (await a.page.getByTestId(id).count()) ? a.page.getByTestId(id).boundingBox() : null
    const [f, sel] = [await box('navigation.zoom-to-fit'), await box('tools.select')]
    if (f && sel) expect(overlaps(f, sel)).toBe(false)
  }
  await clear()
  await a.page.setViewportSize({ width: 412, height: 915 })
  await expect(fit).toBeVisible()
  await clear()
  // W5-46: 200% page zoom on a 1440 × 900 screen is a 720 × 450 window; with a dock panel open the canvas
  // is narrower than a phone
  await a.page.setViewportSize({ width: 720, height: 450 })
  await a.page.getByTestId('dock-tab-search').click()
  await clear()
  for (const id of ['minimap.zoom-menu-button', 'navigation.zoom-to-fit'])
    if (await a.page.getByTestId(id).count()) expect(await centreHitsItself(a.page, id), id).toBe(true)
})

test('W5-09: the navigation panel’s styles stay on the board page: after a board visit the dashboard sidebar still reads Recent, All boards, …, Trash from the top', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  // the ported panel keeps its own layout (the minimap above the bar)
  await expect(a.page.getByTestId('navigation-panel')).toHaveCSS('flex-direction', 'column-reverse')
  // back to the workspace in the app (no reload: the board page's stylesheets stay loaded)
  await a.page.evaluate(() => {
    ;(window as unknown as { __w509?: number }).__w509 = 1
  })
  await a.page.locator('.dr-topbar__home').click()
  const side = a.page.getByTestId('dashboard-sidebar')
  await expect(side).toBeVisible()
  expect(await a.page.evaluate(() => (window as unknown as { __w509?: number }).__w509)).toBe(1)
  await expect(side.locator('ul:has([data-testid="nav-recent"])')).toHaveCSS('flex-direction', 'column')
  const top = async (id: string) => (await a.page.getByTestId(id).boundingBox())?.y ?? Number.NaN
  const [recent, all, trash] = [await top('nav-recent'), await top('nav-all'), await top('nav-trash')]
  expect(recent).toBeLessThan(all)
  expect(all).toBeLessThan(trash)
})

test('W5-19: below the floor (the board fits at 0.1 again after a fit) no zoom-out gesture zooms in, and the wheel zooms in by 10%, not by +0.1', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const [W, E] = (await seed(a.page, [
    () => createNote(a.page, { x: -30_000, y: 0, text: 'West' }),
    () => createNote(a.page, { x: 30_000, y: 0, text: 'East' }),
  ])) as [string, string]
  await focusBoard(a.page)
  await a.page.keyboard.press('Alt+1')
  await expect.poll(() => inView(a.page, [W, E])).toBe(true)
  await cameraIdle(a.page)
  const fit = await zoom(a.page)
  expect(fit).toBeLessThan(0.05)
  // the far note goes: the board fits at 0.1 again and the camera stays below that floor
  await deleteItem(a.page, E)
  await expectSaved(a.page)
  const floor = () =>
    a.page.evaluate(
      () =>
        (
          window as unknown as { __lobbyBoard: { canvas: { viewport: { limits(): { min: number } } } } }
        ).__lobbyBoard.canvas.viewport.limits().min,
    )
  await expect.poll(floor).toBe(0.1)
  expect(Math.abs((await zoom(a.page)) - fit)).toBeLessThan(1e-9)
  const box = await a.page.locator('canvas.excalidraw__canvas.interactive').boundingBox()
  if (!box) throw new Error('no canvas')
  await a.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)

  await test.step('Ctrl + wheel out stays put (the engine’s wheel jumped in to 10%)', async () => {
    await a.page.keyboard.down('Control')
    await a.page.mouse.wheel(0, 100)
    await a.page.waitForTimeout(400)
    await a.page.keyboard.up('Control')
    expect(await zoom(a.page)).toBeLessThanOrEqual(fit + 1e-9)
  })
  await test.step('Ctrl + wheel in: 10% of the zoom (the engine’s wheel added 0.1)', async () => {
    await a.page.keyboard.down('Control')
    await a.page.mouse.wheel(0, -100)
    await a.page.keyboard.up('Control')
    await expect.poll(() => zoom(a.page)).toBeGreaterThan(fit)
    expect(await zoom(a.page)).toBeCloseTo(fit * 1.1, 4)
  })
  await test.step('Ctrl+- stays put; Ctrl+= goes up to the floor’s step', async () => {
    const z = await zoom(a.page)
    await a.page.keyboard.press('Control+Minus')
    await a.page.waitForTimeout(400)
    expect(Math.abs((await zoom(a.page)) - z)).toBeLessThan(1e-9)
    await a.page.keyboard.press('Control+Equal')
    await expect.poll(() => zoom(a.page)).toBeCloseTo(0.1, 5)
  })
})

test('W5-21: with reduced motion every camera move is immediate (Ctrl+=, Ctrl+-, Alt+1, the zoom menu, Alt+Arrow), and Alt+Arrow keeps the zoom for an item that fits', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const v0 = await viewport(a.page)
  // an item nearly as wide as the view (it fits, but not with 64 px on each side) far to the right
  const [N1, WIDE] = (await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: 'First' }),
    () => createItem(a.page, 'rectangle', { x: 8000, y: 0, width: v0.width * v0.zoom - 40, height: 200 }),
  ])) as [string, string]
  await focusBoard(a.page)
  const press = (key: string) => () => a.page.keyboard.press(key)

  await test.step('without the preference the moves animate (the recorder sees the in-between positions)', async () => {
    await setView(a.page, { x: -200, y: -200, zoom: 1 })
    expect(await cameraSteps(a.page, press('Control+Equal'))).toBeGreaterThan(3)
  })

  await a.page.emulateMedia({ reducedMotion: 'reduce' })
  await test.step('with reduced motion: one step each', async () => {
    await setView(a.page, { x: -200, y: -200, zoom: 1 })
    expect(await cameraSteps(a.page, press('Control+Equal'))).toBe(1)
    expect(await cameraSteps(a.page, press('Control+Minus'))).toBe(1)
    expect(await cameraSteps(a.page, press('Alt+1'))).toBe(1)
    await a.page.getByTestId('minimap.zoom-menu-button').click()
    expect(await cameraSteps(a.page, () => a.page.getByTestId('zoom-menu.zoom-to-100').click())).toBe(1)
  })

  await test.step('Alt+Arrow (3i’s traversal through 3b’s ensureVisible): one step, at the same zoom', async () => {
    await setView(a.page, { x: -200, y: -200, zoom: 1 })
    await select(a.page, [N1])
    await focusCanvas(a.page)
    expect(await cameraSteps(a.page, press('Alt+ArrowRight'))).toBe(1)
    expect(await selection(a.page)).toEqual([WIDE])
    expect(await zoom(a.page)).toBe(1)
    expect(await inView(a.page, [WIDE])).toBe(true)
  })
})

test('W5-33: the board menu’s View submenu: zoom in, zoom out, 100%, fit, selection and the minimap', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const [N1, N2] = (await seed(a.page, [
    () => createNote(a.page, { x: 0, y: 0, text: 'One' }),
    () => createNote(a.page, { x: 4000, y: 2400, text: 'Two' }),
  ])) as [string, string]
  const openView = async () => {
    await a.page.getByTestId('main-menu.button').click()
    await a.page.getByTestId('main-menu-sub.view-button').click()
  }
  await setView(a.page, { x: 0, y: 0, zoom: 0.5 })
  await openView()
  for (const id of ['zoom-in', 'zoom-out', 'zoom-to-100', 'zoom-to-fit', 'zoom-to-selection', 'minimap'])
    await expect(a.page.getByTestId(`main-menu.navigation.view.${id}`)).toBeVisible()
  // nothing selected: Zoom to selection is off
  await expect(a.page.getByTestId('main-menu.navigation.view.zoom-to-selection')).toBeDisabled()
  await a.page.getByTestId('main-menu.navigation.view.zoom-to-100').click()
  await expect.poll(() => zoom(a.page)).toBeCloseTo(1, 5)
  await openView()
  await a.page.getByTestId('main-menu.navigation.view.zoom-to-fit').click()
  await expect.poll(() => inView(a.page, [N1, N2])).toBe(true)
  await openView()
  await a.page.getByTestId('main-menu.navigation.view.minimap').click()
  await expect(a.page.getByTestId('minimap.canvas')).toBeVisible()
  await openView()
  await a.page.getByTestId('main-menu.navigation.view.minimap').click()
  await expect(a.page.getByTestId('minimap.canvas')).toHaveCount(0)
})

test('W5-54: "Back to content" appears when the view holds none of the board’s content, and brings it back', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  const [N1] = (await seed(a.page, [() => createNote(a.page, { x: 0, y: 0, text: 'Here' })])) as [string]
  const back = a.page.getByTestId('navigation.back-to-content')
  await setView(a.page, { x: -300, y: -300, zoom: 1 })
  await a.page.waitForTimeout(1600)
  await expect(back).toHaveCount(0)
  await setView(a.page, { x: 40_000, y: 40_000, zoom: 0.5 })
  await expect(back).toBeVisible({ timeout: 5000 })
  await expect(back).toHaveText('Back to content')
  await back.click()
  await expect.poll(() => inView(a.page, [N1])).toBe(true)
  expect(await zoom(a.page)).toBeLessThanOrEqual(0.5 + 1e-9)
  await expect(back).toHaveCount(0)
})
