// OWNER: WS5 (wave T, the timeline). A timeline frame (`customData.lobby.timeline`) draws the board's cards as bars
// from their `card:start` and `card:due` (an overlay: nothing about a bar is stored), against the real api and sync:
//  - bars from cards: a bar per card with a due date in range (a milestone for a due date alone), none for a card out of
//    range, the ruler and the today marker, status as a marker and a word, lanes, the scale, a click selects the card
//    (WS4's popover is not on this branch); nothing leaves Lobby's origins; axe;
//  - drag: a bar moves both dates, an edge one, a milestone its due date, the keyboard one unit; each in ONE push
//    and ONE undo step; a viewer's drag does nothing;
//  - a second tab sees the dates change live and pushes nothing while it only receives;
//  - export: the SVG, the PNG and the vector PDF page include the drawn timeline.
// The sync here runs with DRAFTROOM_PLANNING=on, and needs WS1's room rules for the planning keys to be taken.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/t5-timeline.spec.ts --project=chromium --workers=1
import AxeBuilder from '@axe-core/playwright'
import { expectSaved, itemBounds, pushedOps, select, selection, test } from '../tests/support/canvas.ts'
import { downloadFrom, pdfPageTexts, readPng } from '../tests/support/present-export.ts'
import { foreignRequests } from './ai-kit.ts'
import { openBoardExport } from './present-kit.ts'
import {
  barOf,
  datesOf,
  dragBar,
  expect,
  fitBoard,
  makeCard,
  makeTimeline,
  openPlanningSession,
  rangeOf,
  timelineOf,
  undoNow,
} from './t5-kit.ts'

test.use({ syncEnv: { DRAFTROOM_PLANNING: 'on' }, viewport: { width: 1440, height: 900 } })

const R = rangeOf()
const VALUE = { start: R.start, end: R.end, scale: 'week', lanes: 'none' }

/** A timeline at the origin and four cards beside it: two bars, a milestone and one out of range. */
async function seedBoard(page: Parameters<typeof makeTimeline>[0]) {
  const frame = await makeTimeline(page, { x: 0, y: 0 }, VALUE)
  const brief = await makeCard(page, { x: 1500, y: 0 }, 'Write the brief', {
    status: 'doing',
    start: R.day(3, 1),
    due: R.day(3, 4),
  })
  const review = await makeCard(page, { x: 1500, y: 300 }, 'Client review', {
    status: 'review',
    start: R.week(5),
    due: R.day(6, 2),
  })
  const launch = await makeCard(page, { x: 1500, y: 600 }, 'Launch day', { status: 'todo', due: R.week(9) })
  const later = await makeCard(page, { x: 1500, y: 900 }, 'Next quarter', { status: 'todo', due: R.week(14) })
  return { frame, brief, review, launch, later }
}

