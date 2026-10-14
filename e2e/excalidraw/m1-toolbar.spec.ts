// Wave M (M1-4, UXD-09 full): the selection toolbar's tier one, the quick styles of a selection of one kind
// (features/canvas-ux/ported/style-items.ts, SelectionStyleItems.tsx), written through the style panel's own
// write path:
//  - two users: a note colour and a size change from the bar on two notes; each pick is one undo step for both notes
//    (one Ctrl+Z each restores them); bob sees each change, and bob, who only receives, pushes nothing (the echo
//    assertion); a label bob holds the lease on is skipped by a size pick;
//  - a stroke change from the bar on an arrow bound to two shapes leaves its geometry as it was (no point moves);
//  - a viewer gets no tier one;
//  - the bar is a toolbar of labelled buttons (axe and by hand), Alt+F10 and the arrow keys reach a tray, Escape
//    closes the tray before it leaves the bar;
//  - on a phone (390 x 844, touch) the bar is compact (one Style button), its tray wraps inside the bar with no
//    sideways overflow and no FTU-1 loop; More styles opens the style sheet.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m1-toolbar.spec.ts --project=chromium --workers=1
import AxeBuilder from '@axe-core/playwright'
import type { Browser, Page } from '@playwright/test'
import type { LobbyCanvas } from '../../apps/web/src/canvas/api/lobby-canvas.ts'
import { signInContext } from '../tests/support/api.ts'
import {
  type CanvasSession,
  createItem,
  createNote,
  expect,
  expectSaved,
  item,
  leaseHolder,
  pushedOps,
  select,
  setTool,
  setViewport,
  startTextEditing,
  stopTextEditing,
  test,
  waitForItem,
} from '../tests/support/canvas.ts'
import type { Users } from '../tests/support/users.ts'
import { focusCanvas, PHONE, scrollsSideways, waitForA11y, withCanvas } from './a11y-kit.ts'

const BAR = '[data-testid="selection-bar"]'
const bar = (page: Page) => page.getByTestId('selection-bar')

/** A note's label id (its bound text). */
const labelOf = (page: Page, id: string) =>
  withCanvas(
    page,
    (c: LobbyCanvas, x: string) =>
      (
        (c.get(x) as { boundElements?: { id: string; type: string }[] | null } | undefined)?.boundElements ??
        []
      ).find((b) => b.type === 'text')?.id ?? null,
    id,
  )
/** A note's fill, its width (P-011: a note's Size is the note's) and its label's base size. */
async function noteStyle(page: Page, id: string) {
  const el = (await item(page, id)) as { backgroundColor?: string; width?: number } | null
  const label = await labelOf(page, id)
  const t = label
    ? ((await item(page, label)) as { fontSize?: number; baseFontSize?: number | null } | null)
    : null
  return {
    fill: el?.backgroundColor ?? null,
    width: el?.width ?? null,
    size: t?.baseFontSize ?? t?.fontSize ?? null,
  }
}

async function barSettled(page: Page) {
  await expect(bar(page)).toBeVisible()
  const where = () =>
    page.evaluate((sel) => {
      const r = document.querySelector(sel)?.getBoundingClientRect()
      return r ? `${Math.round(r.x)} ${Math.round(r.y)} ${Math.round(r.width)} ${Math.round(r.height)}` : null
    }, BAR)
  await expect
    .poll(async () => {
      const a = await where()
      await page.waitForTimeout(250)
      return a !== null && a === (await where())
    })
    .toBe(true)
}

/** Opens a control's tray (a wide bar) and picks an option. */
async function pick(page: Page, control: string, row: string, value: string) {
  const tray = bar(page).getByTestId('selection-style-tray')
  if (!(await tray.isVisible()) || (await tray.getAttribute('data-tray')) !== control)
    await bar(page).getByTestId(`selection-style-${control}`).click()
  await expect(tray).toHaveAttribute('data-tray', control)
  await tray.getByTestId(`selection-style.${row}.${value}`).click()
}

