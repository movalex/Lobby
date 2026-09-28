// Accessibility review, second batch ("a11y-2"): keyboard-only first shape (A11Y-07), popovers that keep
// and give back the keyboard (A11Y-15), a quiet save indicator (A11Y-14), placeholder contrast (A11Y-11),
// Create right after the chosen template (A11Y-16), and dialogs/popovers that open on a field, not × (A11Y-08).
import type { Page, TestInfo } from '@playwright/test'
import { AI_API_ENV, type FakeOpenAi, startFakeOpenAi } from './support/ai.ts'
import { getShape } from './support/board.ts'
import { readEd, waitForCanvasUx } from './support/canvas-ux.ts'
import { openDashboard, signedInContext } from './support/dashboard-share.ts'
import { plainText } from './support/editor.ts'
import { test as base, expect } from './support/fixtures.ts'
import { createShapes, noteAt, selectIds } from './support/tags.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi()
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: AI_API_ENV })
test.beforeEach(({ openai }) => openai.reset())

/** What has the keyboard: 'BODY', a test id, or a short tag/class description. */
const focusOf = (page: Page) =>
  page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    if (!a || a === document.body) return 'BODY'
    return (
      a.getAttribute('data-testid') ??
      `${a.tagName.toLowerCase()}${a.classList.length ? `.${[...a.classList].join('.')}` : ''}`
    )
  })

const inside = (page: Page, testId: string) =>
  page.evaluate(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.contains(document.activeElement) === true,
    testId,
  )

async function shot(page: Page, info: TestInfo, name: string) {
  await page.screenshot({ path: info.outputPath(`${name}.png`) })
}

/** The shapes on the page: id, type, page bounds, text. */
const shapes = (page: Page) =>
  readEd(page, (ed) =>
    ed.getCurrentPageShapes().map((s) => {
      const b = ed.getShapePageBounds(s.id)
      return { id: s.id, type: s.type, b: b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null }
    }),
  )

test('A11Y-07: with the keyboard only, "Add a sticky note" and N/R then Enter put shapes in the middle of the view, ready to type in', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  expect(await shapes(a.page)).toEqual([])

  // The rail's button, pressed from the keyboard, on a blank board.
  const add = a.page.getByTestId('dock-add-note')
  await expect(add).toBeVisible()
  await expect(add).toHaveAccessibleName('Add a sticky note')
  await add.focus()
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await shapes(a.page)).length).toBe(1)
  const [first] = await shapes(a.page)
  expect(first?.type).toBe('note')
  await expect.poll(() => readEd(a.page, (ed) => ed.getEditingShapeId())).toBe(first?.id)
  // In the middle of the view.
  const centre = await readEd(a.page, (ed) => {
    const v = ed.getViewportPageBounds()
    return { x: v.x + v.w / 2, y: v.y + v.h / 2 }
  })
  const b1 = first?.b
  expect(b1 && Math.abs(b1.x + b1.w / 2 - centre.x) < 2 && Math.abs(b1.y + b1.h / 2 - centre.y) < 2).toBe(
    true,
  )
  await a.page.waitForTimeout(200) // the note's text editor mounts and takes the keyboard
  await a.page.keyboard.type('First idea')
  await expect
    .poll(async () => plainText((await getShape(a.page, first?.id ?? ''))?.props.richText))
    .toBe('First idea')
  await shot(a.page, testInfo, 'a11y-07-add-note-typed')
  await a.page.keyboard.press('Escape')
  await expect.poll(() => readEd(a.page, (ed) => ed.getEditingShapeId())).toBeNull()

  // N, then Enter: a second note, clear of the first.
  await a.page.keyboard.press('Escape') // deselect; the board keeps the keyboard
  await a.page.keyboard.press('n')
  await expect.poll(() => readEd(a.page, (ed) => ed.getPath())).toBe('note.idle')
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await shapes(a.page)).length).toBe(2)
  const second = (await shapes(a.page)).find((s) => s.id !== first?.id)
  expect(second?.type).toBe('note')
  const b2 = second?.b
  const apart =
    !!b1 && !!b2 && (b2.x >= b1.x + b1.w || b1.x >= b2.x + b2.w || b2.y >= b1.y + b1.h || b1.y >= b2.y + b2.h)
  expect(apart).toBe(true)
  await expect.poll(() => readEd(a.page, (ed) => ed.getEditingShapeId())).toBe(second?.id)
  await a.page.waitForTimeout(200)
  await a.page.keyboard.type('Second')
  await expect
    .poll(async () => plainText((await getShape(a.page, second?.id ?? ''))?.props.richText))
    .toBe('Second')
  await a.page.keyboard.press('Escape')
  await a.page.keyboard.press('Escape')

  // R, then Enter: a rectangle.
  await a.page.keyboard.press('r')
  await expect.poll(() => readEd(a.page, (ed) => ed.getPath())).toBe('geo.idle')
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await shapes(a.page)).filter((s) => s.type === 'geo').length).toBe(1)
  await a.page.keyboard.press('Escape')
  await shot(a.page, testInfo, 'a11y-07-three-shapes')
  // Undo takes the rectangle away before anything else (selection and editing steps may come first).
  await a.page.keyboard.press('Escape')
  for (let i = 0; i < 4; i++) {
    if (!(await shapes(a.page)).some((s) => s.type === 'geo')) break
    await a.page.keyboard.press('ControlOrMeta+z')
    await a.page.waitForTimeout(100)
  }
  await expect.poll(async () => (await shapes(a.page)).map((s) => s.type).sort()).toEqual(['note', 'note'])

  // Documented in the keyboard shortcuts dialog.
  await a.page.keyboard.press('ControlOrMeta+Alt+/')
  const dialog = a.page.locator('.tlui-dialog__content')
  await expect(dialog).toContainText('Place the picked note, shape or text in the middle of the view')
  await shot(a.page, testInfo, 'a11y-07-shortcuts')
})

