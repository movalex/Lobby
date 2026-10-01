// PORTED from e2e/tests/a11y-2.spec.ts (the tldraw spec keeps running on the default build) to the
// Excalidraw board page (owner 3i, docs/EXCALIDRAW-MIGRATION.md §4.8 (4)): keyboard-only first note
// (A11Y-07), popovers that keep and give back the keyboard (A11Y-15), a quiet save indicator (A11Y-14),
// placeholder contrast and Create after the chosen template (A11Y-11, A11Y-16), dialogs that open on a
// field and close controls of at least 24 px (A11Y-08).
//
// Deviations from the tldraw spec: the rail's own "Add a sticky note" and "N/R then Enter" are two tests
// (the second is canvas-ux's place tool, 3a); the viewer's rail is checked on the a11y feature's Contents
// tab (the Frames tab is 3b's); the close-button sizes are measured over every panel the rail has (plus the
// AI popover in its own test). Tests of other owners' features are expected failures (`needs`) until those
// ports land.
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  editingId,
  expect,
  itemBounds,
  items,
  itemText,
  select,
  tool,
  typeText,
  viewport,
  waitForTextEditor,
} from '../tests/support/canvas.ts'
import { openDashboard, signedInContext } from '../tests/support/dashboard-share.ts'
import {
  A11Y_AI_ENV,
  A11Y_FAKE_OPENAI_PORT,
  focusCanvas,
  focusOf,
  inside,
  MISSING_FEATURE_MS,
  needs,
  note,
  waitForA11y,
} from './a11y-kit.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(A11Y_FAKE_OPENAI_PORT)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: A11Y_AI_ENV })
test.beforeEach(({ openai }) => openai.reset())

const notes = async (page: Page) => (await items(page)).filter((e) => e.type === 'stickynote')

test('A11Y-07: with the keyboard only, "Add a sticky note" puts a note in the middle of the view, ready to type in', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  expect(await notes(a.page)).toEqual([])

  const add = a.page.getByTestId('dock-add-note')
  await expect(add).toBeVisible()
  await expect(add).toHaveAccessibleName('Add a sticky note')
  await add.focus()
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await notes(a.page)).length).toBe(1)
  const first = (await notes(a.page))[0]?.id ?? ''
  await waitForTextEditor(a.page, first)
  // in the middle of the view
  const v = await viewport(a.page)
  const b = await itemBounds(a.page, first)
  expect(b && Math.abs(b.x + b.width / 2 - (v.x + v.width / 2)) < 2).toBe(true)
  expect(b && Math.abs(b.y + b.height / 2 - (v.y + v.height / 2)) < 2).toBe(true)
  await typeText(a.page, 'First idea')
  await expect.poll(() => itemText(a.page, first)).toBe('First idea')
  await a.page.screenshot({ path: testInfo.outputPath('a11y-07-add-note-typed.png') })
  await a.page.keyboard.press('Escape')
  await expect.poll(() => editingId(a.page)).toBeNull()
})

test('A11Y-07: N or R, then Enter, place a note or a rectangle in the middle of the view, ready to type in; the shortcuts say so', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const first = await note(a.page, 0, 0, 'First')
  await focusCanvas(a.page)
  await a.page.keyboard.press('Escape')
  await a.page.keyboard.press('n')
  await expect.poll(() => tool(a.page)).toBe('note')
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await notes(a.page)).length, { timeout: MISSING_FEATURE_MS }).toBe(2)
  const second = (await notes(a.page)).find((n) => n.id !== first)?.id ?? ''
  const b1 = await itemBounds(a.page, first)
  const b2 = await itemBounds(a.page, second)
  const apart =
    !!b1 &&
    !!b2 &&
    (b2.x >= b1.x + b1.width ||
      b1.x >= b2.x + b2.width ||
      b2.y >= b1.y + b1.height ||
      b1.y >= b2.y + b2.height)
  expect(apart).toBe(true)
  await waitForTextEditor(a.page, second)
  await typeText(a.page, 'Second')
  await expect.poll(() => itemText(a.page, second)).toBe('Second')
  await a.page.keyboard.press('Escape')
  await a.page.keyboard.press('Escape')
  await a.page.keyboard.press('r')
  await expect.poll(() => tool(a.page)).toBe('rectangle')
  await a.page.keyboard.press('Enter')
  await expect.poll(async () => (await items(a.page)).filter((e) => e.type === 'rectangle').length).toBe(1)
  await a.page.keyboard.press('Escape')
  await a.page.keyboard.press('ControlOrMeta+Alt+/')
  await expect(a.page.getByRole('dialog', { name: /Keyboard shortcuts/ })).toContainText(
    'Place the picked note, shape or text in the middle of the view',
  )
})

test('A11Y-07: a viewer gets no "Add a sticky note"', async ({ canvasSession }) => {
  const v = await canvasSession('carol', { role: 'viewer' })
  await waitForA11y(v.page)
  await expect(v.page.getByTestId('dock-tab-contents')).toBeVisible()
  await expect(v.page.getByTestId('dock-add-note')).toHaveCount(0)
})