test('M1-4 / P-011: a note colour and a note size from the bar: one undo step each for both notes; bob sees each and pushes nothing; a label bob is typing in is skipped', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  for (const p of [a.page, b.page]) await setViewport(p, { x: -100, y: -200, zoom: 1 })
  const n1 = await createNote(a.page, { x: 0, y: 0, text: 'First idea' })
  await expectSaved(a.page)
  const n2 = await createNote(a.page, { x: 260, y: 0, text: 'Second idea' })
  await expectSaved(a.page)
  await waitForItem(b.page, n2)
  const start = await noteStyle(a.page, n1)
  expect(await noteStyle(a.page, n2)).toEqual(start)
  const bobPushes = (await pushedOps(b.page)).length

  await select(a.page, [n1, n2])
  await barSettled(a.page)
  // tier one first: the note controls, then More styles, then the rest of the bar
  await expect(bar(a.page).getByTestId('selection-style-note-colour')).toHaveAttribute(
    'aria-label',
    /^Note color: Yellow$/,
  )

  await test.step('a colour pick: both notes, one step; bob sees it', async () => {
    await pick(a.page, 'note-colour', 'note-colour', 'light-blue')
    await expectSaved(a.page)
    for (const p of [a.page, b.page])
      for (const id of [n1, n2])
        await waitForItem(p, id, (e) => (e as { backgroundColor?: string }).backgroundColor === '#a6d8f3')
    await expect(bar(a.page).getByTestId('selection-style.note-colour.light-blue')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  await test.step('P-011: a size pick resizes both notes (XL: 400 px) with their words (44), one step; bob sees it', async () => {
    expect(start.width).toBe(200)
    await pick(a.page, 'font-size', 'font-size', 'xl')
    await expectSaved(a.page)
    for (const p of [a.page, b.page])
      for (const id of [n1, n2])
        await expect.poll(async () => noteStyle(p, id)).toMatchObject({ width: 400, size: 44 })
    // the note grew from its top-left corner: it is where it was
    expect((await item(a.page, n1))?.x).toBe(0)
    expect((await item(a.page, n1))?.y).toBe(0)
    await expect(bar(a.page).getByTestId('selection-style-font-size')).toHaveAttribute(
      'aria-label',
      'Size: Extra large',
    )
    await a.page.screenshot({ path: testInfo.outputPath('m1-4-note-tray.png') })
  })

  await test.step('one Ctrl+Z restores the size of both notes, the next one their colour', async () => {
    await focusCanvas(a.page)
    await a.page.keyboard.press('ControlOrMeta+z')
    await expectSaved(a.page)
    for (const id of [n1, n2])
      await expect
        .poll(() => noteStyle(a.page, id))
        .toEqual({ fill: '#a6d8f3', width: start.width, size: start.size })
    await a.page.keyboard.press('ControlOrMeta+z')
    await expectSaved(a.page)
    for (const p of [a.page, b.page])
      for (const id of [n1, n2]) await expect.poll(() => noteStyle(p, id)).toEqual(start)
  })

  // the echo assertion: bob only received
  expect((await pushedOps(b.page)).length).toBe(bobPushes)

  await test.step('a label bob holds the lease on is skipped by a size pick; the other note takes it', async () => {
    await startTextEditing(b.page, n1)
    await expect.poll(async () => (await leaseHolder(a.page, n1)) !== null).toBe(true)
    await select(a.page, [n1, n2])
    await barSettled(a.page)
    await pick(a.page, 'font-size', 'font-size', 'l')
    await expectSaved(a.page)
    await expect.poll(async () => noteStyle(a.page, n2)).toMatchObject({ width: 300, size: 33 })
    expect(await noteStyle(a.page, n1)).toMatchObject({ width: start.width, size: start.size })
    await stopTextEditing(b.page)
  })
})

test('M1-4: a stroke change from the bar on an arrow bound to two shapes: colour, width, dash and heads change, its geometry does not', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  for (const p of [a.page, b.page]) await setViewport(p, { x: 0, y: 0, zoom: 1 })
  const FILLED = { backgroundColor: '#dce1f8', fillStyle: 'solid' }
  const box = await createItem(a.page, 'rectangle', { x: 100, y: 200, width: 160, height: 100, ...FILLED })
  await expectSaved(a.page)
  const story = await createItem(a.page, 'rectangle', { x: 600, y: 200, width: 160, height: 100, ...FILLED })
  await expectSaved(a.page)
  const arrow = await createItem(a.page, 'arrow', {
    x: 260,
    y: 250,
    width: 340,
    height: 0,
    points: [
      [0, 0],
      [340, 0],
    ],
  })
  await expectSaved(a.page)
  await withCanvas(
    a.page,
    (c: LobbyCanvas, ids: { arrow: string; box: string; story: string }) =>
      c.transact('bind', (tx) => {
        tx.bind(ids.arrow, 'start', ids.box)
        tx.bind(ids.arrow, 'end', ids.story)
      }),
    { arrow, box, story },
  )
  await expectSaved(a.page)
  await waitForItem(
    b.page,
    arrow,
    (e) => (e as { endBinding?: { elementId: string } | null }).endBinding?.elementId === story,
  )
  const GEO = [
    'x',
    'y',
    'width',
    'height',
    'angle',
    'points',
    'startBinding',
    'endBinding',
    'elbowed',
  ] as const
  const geometry = async (p: Page) => {
    const el = (await item(p, arrow)) as Record<string, unknown> | null
    return Object.fromEntries(GEO.map((k) => [k, el?.[k] ?? null]))
  }
  // the server's re-snap of the bindings has landed on both tabs
  await expect
    .poll(async () => JSON.stringify(await geometry(b.page)))
    .toBe(JSON.stringify(await geometry(a.page)))
  const before = await geometry(a.page)
  const bobPushes = (await pushedOps(b.page)).length

  await select(a.page, [arrow])
  await barSettled(a.page)
  // arrows: colour, width, dash, heads; no elbow or curve switch in the bar
  const controls = await bar(a.page)
    .locator('[data-testid^="selection-style-"][data-inflow]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(controls).toEqual([
    'selection-style-stroke-colour',
    'selection-style-stroke-width',
    'selection-style-stroke-style',
    'selection-style-arrowheads',
  ])
  await pick(a.page, 'stroke-colour', 'stroke-colour', 'red')
  await pick(a.page, 'stroke-width', 'stroke-width', 'l')
  await pick(a.page, 'stroke-style', 'stroke-style', 'dashed')
  await pick(a.page, 'arrowheads', 'start', 'dot')
  await pick(a.page, 'arrowheads', 'end', 'triangle')
  await expectSaved(a.page)
  for (const p of [a.page, b.page]) {
    await waitForItem(
      p,
      arrow,
      (e) =>
        (e as { strokeColor?: string }).strokeColor === '#e03131' &&
        (e as { strokeWidth?: number }).strokeWidth === 4 &&
        (e as { strokeStyle?: string }).strokeStyle === 'dashed' &&
        (e as { startArrowhead?: string | null }).startArrowhead === 'circle' &&
        (e as { endArrowhead?: string | null }).endArrowhead === 'triangle',
    )
    // no point moved, no binding changed (the geometry unit rule: these are style writes only)
    expect(await geometry(p)).toEqual(before)
  }
  expect((await pushedOps(b.page)).length).toBe(bobPushes)
})