test('A11Y-07: a viewer gets no "Add a sticky note"', async ({ session }) => {
  const v = await session('carol', { role: 'viewer' })
  await waitForCanvasUx(v.page)
  await expect(v.page.getByTestId('dock-tab-frames')).toBeVisible()
  await expect(v.page.getByTestId('dock-add-note')).toHaveCount(0)
})

test('A11Y-15 / A11Y-08: the AI popover opens on its first action, keeps Tab inside, and Escape or focus leaving closes it, giving the keyboard back to the AI button', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await createShapes(a.page, [
    noteAt('shape:ai-1', 200, 200, 'Faster builds'),
    noteAt('shape:ai-2', 460, 200, 'Less meetings'),
  ])
  await selectIds(a.page, ['shape:ai-1', 'shape:ai-2'])
  const button = a.page.getByTestId('selection-ai')
  const menu = a.page.getByTestId('ai-menu')
  await expect(button).toBeVisible()
  await button.focus()
  await a.page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  // A11Y-08: the first action has the keyboard, not the header's ×.
  await expect
    .poll(() => a.page.evaluate(() => document.activeElement?.getAttribute('role')))
    .toBe('menuitem')
  await shot(a.page, testInfo, 'a11y-15-ai-open')
  // Tab around more times than there are controls: the keyboard never leaves the popover.
  const count = await menu.locator('button:not([disabled]), input').count()
  for (let i = 0; i < count + 2; i++) {
    await a.page.keyboard.press('Tab')
    expect(await inside(a.page, 'ai-menu'), `Tab ${i + 1}`).toBe(true)
  }
  for (let i = 0; i < count + 2; i++) {
    await a.page.keyboard.press('Shift+Tab')
    expect(await inside(a.page, 'ai-menu'), `Shift+Tab ${i + 1}`).toBe(true)
  }
  await a.page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(button).toBeFocused()

  // The focus moving elsewhere (a script, a screen reader) closes it too.
  await a.page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await expect.poll(() => inside(a.page, 'ai-menu')).toBe(true)
  // A frame after it placed its focus (focus lost before that is a closing context menu's, ignored).
  await a.page.waitForTimeout(100)
  await a.page.getByTestId('dock-tab-frames').focus()
  await expect(menu).toHaveCount(0)
  expect(await focusOf(a.page)).toBe('dock-tab-frames')
})

test('A11Y-15: the tag picker keeps Tab inside, closes on Escape or when the focus leaves, and gives the keyboard back to the Tags button', async ({
  session,
}, testInfo) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  await createShapes(a.page, [noteAt('shape:tag-1', 200, 200, 'Tag me')])
  await selectIds(a.page, ['shape:tag-1'])
  const button = a.page.getByTestId('selection-tags')
  const picker = a.page.getByTestId('tag-picker')
  await button.focus()
  await a.page.keyboard.press('Enter')
  await expect(picker).toBeVisible()
  await expect(a.page.getByTestId('tag-picker-input')).toBeFocused()
  await a.page.keyboard.type('Urgent')
  await expect(a.page.getByTestId('tag-create')).toBeVisible()
  for (let i = 0; i < 5; i++) {
    await a.page.keyboard.press('Tab')
    expect(await inside(a.page, 'tag-picker'), `Tab ${i + 1}`).toBe(true)
  }
  await a.page.keyboard.press('Shift+Tab')
  await a.page.keyboard.press('Shift+Tab')
  await a.page.keyboard.press('Shift+Tab')
  expect(await inside(a.page, 'tag-picker')).toBe(true)
  await shot(a.page, testInfo, 'a11y-15-tag-picker-tab')
  await a.page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(button).toBeFocused()

  await a.page.keyboard.press('Enter')
  await expect(picker).toBeVisible()
  await expect(a.page.getByTestId('tag-picker-input')).toBeFocused()
  await a.page.waitForTimeout(100)
  await a.page.getByTestId('dock-tab-frames').focus()
  await expect(picker).toHaveCount(0)
  expect(await focusOf(a.page)).toBe('dock-tab-frames')
})

