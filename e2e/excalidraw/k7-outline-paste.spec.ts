// K7-2 (wave K): paste a Markdown or indented outline as a mind map, on the Excalidraw board page against the real
// api and sync server. A real Ctrl+V of an outline asks "mind map, sticky notes or text?"; Paste as mind map
// makes ONE map with the right parent links, tidy, selected, in one undo step, every element accepted by the
// server (a fresh tab finds the same map); a flat list or spreadsheet cells never offer it; the caps (4 levels,
// 60 topics) say what they left out.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/k7-outline-paste --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { expect, expectConverged, expectSaved, items, selection, test } from '../tests/support/canvas.ts'
import { focusBoard } from './board-kit.ts'
import { expectTidy, mapProblems, mapView, structure } from './mindmap-kit.ts'
import {
  grantClipboard,
  notes,
  redoKey,
  undoKey,
  waitForNavigation,
  writeClipboard,
} from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const OUTLINE = [
  '# Launch plan',
  '- Audience',
  '  - Leadership',
  '  - Fans',
  '- Channels',
  '  - Social',
  '  - Press',
  '- Budget',
].join('\n')

const EXPECTED = [
  '(root) Launch plan',
  'Launch plan > Audience',
  'Launch plan > Channels',
  'Launch plan > Budget',
  'Audience > Leadership',
  'Audience > Fans',
  'Channels > Social',
  'Channels > Press',
].sort()

const prompt = (page: Page) => page.getByTestId('bulk-paste-prompt')
const mindmapButton = (page: Page) => page.getByTestId('bulk-paste-mindmap')

async function paste(page: Page, text: string) {
  await writeClipboard(page, { 'text/plain': text })
  await focusBoard(page)
  await page.keyboard.press('ControlOrMeta+v')
  await expect(prompt(page)).toBeVisible()
}

/** Live elements that are not a mind map's: none on a board the test started empty. */
const elementCount = async (page: Page) => (await items(page)).length

test('Paste a 3-level Markdown outline as a mind map: one map with the right parent links, tidy, one undo step, every element accepted by the server', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)

  await test.step('the paste asks, and the mind map is the first choice (focused)', async () => {
    await paste(a.page, OUTLINE)
    await expect(prompt(a.page)).toContainText('Paste 8 items as a mind map, sticky notes or text?')
    await expect(mindmapButton(a.page)).toHaveText('Paste as mind map')
    await expect(mindmapButton(a.page)).toBeFocused()
    // notes and text stay one click away
    await expect(a.page.getByTestId('bulk-paste-notes')).toBeVisible()
    await expect(a.page.getByTestId('bulk-paste-text')).toBeVisible()
  })

  await test.step('Paste as mind map: the right topics under the right parents, bound lines, no overlaps', async () => {
    await mindmapButton(a.page).click()
    await expect(prompt(a.page)).toHaveCount(0)
    await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(8)
    const view = await mapView(a.page)
    expect(structure(view)).toEqual(EXPECTED)
    expect(view.edges).toHaveLength(7)
    expect(mapProblems(view)).toEqual([])
    await expectTidy(a.page)
    // one central topic, selected, in view; the first ring is balanced (3 branches: two on one side)
    const root = view.topics.find((t) => t.parentId === null)
    expect(await selection(a.page)).toEqual([root?.id])
    const ring = view.topics.filter((t) => t.parentId === root?.id)
    expect(ring).toHaveLength(3)
    expect(new Set(ring.map((t) => t.side)).size).toBe(2)
  })

  await test.step('bob sees the same map; a tab opened afterwards finds it too (the server accepted every element)', async () => {
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
    expect(structure(await mapView(b.page))).toEqual(EXPECTED)
    const c = await canvasSession('carol')
    await expect.poll(async () => (await mapView(c.page)).topics.length).toBe(8)
    expect(structure(await mapView(c.page))).toEqual(EXPECTED)
    expect(mapProblems(await mapView(c.page))).toEqual([])
  })

  await test.step('one undo takes the whole map back (topics, words and lines), one redo returns it', async () => {
    const full = await elementCount(a.page)
    expect(full).toBe(8 + 8 + 7) // topics, their labels, lines
    await undoKey(a.page)
    await expect.poll(() => elementCount(a.page)).toBe(0)
    await expect.poll(() => elementCount(b.page)).toBe(0)
    await redoKey(a.page)
    await expect.poll(() => elementCount(a.page)).toBe(full)
    await expectTidy(a.page)
    await expectSaved(a.page)
    await expectConverged(a.page, [b.page])
  })
})