test('M1-4: a viewer gets no tier one (the bar has Copy link only)', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('bob', { role: 'viewer' })
  const n = await createNote(a.page, { x: 0, y: 0, text: 'Read me' })
  await expectSaved(a.page)
  await waitForItem(v.page, n)
  await setViewport(v.page, { x: -200, y: -200, zoom: 1 })
  await select(v.page, [n])
  await barSettled(v.page)
  await expect(bar(v.page).getByTestId('copy-link-selection')).toBeVisible()
  await expect(bar(v.page).locator('[data-testid^="selection-style"]')).toHaveCount(0)
})

test('wave N.1: with the Hand tool a press on the bar reads as a press of the tool (the bar stays); a press on the canvas pans (the bar goes)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const n = await createNote(a.page, { x: 0, y: 0, text: 'Pan me' })
  await expectSaved(a.page)
  await setViewport(a.page, { x: -300, y: -200, zoom: 1 })
  expect(await setTool(a.page, 'hand')).toBe(true)
  await select(a.page, [n])
  await barSettled(a.page)
  const gesture = () => withCanvas(a.page, (c: LobbyCanvas) => c.gesture(), null)
  expect(await gesture()).toBe('tool')

  // a press on one of the bar's own buttons: not a pan, so the bar stays under the finger
  const button = await bar(a.page).locator('button').first().boundingBox()
  if (!button) throw new Error('no bar button')
  await a.page.mouse.move(button.x + button.width / 2, button.y + button.height / 2)
  await a.page.mouse.down()
  await expect.poll(gesture).toBe('tool')
  await expect(bar(a.page)).toBeVisible()
  await a.page.mouse.up()

  // a press on the empty canvas: a pan, and the bar steps aside while it lasts
  const empty = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!empty) throw new Error('no canvas')
  await a.page.mouse.move(empty.x + empty.width - 60, empty.y + empty.height - 60)
  await a.page.mouse.down()
  await expect.poll(gesture).toBe('panning')
  await expect(bar(a.page)).toHaveCount(0)
  await a.page.mouse.up()
  await expect.poll(gesture).toBe('tool')
  await expect(bar(a.page)).toBeVisible()
})