test('A11Y-14: the save pill is not a live region; the announcer stays quiet while editing', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const pill = a.page.getByTestId('save-status')
  const announcer = a.page.getByTestId('save-announcer')
  await expect(pill).not.toHaveAttribute('role', 'status')
  await expect(pill).not.toHaveAttribute('aria-live', /.+/)
  await expect(announcer).toHaveAttribute('role', 'status')
  await expect(announcer).toHaveAttribute('aria-live', 'polite')
  for (let i = 0; i < 3; i++) {
    await createShapes(a.page, [noteAt(`shape:save-${i}`, 200 + i * 240, 200, `Edit ${i}`)])
    await expect(pill).toHaveAttribute('data-state', 'saved')
  }
  await expect(announcer).toHaveText('')
})

test('A11Y-16 / A11Y-11 / A11Y-08: Create follows the chosen template in Tab order; placeholders meet 4.5:1 in dark mode; dialogs open on a field', async ({
  browser,
  users,
}, testInfo) => {
  const alice = await signedInContext(browser, 'alice', { viewport: { width: 1440, height: 900 } })
  try {
    const { page } = alice
    await page.emulateMedia({ colorScheme: 'dark' })
    await openDashboard(page, users.devStudioId)
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    // A11Y-11: the dashboard search placeholder in dark mode.
    const search = page.locator('input[type="search"]').first()
    await expect(search).toBeVisible()
    const colors = await search.evaluate((el) => ({
      placeholder: getComputedStyle(el, '::placeholder').color,
      opacity: getComputedStyle(el, '::placeholder').opacity,
    }))
    expect(colors.placeholder).toBe('rgb(148, 156, 171)') // --dr-placeholder (dark), 4.7:1 or more
    expect(colors.opacity).toBe('1')

    await page.getByTestId('create-board').focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByTestId('create-board-dialog')
    await expect(dialog).toBeVisible()
    // A11Y-08: the dialog opens on its first field (Search templates), not the header's ×.
    await expect(page.getByTestId('template-search')).toBeFocused()
    const searchColor = await page
      .getByTestId('template-search')
      .evaluate((el) => getComputedStyle(el, '::placeholder').color)
    expect(searchColor).toBe('rgb(148, 156, 171)')

    // A11Y-16: choose the Retrospective with the keyboard; the next Tab is its Create button.
    const retro = page.locator('[data-testid="template-card"][data-template-id="retrospective"]')
    await retro.focus()
    await page.keyboard.press('Space')
    await expect(retro).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Tab')
    const here = page.getByTestId('template-create-here')
    await expect(here).toBeFocused()
    await expect(here).toHaveText('Create from Retrospective')
    await expect(here).toBeVisible()
    const box = await here.boundingBox()
    expect((box?.width ?? 0) >= 24 && (box?.height ?? 0) >= 24).toBe(true)
    await shot(page, testInfo, 'a11y-16-create-here-dark')
    // Shift+Tab goes back to the card, and the button hides again.
    await page.keyboard.press('Shift+Tab')
    await expect(retro).toBeFocused()
    await expect(here).toHaveClass('dr-sr-only')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}/)
    await expect(page.getByTestId('board-title')).toHaveText('Retrospective')
  } finally {
    await alice.context.close()
  }
})

test('A11Y-08: every close (×) button in the board chrome is at least 24×24', async ({ session }) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  // Open a dock panel and the AI popover, then measure every visible close control.
  await a.page.getByTestId('dock-tab-history').click()
  await createShapes(a.page, [noteAt('shape:x-1', 200, 200, 'Measure')])
  await selectIds(a.page, ['shape:x-1'])
  await a.page.getByTestId('selection-ai').click()
  await expect(a.page.getByTestId('ai-menu')).toBeVisible()
  const small = await a.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button')]
      .filter((b) => {
        const label = `${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`.trim()
        return /^(Close|Dismiss)\b|^×$/.test(label) && b.getClientRects().length > 0
      })
      .map((b) => {
        const r = b.getBoundingClientRect()
        return { label: b.getAttribute('aria-label') ?? b.textContent, w: r.width, h: r.height }
      })
      .filter((r) => r.w < 24 || r.h < 24),
  )
  expect(small).toEqual([])
})
