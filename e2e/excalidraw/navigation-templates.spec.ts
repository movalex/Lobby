// 3b navigation on the Excalidraw board page: templates (PRE-02/03), ported from canvas-ux.spec.ts
// "templates in a board" and "?template= on first open". The insert writes the template's prepared
// elements through `LobbyTx.insert` (CR-2D-2: on the page since the wave-3 integration, W3-9). "Templates
// in a board" still fails at its undo step (DEF-W3-2: the undo removes the template for the inserting tab
// only), so it keeps an expected-failure mark with that reason.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- navigation-templates
import { createNote, expect, expectSaved, test } from '../tests/support/canvas.ts'
import {
  boundsOf,
  contentOf,
  countOf,
  inView,
  openPath,
  overlaps,
  sortedSelection,
  startView,
  undoKey,
  viewport,
  waitForNavigation,
} from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

test('the template picker: every template with its preview, search and categories; a viewer sees it disabled', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  await a.page.getByTestId('dock-tab-templates').click()
  const picker = a.page.getByTestId('template-picker')
  await expect(picker).toBeVisible()
  const options = picker.getByTestId('template-option')
  await expect(options).toHaveCount(7)
  await expect(picker.locator('[data-template-id="storyboard"] svg rect').first()).toBeAttached()
  // every word must match the name, the description or a section (the tour mentions every template)
  await picker.getByTestId('template-search').fill('mood')
  await expect
    .poll(() => options.evaluateAll((els) => els.map((e) => e.getAttribute('data-template-id'))))
    .toEqual(['mood-board', 'lobby-tour'])
  await picker.getByTestId('template-search').fill('')
  await picker.locator('[data-testid="template-category"][data-category="plan"]').click()
  expect(await options.count()).toBeLessThan(7)
  const v = await canvasSession('carol', { role: 'viewer' })
  await waitForNavigation(v.page)
  await expect(v.page.getByTestId('dock-tab-templates')).toHaveCount(0)
})

test('?template= is ignored for a viewer on an empty board, and the parameter is dropped from the address bar', async ({
  browser,
  users,
}) => {
  const empty = await users.createBoard('Empty board for a viewer')
  await users.grant(empty, 'carol', 'viewer')
  const carol = await openPath(browser, await users.get('carol'), `/b/${empty}?template=retrospective`)
  try {
    await expect(carol.page.getByTestId('readonly-pill')).toBeVisible()
    expect(await startView(carol.page)).toBe('none')
    expect(await carol.page.evaluate(() => location.search)).toBe('')
    expect(await countOf(carol.page)).toBe(0)
  } finally {
    await carol.context.close()
  }
})

test('templates in a board: storyboard lands selected, in view, clear of existing content; one undo removes it; twice gives unique ids (CR-2D-2: LobbyTx.insert)', async ({
  canvasSession,
}) => {
  test.fail(
    true,
    'DEF-W3-2: since CR-2D-2 landed the insert works, but its undo removes the template for the inserting tab only',
  )
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await waitForNavigation(a.page)
  const v = await viewport(a.page)
  const existing = await createNote(a.page, {
    x: v.x + v.width / 2 - 100,
    y: v.y + v.height / 2 - 100,
    text: 'Already here',
  })
  await expectSaved(a.page)
  const eb = await boundsOf(a.page, [existing])

  const insertStoryboard = async () => {
    const before = new Set((await contentOf(a.page)).map((e) => e.id))
    await a.page.getByTestId('dock-tab-templates').click()
    await expect(a.page.getByTestId('template-picker')).toBeVisible()
    await a.page.locator('[data-testid="template-option"][data-template-id="storyboard"]').click()
    await expect(a.page.getByTestId('template-picker')).toHaveCount(0)
    await expect(a.page.getByTestId('template-inserted')).toBeVisible({ timeout: 10_000 })
    await expect
      .poll(async () => (await sortedSelection(a.page)).filter((id) => !before.has(id)).length)
      .toBeGreaterThan(0)
    return (await contentOf(a.page)).filter((e) => !before.has(e.id))
  }

  const first = await insertStoryboard()
  const top = first.filter((e) => !e.frameId).map((e) => e.id)
  expect(await sortedSelection(a.page)).toEqual([...top].sort())
  expect(first.filter((e) => e.type === 'frame').length).toBeGreaterThanOrEqual(6)
  await expect.poll(() => inView(a.page, top)).toBe(true)
  const tb = await boundsOf(a.page, top)
  expect(tb && eb && overlaps(tb, eb)).toBe(false)
  await expect.poll(() => countOf(b.page)).toBe(first.length + 1)

  await undoKey(a.page)
  await expect.poll(async () => (await contentOf(a.page)).map((e) => e.id)).toEqual([existing])
  await expect.poll(async () => (await contentOf(b.page)).map((e) => e.id)).toEqual([existing])

  const second = await insertStoryboard()
  const third = await insertStoryboard()
  expect(third.length).toBe(second.length)
  const ids2 = new Set(second.map((e) => e.id))
  expect(third.filter((e) => ids2.has(e.id))).toEqual([])
})

test('?template= on first open: an empty board gets the template once (param removed), with nothing selected and nothing announced (W5-58); reloads and other people get no second copy (CR-2D-2: LobbyTx.insert)', async ({
  canvasSession,
  browser,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  await waitForNavigation(a.page)
  expect(await countOf(a.page)).toBe(0)
  await a.page.goto(`/b/${board}?template=retrospective`)
  await waitForNavigation(a.page)
  expect(await startView(a.page)).toBe('template:retrospective')
  expect(await a.page.evaluate(() => location.search)).toBe('')
  await expect.poll(() => countOf(a.page, 'frame')).toBe(4)
  // it opens on the template (not an empty spot) and nothing is left selected
  expect(await sortedSelection(a.page)).toEqual([])
  // W5-58: nothing was selected on the way either, so the live region never said "6 shapes selected"
  await a.page.waitForTimeout(300)
  await expect(a.page.getByTestId('canvas-announcer')).not.toContainText('selected')
  const frames = (await contentOf(a.page, 'frame')).map((e) => e.id)
  const [v, fb] = [await viewport(a.page), await boundsOf(a.page, frames)]
  expect(fb && overlaps(v, fb)).toBe(true)
  await expectSaved(a.page)
  const total = await countOf(a.page)

  await a.page.reload()
  await waitForNavigation(a.page)
  expect(await startView(a.page)).toBe('restore')
  expect(await countOf(a.page)).toBe(total)

  await users.grant(board, 'bob', 'editor')
  const bob = await openPath(browser, await users.get('bob'), `/b/${board}?template=brainstorm`)
  try {
    expect(await startView(bob.page)).toBe('fit')
    expect(await bob.page.evaluate(() => location.search)).toBe('')
    expect(await countOf(bob.page)).toBe(total)
  } finally {
    await bob.context.close()
  }
})