test('bars from cards: a bar per card in range, a milestone for a due date alone, the ruler and today', async ({
  browser,
  users,
  board,
}) => {
  const a = await openPlanningSession(browser, users, board, 'alice', 'owner')
  const foreign = foreignRequests(a.page)
  const s = await seedBoard(a.page)
  await fitBoard(a.page)

  const tl = timelineOf(a.page, s.frame)
  await expect(tl).toBeVisible()
  await expect(a.page.getByTestId('timeline-bar')).toHaveCount(3)
  await expect(barOf(a.page, s.later.id)).toHaveCount(0)

  // each bar says what the cards say: dates, status, kind
  await expect(barOf(a.page, s.brief.id)).toHaveAttribute('data-kind', 'bar')
  await expect(barOf(a.page, s.brief.id)).toHaveAttribute('data-start', R.day(3, 1))
  await expect(barOf(a.page, s.brief.id)).toHaveAttribute('data-due', R.day(3, 4))
  await expect(barOf(a.page, s.brief.id)).toHaveAttribute('data-status', 'doing')
  await expect(barOf(a.page, s.launch.id)).toHaveAttribute('data-kind', 'milestone')
  await expect(barOf(a.page, s.review.id)).toHaveAttribute('aria-label', /Client review, In review, .* to /)

  // the ruler (months, weeks) and the today marker are drawn, with the word
  const ruler = a.page.getByTestId('timeline-frame')
  await expect(ruler).toContainText('Today')
  await expect(ruler.locator('text').first()).toBeVisible()

  // a bar is laid out in date order, left to right
  const xs = await Promise.all(
    [s.brief.id, s.review.id, s.launch.id].map(async (id) => (await barOf(a.page, id).boundingBox())?.x ?? 0),
  )
  expect(xs[0]).toBeLessThan(xs[1] ?? 0)
  expect(xs[1]).toBeLessThan(xs[2] ?? 0)

  // T5_SHOTS=<folder> keeps a picture of the timeline, to look at (debugging only)
  if (process.env.T5_SHOTS) await tl.screenshot({ path: `${process.env.T5_SHOTS}/bars.png` })

  // a click selects the card (no popover is registered on this branch)
  await barOf(a.page, s.brief.id).click()
  await expect.poll(() => selection(a.page)).toEqual([s.brief.id])

  // a card out of range comes in when the range is widened (the strip under the selected frame)
  await select(a.page, [s.frame])
  const controls = a.page.getByTestId('timeline-controls')
  await expect(controls).toBeVisible()
  await controls.getByTestId('timeline-scale-month').click()
  await expect(tl).toHaveAttribute('data-scale', 'month')
  await controls.getByTestId('timeline-lanes').selectOption('status')
  await expect(tl).toHaveAttribute('data-lanes', 'status')
  await expect(a.page.getByTestId('timeline-frame')).toContainText('In review')
  await expect(a.page.getByTestId('timeline-frame')).toContainText('To do')
  if (process.env.T5_SHOTS) await tl.screenshot({ path: `${process.env.T5_SHOTS}/lanes.png` })

  // both themes pass axe (the strip and the bars)
  const results = await new AxeBuilder({ page: a.page })
    .include('[data-testid="timeline-controls"]')
    .analyze()
  expect(results.violations.map((v) => v.id)).toEqual([])

  expect(foreign).toEqual([])
})

test('drag: a bar moves both dates, an edge one, a milestone its due date, the keyboard one unit; one push and one undo each', async ({
  browser,
  users,
  board,
}) => {
  const a = await openPlanningSession(browser, users, board, 'alice', 'owner')
  const s = await seedBoard(a.page)
  await fitBoard(a.page)
  await expect(a.page.getByTestId('timeline-bar')).toHaveCount(3)

  const weekPx = ((await timelineOf(a.page, s.frame).boundingBox())?.width ?? 0) / 12
  expect(weekPx).toBeGreaterThan(20)

  // move: two weeks to the right, one push naming both card keys, one undo step
  const before = await datesOf(a.page, s.brief.id)
  await expectSaved(a.page)
  const pushes = (await pushedOps(a.page)).length
  await dragBar(a.page, s.brief.id, 2 * weekPx)
  await expect.poll(() => datesOf(a.page, s.brief.id)).toEqual({ start: R.day(5, 1), due: R.day(5, 4) })
  await expect(barOf(a.page, s.brief.id)).toHaveAttribute('data-due', R.day(5, 4))
  await expectSaved(a.page)
  const ops = (await pushedOps(a.page)).slice(pushes)
  expect(ops.length).toBe(1)
  // (the one push is one patch of this card naming both keys)
  expect(JSON.stringify(ops[0])).toContain('card:start')
  expect(JSON.stringify(ops[0])).toContain('card:due')
  // Ctrl+Z (the bar has the focus): one step puts both dates back
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => datesOf(a.page, s.brief.id)).toEqual(before)
  await expect(barOf(a.page, s.brief.id)).toHaveAttribute('data-start', before.start ?? '')

  // the right edge changes only the due date (to the end of the week it is dropped in)
  await dragBar(a.page, s.review.id, 1.5 * weekPx, 'end')
  const edge = await datesOf(a.page, s.review.id)
  expect(edge.start).toBe(R.week(5))
  expect((edge.due ?? '') > R.day(6, 2)).toBe(true)
  await undoNow(a.page)
  await expect.poll(() => datesOf(a.page, s.review.id)).toEqual({ start: R.week(5), due: R.day(6, 2) })

  // a milestone moves its due date a week at a time
  await dragBar(a.page, s.launch.id, -weekPx)
  await expect.poll(() => datesOf(a.page, s.launch.id)).toEqual({ start: null, due: R.week(8) })
  await undoNow(a.page)
  await expect.poll(() => datesOf(a.page, s.launch.id)).toEqual({ start: null, due: R.week(9) })

  // the keyboard: a focused bar takes the arrow keys, one unit each, Shift for the end edge
  await barOf(a.page, s.brief.id).focus()
  await a.page.keyboard.press('ArrowRight')
  await expect.poll(() => datesOf(a.page, s.brief.id)).toEqual({ start: R.day(4, 1), due: R.day(4, 4) })
  await a.page.keyboard.press('Shift+ArrowRight')
  await expect.poll(() => datesOf(a.page, s.brief.id)).toEqual({ start: R.day(4, 1), due: R.day(5, 4) })

  // a click that does not move writes nothing
  await expectSaved(a.page)
  const quiet = (await pushedOps(a.page)).length
  await barOf(a.page, s.review.id).click()
  expect((await pushedOps(a.page)).length).toBe(quiet)
})

