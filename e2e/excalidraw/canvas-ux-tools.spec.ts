// canvas-ux (3a, wave 3b) on the Excalidraw board page: undo and redo from Lobby's chrome and from the quick
// actions, the highlighter, a read-only Hand, and the toolbar's phone layout, as the tldraw page has them
// (tldraw's quick actions and actions menu, its OverflowingToolbar, MobileStylePanel and highlight tool;
// tests/keyboard-safety.spec.ts's "undo still works from the chrome").
import type { Page } from '@playwright/test'
import {
  createNote,
  expect,
  item,
  items,
  sceneToScreen,
  select,
  selection,
  test,
  tool,
  updateItem,
  viewport,
} from '../tests/support/canvas.ts'
import { openPhoneSession, PHONE, scrollsSideways } from './a11y-kit.ts'
import { focusBoard, settled } from './board-kit.ts'
import { toolbarIds, waitForCanvasUx, withCanvas } from './canvas-ux-kit.ts'
import { waitForNavigation } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const x = async (page: Page, id: string) => (await item(page, id))?.x

/**
 * The tool as the canvas API reports it (`LobbyCanvas.tool()`, through the board page's debug handle): the
 * highlighter and the read-only Hand are canvas-level tools (canvas/api/parts/tools.ts), while the facade's
 * `tool` verb reads the port (the engine's pen, the neutral state).
 */
const lobbyTool = (page: Page) => withCanvas(page, (c) => c.tool(), null)

const rect = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).first().boundingBox()
  if (!b) throw new Error(`${testId} has no box`)
  return b
}

type Box = { x: number; y: number; width: number; height: number }
/** Two boxes that do not overlap (1 px of slack). */
const apart = (a: Box, b: Box) =>
  a.x + a.width <= b.x + 1 ||
  b.x + b.width <= a.x + 1 ||
  a.y + a.height <= b.y + 1 ||
  b.y + b.height <= a.y + 1

/**
 * The navigation slot (bottom left) is under neither the toolbar nor its quick-actions strip. Below 800 px
 * the board page lifts the slot above the tools' row (2C's board.css), so the bar need not move right of it;
 * the strip then starts right of it (the wave-3b integration).
 */
async function clearOfNavigation(page: Page, withQuick: boolean) {
  const nav = await page.locator('[data-lobby-slot="navigation"]').boundingBox()
  if (!nav) return
  expect(apart(await rect(page, 'main-toolbar'), nav), 'the toolbar is clear of the navigation slot').toBe(
    true,
  )
  if (withQuick)
    expect(apart(await rect(page, 'quick-actions'), nav), 'the quick actions are clear of it').toBe(true)
}

