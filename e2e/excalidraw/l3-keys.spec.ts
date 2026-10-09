// W3 (wave L, L3-1): the wave L key claims on the real board page (an engine probe through the allowlist).
// Excalidraw's own actions for these chords never run: Ctrl+Arrow (its flowchart: a new node and an elbow arrow),
// Ctrl+Shift+Arrow (its align), Alt+Arrow (its flowchart walk) and Ctrl+K (its link editor, `hyperlink`), for an
// editor and a viewer. Ctrl+K is Lobby's palette instead. Inside a granted text editor Ctrl+K does nothing,
// Ctrl+Arrow is the browser's word move and Alt+Arrow (off macOS) does nothing; typing still types. (AltGr
// typing in the editor is pinned in canvas/input/keymap-verifier.test.ts: a browser cannot fake AltGr's state.)
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l3-keys.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  createItem,
  createNote,
  editingId,
  expect,
  expectSaved,
  items,
  itemText,
  pushedOps,
  select,
  startTextEditingWithKeyboard,
  TEXT_EDITOR,
  test,
  typeText,
} from '../tests/support/canvas.ts'
import { focusCanvas } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

/** The feature keys registered on this page (the palette's dev hook). */
const featureKeys = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __lobbyPalette?: { featureKeys(): string[] } }).__lobbyPalette?.featureKeys() ??
      [],
  )

/** Excalidraw's link editor (its `hyperlink` action) on the page. */
const linkEditor = (page: Page) =>
  page.locator('.excalidraw-hyperlinkContainer, .excalidraw-hyperlinkContainer-input')

const shapeOf = async (page: Page) =>
  (await items(page)).map((e) => ({ id: e.id, type: e.type, x: Math.round(e.x), y: Math.round(e.y) }))

test('editor: Ctrl+Arrow, Ctrl+Shift+Arrow and Alt+Arrow never run the engine’s flowchart or align; Ctrl+K opens Lobby’s palette, never its link editor', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const r1 = await createItem(a.page, 'rectangle', { x: 0, y: 0, width: 200, height: 120 })
  await expectSaved(a.page)
  const r2 = await createItem(a.page, 'rectangle', { x: 400, y: 160, width: 200, height: 120 })
  await expectSaved(a.page)
  const before = await shapeOf(a.page)
  const pushes = (await pushedOps(a.page)).length
  const flowNext = (await featureKeys(a.page)).includes('flow.next')

  await test.step('Ctrl+Arrow on one selected shape: no flowchart node, no elbow arrow (no taker today)', async () => {
    if (flowNext) {
      // features/flow (W4) takes Ctrl+Arrow on this build (a Lobby shape through transact): its own spec covers it
      test.info().annotations.push({ type: 'step skipped', description: 'Ctrl+Arrow is flow.next (W4) here' })
      return
    }
    await select(a.page, [r1])
    await focusCanvas(a.page)
    for (const k of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await a.page.keyboard.press(`Control+${k}`)
      await a.page.waitForTimeout(150)
    }
    // the engine's flowchart commits its pending nodes when Ctrl goes up: it is up now
    await a.page.waitForTimeout(400)
    expect(await shapeOf(a.page)).toEqual(before)
    expect((await pushedOps(a.page)).length).toBe(pushes)
  })

  await test.step('Ctrl+Shift+Arrow on two shapes: the engine’s align never runs (nothing moves)', async () => {
    await select(a.page, [r1, r2])
    await focusCanvas(a.page)
    for (const k of ['ArrowLeft', 'ArrowRight']) await a.page.keyboard.press(`Control+Shift+${k}`)
    await a.page.waitForTimeout(400)
    expect(await shapeOf(a.page)).toEqual(before)
    expect((await pushedOps(a.page)).length).toBe(pushes)
  })

  await test.step('Alt+Arrow is Lobby’s reading-order walk: nothing is created', async () => {
    await select(a.page, [r1])
    await focusCanvas(a.page)
    await a.page.keyboard.press('Alt+ArrowRight')
    await a.page.waitForTimeout(300)
    expect(await shapeOf(a.page)).toEqual(before)
    expect((await pushedOps(a.page)).length).toBe(pushes)
  })

  await test.step('Ctrl+K: the palette, never the engine’s link editor (no `link` written)', async () => {
    await select(a.page, [r1])
    await focusCanvas(a.page)
    await a.page.keyboard.press('Control+k')
    await expect(a.page.getByTestId('command-palette')).toBeVisible()
    await expect(linkEditor(a.page)).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('command-palette')).toHaveCount(0)
    expect((await items(a.page)).find((e) => e.id === r1)?.link ?? null).toBeNull()
    expect((await pushedOps(a.page)).length).toBe(pushes)
  })
})

test('viewer: Ctrl+Arrow and Ctrl+Shift+Arrow do nothing; Ctrl+K opens the palette (every role)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const r1 = await createItem(a.page, 'rectangle', { x: 0, y: 0, width: 200, height: 120 })
  await expectSaved(a.page)
  const v = await canvasSession('victor', { role: 'viewer' })
  await expect.poll(async () => (await items(v.page)).some((e) => e.id === r1)).toBe(true)
  const before = await shapeOf(v.page)
  await select(v.page, [r1])
  await focusCanvas(v.page)
  for (const k of ['Control+ArrowRight', 'Control+Shift+ArrowLeft', 'Alt+ArrowDown'])
    await v.page.keyboard.press(k)
  await v.page.waitForTimeout(400)
  expect(await shapeOf(v.page)).toEqual(before)
  expect((await pushedOps(v.page)).length).toBe(0)
  await focusCanvas(v.page)
  await v.page.keyboard.press('Control+k')
  await expect(v.page.getByTestId('command-palette')).toBeVisible()
  await expect(linkEditor(v.page)).toHaveCount(0)
})

test('inside the granted text editor: Ctrl+K does nothing, Ctrl+Arrow moves the caret by word, Alt+Arrow does nothing, typing types', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const n = await createNote(a.page, { x: 0, y: 0, text: 'abc def' })
  await expectSaved(a.page)
  await startTextEditingWithKeyboard(a.page, n)
  const editor = a.page.locator(TEXT_EDITOR)
  await expect(editor).toHaveValue('abc def')
  await a.page.keyboard.press('Control+k')
  await a.page.waitForTimeout(300)
  await expect(a.page.getByTestId('command-palette')).toHaveCount(0)
  await expect(linkEditor(a.page)).toHaveCount(0)
  await expect(editor).toBeFocused()
  await expect(editor).toHaveValue('abc def')
  // a word to the left, then type: the caret moved by word (the browser's own move, not the engine's)
  await a.page.keyboard.press('Control+ArrowLeft')
  await typeText(a.page, 'X')
  await expect(editor).toHaveValue('abc Xdef')
  // Alt+ArrowRight off macOS is the browser's Forward: stopped and prevented here, the caret stays
  await a.page.keyboard.press('Alt+ArrowRight')
  await typeText(a.page, 'Y')
  await expect(editor).toHaveValue('abc XYdef')
  expect(await editingId(a.page)).toBe(n)
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
  await expect.poll(() => itemText(a.page, n)).toBe('abc XYdef')
  await expect(a.page.getByTestId('command-palette')).toHaveCount(0)
})