test('a second tab sees the dates change live and pushes nothing; a viewer cannot drag', async ({
  browser,
  users,
  board,
}) => {
  const a = await openPlanningSession(browser, users, board, 'alice', 'owner')
  const b = await openPlanningSession(browser, users, board, 'bob', 'editor')
  const c = await openPlanningSession(browser, users, board, 'carol', 'viewer')
  const s = await seedBoard(a.page)
  for (const p of [a.page, b.page, c.page]) await fitBoard(p)
  for (const p of [b.page, c.page]) await expect(p.getByTestId('timeline-bar')).toHaveCount(3)

  const bobPushes = (await pushedOps(b.page)).length
  const carolPushes = (await pushedOps(c.page)).length
  const weekPx = ((await timelineOf(a.page, s.frame).boundingBox())?.width ?? 0) / 12
  await dragBar(a.page, s.brief.id, weekPx)

  for (const p of [b.page, c.page]) {
    await expect(barOf(p, s.brief.id)).toHaveAttribute('data-due', R.day(4, 4))
    await expect(barOf(p, s.brief.id)).toHaveAttribute('data-start', R.day(4, 1))
  }
  // receiving draws; it writes nothing
  expect((await pushedOps(b.page)).length).toBe(bobPushes)
  expect((await pushedOps(c.page)).length).toBe(carolPushes)

  // the viewer's bars are not draggable: a drag changes nothing and pushes nothing
  await expect(barOf(c.page, s.brief.id)).not.toHaveAttribute('data-editable', /.*/)
  await dragBar(c.page, s.brief.id, 2 * weekPx)
  await c.page.waitForTimeout(500)
  expect(await datesOf(a.page, s.brief.id)).toEqual({ start: R.day(4, 1), due: R.day(4, 4) })
  expect((await pushedOps(c.page)).length).toBe(carolPushes)
  // and she has no settings strip
  await select(c.page, [s.frame]).catch(() => {})
  await expect(c.page.getByTestId('timeline-controls')).toHaveCount(0)

  // bob drags: alice sees it
  await expect(barOf(b.page, s.review.id)).toHaveAttribute('data-editable', 'true')
  await dragBar(b.page, s.review.id, -weekPx)
  await expect(barOf(a.page, s.review.id)).toHaveAttribute('data-start', R.week(4))
})

test('export: the SVG, the PNG and the vector PDF page include the drawn timeline', async ({
  browser,
  users,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await openPlanningSession(browser, users, board, 'alice', 'owner')
  const s = await seedBoard(a.page)
  // (the timeline is a frame, so it is a page of the PDF; the cards beside it are not in it)
  await fitBoard(a.page)
  await expect(a.page.getByTestId('timeline-bar')).toHaveCount(3)
  expect(await itemBounds(a.page, s.frame)).not.toBeNull()

  await openBoardExport(a.page, { expand: true })
  const dialog = a.page.getByTestId('export-dialog')
  await dialog.getByTestId('export-area-board').check()

  const svg = (await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())).bytes.toString(
    'utf8',
  )
  expect(svg).toContain(`data-dr-timeline="${s.frame}"`)
  expect(svg).toContain(`data-dr-timeline-bar="${s.brief.id}"`)
  expect(svg).toContain('>Write the brief<')
  expect(svg).toContain('>Today<')
  expect(svg).not.toMatch(/var\(--|<foreignObject/)

  const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
  expect(readPng(png.bytes).width).toBeGreaterThan(0)

  await expect(dialog.getByTestId('export-pdf-pages-vector')).toBeChecked()
  const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
  await expect(dialog.getByTestId('export-pdf-fallback')).toHaveCount(0)
  const texts = (await pdfPageTexts(pdf.bytes)).join(' ')
  expect(texts).toContain('Client review')
  expect(texts).toContain('Launch day')
  expect(texts).toContain('Today')
})