test('A11Y-15 / A11Y-08: the AI popover opens on its first action, keeps Tab inside, and Escape or focus leaving closes it, giving the keyboard back to the AI button; its × is at least 24 px', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const n1 = await note(a.page, 200, 200, 'Faster builds')
  const n2 = await note(a.page, 460, 200, 'Less meetings')
  await select(a.page, [n1, n2])
  const button = a.page.getByTestId('selection-ai')
  const menu = a.page.getByTestId('ai-menu')
  await expect(button).toBeVisible({ timeout: MISSING_FEATURE_MS })
  await button.focus()
  await a.page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await expect
    .poll(() => a.page.evaluate(() => document.activeElement?.getAttribute('role')))
    .toBe('menuitem')
  const count = await menu.locator('button:not([disabled]), input').count()
  for (let i = 0; i < count + 2; i++) {
    await a.page.keyboard.press('Tab')
    expect(await inside(a.page, 'ai-menu'), `Tab ${i + 1}`).toBe(true)
  }
  for (let i = 0; i < count + 2; i++) {
    await a.page.keyboard.press('Shift+Tab')
    expect(await inside(a.page, 'ai-menu'), `Shift+Tab ${i + 1}`).toBe(true)
  }
  const small = await menu.locator('button').evaluateAll((els) =>
    els
      .filter((b) =>
        /^(Close|Dismiss)\b|^×$/.test(`${b.getAttribute('aria-label') ?? ''} ${b.textContent ?? ''}`.trim()),
      )
      .map((b) => b.getBoundingClientRect())
      .filter((r) => r.width < 24 || r.height < 24),
  )
  expect(small).toEqual([])
  await a.page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(button).toBeFocused()
  await a.page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await expect.poll(() => inside(a.page, 'ai-menu')).toBe(true)
  await a.page.waitForTimeout(100)
  await a.page.getByTestId('dock-tab-contents').focus()
  await expect(menu).toHaveCount(0)
  expect(await focusOf(a.page)).toBe('dock-tab-contents')
})

test('A11Y-15: the tag picker keeps Tab inside, closes on Escape or when the focus leaves, and gives the keyboard back to the Tags button', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const n = await note(a.page, 200, 200, 'Tag me')
  await select(a.page, [n])
  const button = a.page.getByTestId('selection-tags')
  const picker = a.page.getByTestId('tag-picker')
  await expect(button).toBeVisible({ timeout: MISSING_FEATURE_MS })
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
  for (let i = 0; i < 3; i++) await a.page.keyboard.press('Shift+Tab')
  expect(await inside(a.page, 'tag-picker')).toBe(true)
  await a.page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(button).toBeFocused()
  await a.page.keyboard.press('Enter')
  await expect(picker).toBeVisible()
  await a.page.waitForTimeout(100)
  await a.page.getByTestId('dock-tab-contents').focus()
  await expect(picker).toHaveCount(0)
  expect(await focusOf(a.page)).toBe('dock-tab-contents')
})

test('A11Y-14: the save pill is not a live region; the announcer stays quiet while editing', async ({
  canvasSession,
}) => {
  // Found at wave 5 (3i, on f336ae4 with or without 3i's changes): while the board opens, the save view goes
  // connecting → offline-pending (a few ms, before the welcome: the engine counts offline changes on a new
  // board) → connecting → saved, so the hidden save announcer says "Back online. All changes saved." on
  // every open (sync-quality/engineSave.ts engineDisplayState and the engine core's offlineChanges; CR-3I-6)
  needs('2C', 'CR-3I-6: the save view passes through offline-pending while the board opens')
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const pill = a.page.getByTestId('save-status')
  const announcer = a.page.getByTestId('save-announcer')
  await expect(pill).not.toHaveAttribute('role', 'status')
  await expect(pill).not.toHaveAttribute('aria-live', /.+/)
  await expect(announcer).toHaveAttribute('role', 'status')
  await expect(announcer).toHaveAttribute('aria-live', 'polite')
  for (let i = 0; i < 3; i++) {
    await note(a.page, 200 + i * 240, 200, `Edit ${i}`)
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
    const search = page.locator('input[type="search"]').first()
    await expect(search).toBeVisible()
    const colors = await search.evaluate((el) => ({
      placeholder: getComputedStyle(el, '::placeholder').color,
      opacity: getComputedStyle(el, '::placeholder').opacity,
    }))
    expect(colors.placeholder).toBe('rgb(148, 156, 171)')
    expect(colors.opacity).toBe('1')

    await page.getByTestId('create-board').focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByTestId('create-board-dialog')
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('template-search')).toBeFocused()
    const searchColor = await page
      .getByTestId('template-search')
      .evaluate((el) => getComputedStyle(el, '::placeholder').color)
    expect(searchColor).toBe('rgb(148, 156, 171)')

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
    await page.screenshot({ path: testInfo.outputPath('a11y-16-create-here-dark.png') })
    await page.keyboard.press('Shift+Tab')
    await expect(retro).toBeFocused()
    await expect(here).toHaveClass('dr-sr-only')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}/)
    await expect(page.getByTestId('board-title')).toHaveText('Retrospective')
    // the new board opens on the Excalidraw page (its ?template= insert is 3b's start view, CR-2D-2)
    await waitForA11y(page)
  } finally {
    await alice.context.close()
  }
})

test('A11Y-08: every close (×) button in the board chrome is at least 24×24 (every dock panel, the Share dialog)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForA11y(a.page)
  const n = await note(a.page, 200, 200, 'Measure')
  await select(a.page, [n])
  const tooSmall = () =>
    a.page.evaluate(() =>
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
  const tabs = await a.page
    .locator('[data-testid^="dock-tab-"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid') ?? '').filter((id) => id !== 'dock-tab-probe'),
    )
  expect(tabs).toContain('dock-tab-contents')
  for (const tab of tabs) {
    await a.page.getByTestId(tab).click()
    await expect(a.page.getByTestId(`dock-panel-${tab.slice('dock-tab-'.length)}`)).toBeVisible()
    expect({ tab, small: await tooSmall() }).toEqual({ tab, small: [] })
  }
  await a.page.getByTestId('dock-panel-close').click()
  await a.page.getByTestId('share-button').click()
  await expect(a.page.getByTestId('share-dialog')).toBeVisible()
  expect(await tooSmall()).toEqual([])
})