test('A11Y2-02: Ctrl/Cmd+Z and redo act on the board from the top bar and the dock, through the board history; the quick actions (a canvas of 840 px or less) and Board ▸ Edit do the same', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const n = await settled(a.page, createNote(a.page, { x: 100, y: 100, text: 'Move me' }))
  await settled(a.page, updateItem(a.page, n, { x: 400 }))

  await test.step('the keys from the top bar: Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y; the keyboard stays there', async () => {
    const share = a.page.getByTestId('share-button')
    await share.focus()
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => x(a.page, n)).toBe(100)
    await a.page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => x(a.page, n)).toBe(400)
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => x(a.page, n)).toBe(100)
    await a.page.getByTestId('dock-tab-contents').focus()
    await a.page.keyboard.press('Control+y')
    await expect.poll(() => x(a.page, n)).toBe(400)
    await expect(a.page.getByTestId('dock-tab-contents')).toBeFocused()
  })

  await test.step('the quick actions on a tablet-width canvas (840 px or less): Undo, Redo, their disabled state', async () => {
    // none on a desktop canvas (tldraw's top-left menu zone is not reproduced: QuickActions.tsx)
    await expect(a.page.getByTestId('main-menu.button')).toBeVisible()
    await expect(a.page.getByTestId('quick-actions')).toHaveCount(0)
    await a.page.setViewportSize({ width: 800, height: 900 })
    const undo = a.page.getByTestId('quick-actions.undo')
    const redo = a.page.getByTestId('quick-actions.redo')
    await expect(undo).toBeVisible()
    await expect(redo).toBeDisabled()
    await undo.click()
    await expect.poll(() => x(a.page, n)).toBe(100)
    await expect(redo).toBeEnabled()
    await redo.click()
    await expect.poll(() => x(a.page, n)).toBe(400)
    await expect(redo).toBeDisabled()
    // Delete and Duplicate wait for a selection
    await expect(a.page.getByTestId('quick-actions.delete')).toBeDisabled()
    await select(a.page, [n])
    await expect(a.page.getByTestId('quick-actions.duplicate')).toBeEnabled()
    await a.page.getByTestId('quick-actions.duplicate').click()
    await expect.poll(async () => (await items(a.page)).filter((e) => e.type === 'stickynote').length).toBe(2)
    await undo.click()
    await expect
      .poll(async () => (await items(a.page)).filter((e) => e.type === 'stickynote' && !e.isDeleted).length)
      .toBe(1)
    await a.page.setViewportSize({ width: 1440, height: 900 })
    await expect(a.page.getByTestId('quick-actions')).toHaveCount(0)
  })

  await test.step('Board ▸ Edit ▸ Undo and Redo', async () => {
    await a.page.getByTestId('main-menu.button').click()
    await a.page.getByTestId('main-menu-sub.edit-button').click()
    await a.page.getByTestId('main-menu.undo').click()
    await expect.poll(() => x(a.page, n)).toBe(100)
    await a.page.getByTestId('main-menu.button').click()
    await a.page.getByTestId('main-menu-sub.edit-button').click()
    await a.page.getByTestId('main-menu.redo').click()
    await expect.poll(() => x(a.page, n)).toBe(400)
  })

  await test.step('a text field keeps its own undo', async () => {
    await focusBoard(a.page)
    await a.page.keyboard.press('ControlOrMeta+f')
    const field = a.page.getByTestId('search-input')
    await expect(field).toBeFocused()
    await field.fill('abc')
    await field.press('ControlOrMeta+z')
    await a.page.waitForTimeout(300)
    expect(await x(a.page, n)).toBe(400)
  })
})

test('the highlighter: in More and on Shift+D; a stroke is a wide half-transparent pen stroke of kind highlight, one undo step, seen by bob; P gives the pen back its colour', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForCanvasUx(a.page)
  const penColor = (await withCanvas(a.page, (c) => c.styles.next(), null)).strokeColor

  await test.step('from More: the tool, its slot, its style panel (colour only, in highlight shades)', async () => {
    await a.page.getByTestId('tools.more-button').click()
    await a.page.getByTestId('tools.more.highlight').click()
    await expect.poll(() => lobbyTool(a.page)).toBe('highlight')
    await expect(a.page.getByTestId('tools.highlight')).toHaveAttribute('aria-pressed', 'true')
    expect((await toolbarIds(a.page)).slice(-2)).toEqual(['tools.highlight', 'tools.more-button'])
    await expect(a.page.getByTestId('style.color')).toBeVisible()
    await expect(a.page.getByTestId('style.fill')).toHaveCount(0)
    await expect(a.page.getByTestId('style.size')).toHaveCount(0)
    await a.page.getByTestId('style.color.blue').click()
    const next = await withCanvas(a.page, (c) => c.styles.next(), null)
    expect(next).toMatchObject({ strokeColor: '#10acff', opacity: 50 })
  })

  const before = new Set((await items(a.page)).map((e) => e.id))
  await test.step('a stroke: kind highlight, width 9, opacity 50, the blue highlight; bob sees the same', async () => {
    const from = await sceneToScreen(a.page, { x: 200, y: 500 })
    await a.page.mouse.move(from.x, from.y)
    await a.page.mouse.down()
    for (let i = 1; i <= 10; i++) await a.page.mouse.move(from.x + i * 25, from.y + (i % 2) * 8)
    await a.page.mouse.up()
    let id = ''
    await expect
      .poll(async () => {
        const made = (await items(a.page)).filter((e) => !before.has(e.id) && e.type === 'freedraw')
        id = made[0]?.id ?? ''
        return made.length
      })
      .toBe(1)
    const el = (await item(a.page, id)) as unknown as {
      strokeWidth: number
      opacity: number
      strokeColor: string
      customData?: { lobby?: { kind?: string } }
    }
    expect({ w: el.strokeWidth, o: el.opacity, c: el.strokeColor, k: el.customData?.lobby?.kind }).toEqual({
      w: 9,
      o: 50,
      c: '#10acff',
      k: 'highlight',
    })
    await expect
      .poll(
        async () =>
          ((await item(b.page, id)) as { customData?: { lobby?: { kind?: string } } } | null)?.customData
            ?.lobby?.kind,
      )
      .toBe('highlight')
    // the highlighter stays on for the next stroke
    expect(await lobbyTool(a.page)).toBe('highlight')
    // one undo step takes the whole stroke back, here and for bob
    await a.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await item(a.page, id))?.isDeleted ?? true).toBe(true)
    await expect.poll(async () => (await item(b.page, id))?.isDeleted ?? true).toBe(true)
  })

  await test.step('P is the pen again with its own colour; Shift+D is the highlighter', async () => {
    await a.page.keyboard.press('p')
    await expect.poll(() => lobbyTool(a.page)).toBe('freedraw')
    expect((await withCanvas(a.page, (c) => c.styles.next(), null)).strokeColor).toBe(penColor)
    await a.page.keyboard.press('Shift+d')
    await expect.poll(() => lobbyTool(a.page)).toBe('highlight')
    await a.page.keyboard.press('v')
    await expect.poll(() => lobbyTool(a.page)).toBe('select')
    expect((await withCanvas(a.page, (c) => c.styles.next(), null)).strokeColor).toBe(penColor)
  })
})