test('M1-4 a11y: the bar is a toolbar of labelled buttons (axe and by hand); Alt+F10 and the arrows reach the tray; Escape closes the tray, then leaves the bar', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  await setViewport(a.page, { x: -300, y: -200, zoom: 1 })
  const n = await createNote(a.page, { x: 0, y: 0, text: 'Keys' })
  await expectSaved(a.page)
  await select(a.page, [n])
  await barSettled(a.page)
  await expect(bar(a.page)).toHaveAttribute('role', 'toolbar')
  await expect(bar(a.page)).toHaveAttribute('aria-label', 'Selection')

  // Alt+F10: the bar's first button (Copy link, as before); the arrows reach tier one; Enter opens its tray and the
  // keyboard moves into it
  await focusCanvas(a.page)
  await a.page.keyboard.press('Alt+F10')
  await expect(bar(a.page).getByTestId('copy-link-selection')).toBeFocused()
  const first = bar(a.page).getByTestId('selection-style-note-colour')
  for (let i = 0; i < 8 && !(await first.evaluate((el) => el === document.activeElement)); i++)
    await a.page.keyboard.press('ArrowRight')
  await expect(first).toBeFocused()
  await a.page.keyboard.press('Enter')
  const tray = bar(a.page).getByTestId('selection-style-tray')
  await expect(tray).toHaveAttribute('data-tray', 'note-colour')
  await expect(tray.getByTestId('selection-style.note-colour.black')).toBeFocused()
  // the arrows move along the swatch row (inside the bar: no key claim of its own)
  await a.page.keyboard.press('ArrowRight')
  await expect(tray.getByTestId('selection-style.note-colour.yellow')).toBeFocused()

  // every visible control in the bar (tray included) has a name; axe on the bar
  const unnamed = await a.page.evaluate((sel) => {
    const out: string[] = []
    for (const b of document.querySelectorAll<HTMLButtonElement>(`${sel} button`)) {
      if (!b.getClientRects().length) continue
      const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim()
      if (!name) out.push(b.outerHTML.slice(0, 120))
    }
    return out
  }, BAR)
  expect(unnamed).toEqual([])
  const axe = await new AxeBuilder({ page: a.page })
    .include(BAR)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((x) => x.target.join(' ')).join(', ')}`)).toEqual(
    [],
  )

  // Escape: the tray closes and its button has the keyboard; Escape again: back to the board
  await a.page.keyboard.press('Escape')
  await expect(tray).toHaveCount(0)
  await expect(first).toBeFocused()
  await a.page.keyboard.press('Escape')
  await expect.poll(() => a.page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))).toBe(true)
})

test('M1-4: More styles on a wide canvas points the style panel out', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  await setViewport(a.page, { x: -300, y: -200, zoom: 1 })
  const n = await createNote(a.page, { x: 0, y: 0, text: 'More' })
  await expectSaved(a.page)
  await select(a.page, [n])
  await barSettled(a.page)
  await bar(a.page).getByTestId('selection-style-more').click()
  await expect(a.page.getByTestId('style.panel')).toHaveAttribute('data-attention', 'true')
})

async function phoneSession(
  browser: Browser,
  board: string,
  users: Users,
): Promise<CanvasSession & { errors: string[] }> {
  const who = await users.get('alice')
  const context = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`.slice(0, 300)))
  await signInContext(context, who.handle, who.name)
  await page.goto(`/b/${board}`)
  await waitForA11y(page)
  return { user: who.handle, name: who.name, id: who.id, context, page, errors }
}