test('Indented text pastes the same way: tabs, two spaces and mixed bullets', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)
  const tabs = 'Plan\n\tBudget\n\t\tFees\n\t\tTravel\n\tDates'
  await paste(a.page, tabs)
  await expect(mindmapButton(a.page)).toBeVisible()
  await mindmapButton(a.page).click()
  await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(5)
  expect(structure(await mapView(a.page))).toEqual(
    ['(root) Plan', 'Plan > Budget', 'Plan > Dates', 'Budget > Fees', 'Budget > Travel'].sort(),
  )
  await undoKey(a.page)
  await expect.poll(() => elementCount(a.page)).toBe(0)

  const mixed = '* Plan\n  + Budget\n    1. Fees\n    2. Travel\n  - Dates\n'
  await paste(a.page, mixed)
  await mindmapButton(a.page).click()
  await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(5)
  // two items at the top level would need a made-up centre; this one has a single top item
  expect(structure(await mapView(a.page))).toEqual(
    ['(root) Plan', 'Plan > Budget', 'Plan > Dates', 'Budget > Fees', 'Budget > Travel'].sort(),
  )
  await expectTidy(a.page)
})

test('A flat list or spreadsheet cells do not offer a mind map; sticky notes and text still work on an outline', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)

  await test.step('a flat list: notes or text only', async () => {
    await paste(a.page, 'one\ntwo\nthree\nfour')
    await expect(prompt(a.page)).toContainText('Paste 4 items as sticky notes or as text?')
    await expect(mindmapButton(a.page)).toHaveCount(0)
    await a.page.getByTestId('bulk-paste-cancel').click()
    await expect(prompt(a.page)).toHaveCount(0)
  })

  await test.step('spreadsheet cells (TSV): notes or text only', async () => {
    await paste(a.page, 'Setup\tConflict\tPayoff\nHero\tStorm\tHome')
    await expect(mindmapButton(a.page)).toHaveCount(0)
    await a.page.getByTestId('bulk-paste-cancel').click()
  })

  await test.step('the same outline as sticky notes: 8 notes, no map', async () => {
    await paste(a.page, OUTLINE)
    await a.page.getByTestId('bulk-paste-notes').click()
    await expect.poll(async () => (await notes(a.page)).length).toBe(8)
    expect((await mapView(a.page)).topics).toHaveLength(0)
    await undoKey(a.page)
    await expect.poll(async () => (await notes(a.page)).length).toBe(0)
  })

  await test.step('and as text: one text element', async () => {
    await paste(a.page, OUTLINE)
    await a.page.getByTestId('bulk-paste-text').click()
    await expect.poll(() => elementCount(a.page)).toBe(1)
    expect((await mapView(a.page)).topics).toHaveLength(0)
  })
})

test('A long outline is capped at 60 topics and 4 levels, and says what it left out; the server takes all 60', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)
  const lines = ['# Big plan']
  for (let i = 0; i < 20; i++) lines.push(`- Branch ${i}`, `  - Leaf ${i}a`, `  - Leaf ${i}b`)
  // 1 + 20 + 40 = 61 topics, one over the cap; a line 6 levels down joins the 4th level
  lines.push('- Deep', '  - L2', '    - L3', '      - L4', '        - L5', '          - L6')
  await paste(a.page, lines.join('\n'))
  await mindmapButton(a.page).click()
  await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(60)
  const notice = a.page.getByTestId('bulk-paste-notice')
  await expect(notice).toContainText('more lines were left out (limit: 60 topics per map).')
  await expectTidy(a.page, 30_000)
  await expectSaved(a.page, 60_000)
  const view = await mapView(a.page)
  expect(view.edges).toHaveLength(59)
  expect(mapProblems(view)).toEqual([])
  // a fresh tab finds all of it: the server accepted 60 topics, 60 labels and 59 lines
  const b = await canvasSession('bob')
  await expect.poll(async () => (await mapView(b.page)).topics.length, { timeout: 30_000 }).toBe(60)
  await undoKey(a.page)
  await expect.poll(() => elementCount(a.page)).toBe(0)
  await expect.poll(() => elementCount(b.page)).toBe(0)
})

test('Deeper than four levels flatten into the fourth, and the paste says so', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  await grantClipboard(a.context)
  await waitForNavigation(a.page)
  await paste(a.page, 'Root\n  L1\n    L2\n      L3\n        L4\n          L5\n            L6')
  await mindmapButton(a.page).click()
  await expect.poll(async () => (await mapView(a.page)).topics.length).toBe(7)
  await expect(a.page.getByTestId('bulk-paste-notice')).toContainText(
    '2 lines nested more than 4 levels deep moved up to level 4.',
  )
  const view = await mapView(a.page)
  const depth = (id: string | null): number => {
    const t = view.topics.find((x) => x.id === id)
    return t?.parentId ? 1 + depth(t.parentId) : 0
  }
  expect(Math.max(...view.topics.map((t) => depth(t.id)))).toBe(4)
})