test('CR-3A-6: a viewer gets Select and Hand (the toolbar, H and V); a drag under Hand pans; no quick actions', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await settled(a.page, createNote(a.page, { x: 100, y: 100, text: 'Look at me' }))
  const v = await canvasSession('bob', { role: 'viewer' })
  await waitForCanvasUx(v.page)
  const ids = await toolbarIds(v.page)
  expect(ids.slice(0, 2)).toEqual(['tools.select', 'tools.hand'])
  expect(ids).not.toContain('tools.note')
  await expect(v.page.getByTestId('quick-actions')).toHaveCount(0)

  // the first view is decided and its camera has come to rest before the drag
  await waitForNavigation(v.page)
  await expect
    .poll(async () => {
      const before = await viewport(v.page)
      await v.page.waitForTimeout(250)
      const after = await viewport(v.page)
      return before.x === after.x && before.y === after.y && before.zoom === after.zoom
    })
    .toBe(true)
  await v.page.getByTestId('tools.hand').click()
  await expect.poll(() => lobbyTool(v.page)).toBe('hand')
  await expect(v.page.getByTestId('tools.hand')).toHaveAttribute('aria-pressed', 'true')
  const v0 = await viewport(v.page)
  const box = await v.page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await v.page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.6)
  await v.page.mouse.down()
  await v.page.mouse.move(box.x + box.width * 0.6 - 150, box.y + box.height * 0.6 - 80, { steps: 8 })
  await v.page.mouse.up()
  await expect.poll(async () => (await viewport(v.page)).x).toBeGreaterThan(v0.x + 50)
  expect(await lobbyTool(v.page)).toBe('hand')

  await focusBoard(v.page)
  await v.page.keyboard.press('v')
  await expect.poll(() => lobbyTool(v.page)).toBe('select')
  await v.page.keyboard.press('h')
  await expect.poll(() => lobbyTool(v.page)).toBe('hand')
})