test('M1-4 at 390 x 844 (touch): the bar is compact with one Style button; its tray wraps inside the bar, no sideways overflow, no loop; a pick works; More styles opens the sheet', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const a = await phoneSession(browser, board, users)
  try {
    const page = a.page
    const notes = [
      await createNote(page, { x: 0, y: 0, text: 'One' }),
      await createNote(page, { x: 230, y: 0, text: 'Two' }),
    ]
    await expectSaved(page)
    await setViewport(page, { x: -20, y: -150, zoom: 0.7 })
    await select(page, notes)
    await barSettled(page)
    await expect(bar(page)).toHaveAttribute('data-compact', 'true')
    await expect(bar(page).getByTestId('selection-style')).toBeVisible()
    await expect(bar(page).getByTestId('selection-style-note-colour')).toHaveCount(0)
    // one row while the tray is closed
    expect((await bar(page).boundingBox())?.height ?? 0).toBeLessThan(60)

    await bar(page).getByTestId('selection-style').click()
    const tray = bar(page).getByTestId('selection-style-tray')
    await expect(tray).toBeVisible()
    for (const row of ['note-colour', 'font-size', 'text-align'])
      await expect(tray.getByTestId(`selection-style-row.${row}`)).toBeVisible()
    await barSettled(page)
    await page.screenshot({ path: testInfo.outputPath('m1-4-phone-tray.png') })
    // inside the canvas, no sideways scroll, every option on screen
    const [b, canvas] = await Promise.all([
      bar(page).boundingBox(),
      page.locator('[data-lobby-board-canvas]').boundingBox(),
    ])
    if (!b || !canvas) throw new Error('no bar or canvas')
    expect(b.x).toBeGreaterThanOrEqual(canvas.x - 0.5)
    expect(b.x + b.width).toBeLessThanOrEqual(canvas.x + canvas.width + 0.5)
    expect(b.y).toBeGreaterThanOrEqual(canvas.y - 0.5)
    expect(b.y + b.height).toBeLessThanOrEqual(canvas.y + canvas.height + 0.5)
    expect(await scrollsSideways(page)).toBe(false)
    await tray.getByTestId('selection-style.note-colour.green').click()
    await expectSaved(page)
    for (const id of notes)
      await waitForItem(page, id, (e) => (e as { backgroundColor?: string }).backgroundColor === '#93cfa6')
    // More styles: the style sheet the toolbar's Styles button opens (the bar steps aside for it)
    await tray.getByTestId('selection-style-more').click()
    await expect(page.getByTestId('mobile-styles.content')).toBeVisible()
    await expect(bar(page)).toHaveCount(0)
    expect(a.errors).toEqual([])
  } finally {
    await a.context.close()
  }
})