test('the phone toolbar (390 px, touch): quick actions on top, the tools that fit beside the zoom button, the rest in More, a Styles button; nothing scrolls sideways', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const a = await openPhoneSession(browser, board, users, 'alice')
  try {
    const page = a.page
    await waitForCanvasUx(page)
    const n1 = await settled(page, createNote(page, { x: 0, y: 0, text: 'One' }))
    const n2 = await settled(page, createNote(page, { x: 260, y: 120, text: 'Two' }))

    await test.step('the layout', async () => {
      await expect(page.getByTestId('quick-actions')).toBeVisible()
      await expect(page.getByTestId('main-menu.button')).toBeVisible()
      const quick = await rect(page, 'quick-actions')
      const bar = await rect(page, 'main-toolbar')
      expect(quick.y + quick.height).toBeLessThanOrEqual(bar.y + 1)
      const ids = await toolbarIds(page)
      expect(ids[0]).toBe('tools.select')
      expect(ids.at(-1)).toBe('tools.more-button')
      // the zoom button (navigation, bottom left) is never under the toolbar or its quick actions
      await clearOfNavigation(page, true)
      const styles = await rect(page, 'mobile-styles.button')
      expect(styles.x + styles.width).toBeLessThanOrEqual(PHONE.width)
      expect(await scrollsSideways(page)).toBe(false)
      await page.screenshot({ path: testInfo.outputPath('phone-toolbar.png') })
    })

    await test.step('More holds the tools that do not fit, in order; a pick from it takes the last slot', async () => {
      await page.getByTestId('tools.more-button').tap()
      await expect(page.getByTestId('tools.more-content')).toBeVisible()
      await page.getByTestId('tools.more.frame').tap()
      await expect.poll(() => tool(page)).toBe('frame')
      expect((await toolbarIds(page)).slice(-2)).toEqual(['tools.frame', 'tools.more-button'])
      await page.getByTestId('tools.select').tap()
      await expect.poll(() => tool(page)).toBe('select')
    })

    await test.step('Styles opens the style panel above the toolbar; the top-right panel is gone', async () => {
      await select(page, [n1, n2])
      await expect(page.locator('[data-lobby-slot="stylePanel"] [data-testid="style.panel"]')).toHaveCount(0)
      await page.getByTestId('mobile-styles.button').tap()
      const content = page.getByTestId('mobile-styles.content')
      await expect(content.getByTestId('note-palette')).toBeVisible()
      const c = await rect(page, 'mobile-styles.content')
      expect(c.x).toBeGreaterThanOrEqual(0)
      expect(c.x + c.width).toBeLessThanOrEqual(PHONE.width)
      await page.screenshot({ path: testInfo.outputPath('phone-styles.png') })
      await content.locator('[data-color="light-blue"]').tap()
      await expect.poll(async () => (await item(page, n1))?.backgroundColor).toBe('#a6d8f3')
      await page.getByTestId('mobile-styles.button').tap()
      await expect(content).toHaveCount(0)
    })

    await test.step('the actions menu aligns; Undo in the strip takes it back', async () => {
      await select(page, [n1, n2])
      await page.getByTestId('actions-menu.button').tap()
      await expect(page.getByTestId('actions-menu.content')).toBeVisible()
      await page.getByTestId('actions-menu.align-top').tap()
      await expect.poll(async () => (await item(page, n2))?.y).toBe(0)
      await page.getByTestId('quick-actions.undo').tap()
      await expect.poll(async () => (await item(page, n2))?.y).toBe(120)
      expect(await selection(page)).toEqual(expect.arrayContaining([n1]))
    })
  } finally {
    await a.context.close()
  }
})

test('the toolbar by canvas width: at 700 px the quick actions sit on the toolbar and the style panel at the top right; wider, no quick actions', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvasUx(a.page)
  const n = await settled(a.page, createNote(a.page, { x: 100, y: 100, text: 'Wide' }))
  await select(a.page, [n])
  await a.page.setViewportSize({ width: 700, height: 844 })
  const quick = a.page.getByTestId('quick-actions')
  await expect(quick).toBeVisible()
  const q = await rect(a.page, 'quick-actions')
  expect(q.y + q.height).toBeLessThanOrEqual((await rect(a.page, 'main-toolbar')).y + 1)
  await expect(a.page.getByTestId('mobile-styles.button')).toHaveCount(0)
  await expect(a.page.locator('[data-lobby-slot="stylePanel"] [data-testid="style.panel"]')).toBeVisible()
  // the bar and its quick actions clear the zoom menu at the bottom left
  await clearOfNavigation(a.page, true)
  await a.page.setViewportSize({ width: 1440, height: 900 })
  await expect(quick).toHaveCount(0)
})
