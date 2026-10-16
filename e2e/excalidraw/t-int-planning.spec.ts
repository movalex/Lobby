// Wave T integration: storyboards and planning walls end to end on the real api, sync server and preview worker, with
// the switches as the build ships them (every PLANNING_FLAGS switch on: no localStorage override, no route double) and
// the sync's DRAFTROOM_PLANNING on (as render.yaml deploys it):
//   1. a storyboard from a pasted shot list (Script to boards…), reordered in the strip, played (the strip's Play) in the
//      new order, and exported as the PDF sheet (every shot number and the words are text in the file);
//   2. cards on a Kanban made from the palette; a drag between columns is one undo step; a second tab sees each change
//      live and pushes nothing while it only receives; a status edited in the card table moves the card; the CSV;
//   3. a timeline (from the palette) draws those cards once they have dates; a bar dragged a week moves both dates;
//   4. a name-only guest on the board: no assignee picker (the popover and the table).
// Nothing leaves Lobby's origins and no File System Access picker is called.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test excalidraw/t-int-planning.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  expectSaved,
  item,
  itemCenterOnScreen,
  sceneToScreen,
  select,
  selection,
} from '../tests/support/canvas.ts'
import { downloadFrom, pdfPageTexts } from '../tests/support/present-export.ts'
import { emptyCanvasPoint } from './board-kit.ts'
import { openBoardExport } from './present-kit.ts'
import { countPickers, foreignRequests, player, playThrough, stage } from './t2-kit.ts'
import {
  chips,
  expect,
  expectItemsEverywhere,
  focusCanvas,
  popover,
  post,
  roomSays14,
  seedPlanning,
  showAll,
  storedLobby,
  test,
  waitForWorkshopBoard,
} from './t4-kit.ts'
import { barOf, datesOf, dragBar, fitBoard, iso, thisMonday, timelineOf } from './t5-kit.ts'

test.use({ syncEnv: { DRAFTROOM_PLANNING: 'on' }, viewport: { width: 1440, height: 900 } })
test.describe.configure({ mode: 'serial' })

const lobbyOf = (e: unknown) =>
  ((e as { customData?: { lobby?: Record<string, unknown> } } | null)?.customData?.lobby ?? {}) as Record<
    string,
    unknown
  >

/** The shipped switches: nothing in this page's localStorage turns a planning switch on or off. */
async function noPlanningOverride(page: Page) {
  const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('lobby.plan')))
  expect(keys).toEqual([])
}

async function palette(page: Page, words: string, id: string) {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('command-palette-input').fill(words)
  await page.locator(`[data-testid="command-palette-option"][data-entry-id="cmd:${id}"]`).click()
}

/** Opens a card's popover from the selection bar's status button ("To do · Details"), as a person does. */
async function details(page: Page, id: string) {
  await select(page, [id])
  await page.getByTestId('selection-card-status').click()
  await expect(popover(page)).toBeVisible()
}

const SHOTS = [
  '1. WIDE - Kitchen at dawn, steam rising. (3s)',
  '2. CU - hands on the mug. VO: Every day starts here.',
  '3. OTS on Ana looking out. SFX: birds',
  '4. Logo on white, 2s',
].join('\n')

test('a storyboard from a pasted script, reordered, played as an animatic, exported as the PDF sheet', async ({
  join,
}) => {
  test.setTimeout(180_000)
  const a = await join('alice')
  const foreign = foreignRequests(a.context)
  const pickers = await countPickers(a.page)
  await a.page.reload()
  await waitForWorkshopBoard(a.page)
  await roomSays14(a.page)
  await noPlanningOverride(a.page)

  // Script to boards… from the context menu on empty canvas: the shot list is detected, four panels
  await select(a.page, [])
  const p = await emptyCanvasPoint(a.page)
  await a.page.mouse.click(p.x, p.y, { button: 'right' })
  await a.page.getByRole('menuitem', { name: 'Script to boards…' }).click()
  const dialog = a.page.getByTestId('sb-script-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('sb-script-text').fill(SHOTS)
  await expect(dialog.getByTestId('sb-script-format').locator('option').first()).toHaveText(
    'Detect (Shot list)',
  )
  await expect(dialog.getByTestId('sb-script-beat')).toHaveCount(4)
  await dialog.getByTestId('sb-script-title').fill('Morning shots')
  await dialog.getByTestId('sb-script-create').click()
  await expect(dialog).toHaveCount(0)
  await expectSaved(a.page)
  const strip = a.page.getByTestId('sb-strip')
  await expect(strip.getByTestId('sb-strip-title')).toHaveText('Morning shots')
  const cards = a.page.getByTestId('sb-strip-card')
  await expect(cards).toHaveCount(4)
  const order = () => cards.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.panelId ?? ''))
  const order0 = await order()

  // reorder: shot 1 moves right (the CU panel is now shot 1)
  await cards.first().click()
  await a.page.getByTestId('sb-move-right').click()
  const order1 = [order0[1], order0[0], order0[2], order0[3]] as string[]
  await expect.poll(order).toEqual(order1)
  await expectSaved(a.page)
  const pos = async (id: string) => lobbyOf(await item(a.page, id))['sb:pos'] as string
  expect((await pos(order1[0] as string)) < (await pos(order1[1] as string))).toBe(true)

  // the animatic plays the new order: the CU panel first, every panel once, to the end
  const durations = await Promise.all(
    order1.map(async (id) => lobbyOf(await item(a.page, id))['sb:dur'] as number),
  )
  const total = durations.reduce((x, y) => x + y, 0)
  // from the strip (it covers the selection bar's button when the panel sits low on the screen)
  await strip.getByTestId('sb-play').click()
  await expect(player(a.page)).toBeVisible()
  await expect(stage(a.page)).toHaveAttribute('data-prepared', 'true', { timeout: 30_000 })
  await expect(player(a.page)).toHaveAttribute('aria-label', 'Animatic: Morning shots')
  await a.page.keyboard.press('Home')
  await a.page.keyboard.press('f')
  await expect(a.page.getByTestId('animatic-fields')).toContainText('Every day starts here')
  await expect(a.page.getByTestId('animatic-fields')).toContainText('CU')
  await a.page.keyboard.press('f')
  const run = await playThrough(a.page, total)
  expect(run.swaps.map((s) => s.i)).toEqual([1, 2, 3])
  await expect(stage(a.page)).toHaveAttribute('data-panel-index', '3')
  await a.page.keyboard.press('Escape')
  await expect(player(a.page)).toHaveCount(0)

  // the PDF sheet (3 panels a page): two pages, every shot number and the words are text
  await openBoardExport(a.page)
  const exp = a.page.getByTestId('export-dialog')
  await expect(exp.getByTestId('export-sb-sheet-section')).toBeVisible()
  await exp.getByTestId('export-sb-sheet-3').check()
  const pdf = await downloadFrom(a.page, () => exp.getByTestId('export-sb-sheet').click())
  expect(pdf.name).toBe('Morning shots - storyboard.pdf')
  await expect(exp.getByTestId('export-status')).toHaveText(
    'Downloaded “Morning shots - storyboard.pdf” (2 pages).',
  )
  const texts = await pdfPageTexts(pdf.bytes)
  expect(texts).toHaveLength(2)
  for (const n of [1, 2, 3]) expect(texts[0], `SH 0${n}`).toContain(`SH 0${n}`)
  expect(texts[1]).toContain('SH 04')
  expect(texts[0]).toContain('Every day starts here')
  expect(texts.join('\n')).toContain('Kitchen at dawn')

  expect(await pickers()).toBe(0)
  expect(foreign).toEqual([])
})

test('cards on a Kanban, a second tab live, the table and its CSV, a timeline of those cards, and a guest', async ({
  join,
  browser,
  board,
  stack,
}) => {
  test.setTimeout(240_000)
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const foreign = [foreignRequests(a.context), foreignRequests(b.context)]
  for (const s of [a, b]) {
    await roomSays14(s.page)
    await noPlanningOverride(s.page)
  }

  // a Kanban from the palette (five columns), on both tabs
  await palette(a.page, 'kanban', 'kanban.new')
  await expect(a.page.getByTestId('kanban')).toHaveCount(1)
  const k = (await a.page.getByTestId('kanban').getAttribute('data-element-id')) as string
  await expectItemsEverywhere([a, b], [k])
  const frame = (await item(a.page, k)) as unknown as { x: number; y: number; width: number }
  expect(frame.width).toBe(1500)
  const TOP = 72 + 16 // the header band and padding (features/kanban/layout.ts)

  // two cards in To do, and a plain note made a card from the selection bar
  await seedPlanning(a.page, {
    cards: [
      {
        id: 'ti-c1',
        x: frame.x + 50,
        y: frame.y + TOP,
        text: 'Cast the lead',
        frameId: k,
        lobby: { 'card:status': 'todo' },
      },
      {
        id: 'ti-c2',
        x: frame.x + 50,
        y: frame.y + TOP + 230,
        text: 'Location scout',
        frameId: k,
        lobby: { 'card:status': 'todo' },
      },
      { id: 'ti-n3', x: frame.x + 1700, y: frame.y, text: 'Book the studio' },
    ],
  })
  await expectItemsEverywhere([a, b], ['ti-c1', 'ti-c2', 'ti-n3'])
  for (const s of [a, b]) await showAll(s.page)
  const bobPushes = () => b.net.sentPushes().length
  const quiet = bobPushes()
  await select(a.page, ['ti-n3'])
  await a.page.getByTestId('selection-card-make').click()
  await expect.poll(async () => (await storedLobby(stack, board, 'ti-n3'))['card:status']).toBe('todo')
  await expect(chips(b.page, 'ti-n3')).toHaveAttribute('data-status', 'todo')

  // a drag into the second column: position and status in one step; one Ctrl+Z undoes both
  await select(a.page, [])
  await focusCanvas(a.page)
  const before = (await item(a.page, 'ti-c1')) as unknown as { x: number; y: number }
  const from = await itemCenterOnScreen(a.page, 'ti-c1')
  const to = await sceneToScreen(a.page, { x: frame.x + 450, y: frame.y + 400 })
  await a.page.mouse.move(from.x, from.y)
  await a.page.mouse.down()
  await a.page.mouse.move(to.x, to.y, { steps: 12 })
  await a.page.mouse.up()
  await expectSaved(a.page)
  await expect.poll(async () => (await storedLobby(stack, board, 'ti-c1'))['card:status']).toBe('doing')
  await expect(chips(b.page, 'ti-c1')).toHaveAttribute('data-status', 'doing')
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await storedLobby(stack, board, 'ti-c1'))['card:status']).toBe('todo')
  const undone = (await item(a.page, 'ti-c1')) as unknown as { x: number; y: number }
  expect({ x: undone.x, y: undone.y }).toEqual({ x: before.x, y: before.y })
  await expect(chips(b.page, 'ti-c1')).toHaveAttribute('data-status', 'todo')

  // the card table: an inline status moves the Kanban card into its column; bob sees it
  await palette(a.page, 'card table', 'card-table.open')
  await expect(a.page.getByTestId('card-table')).toBeVisible()
  await expect(a.page.getByTestId('card-table-row')).toHaveCount(3)
  await a.page
    .locator('[data-testid="card-table-row"][data-element-id="ti-c2"] [data-testid="card-table-status"]')
    .selectOption('review')
  await expect.poll(async () => (await storedLobby(stack, board, 'ti-c2'))['card:status']).toBe('review')
  await expect
    .poll(async () => ((await item(a.page, 'ti-c2')) as unknown as { x: number }).x)
    .toBe(frame.x + 650)
  await expect(chips(b.page, 'ti-c2')).toHaveAttribute('data-status', 'review')

  // the CSV
  const download = a.page.waitForEvent('download')
  await a.page.getByTestId('card-table-export').click()
  const csv = (await (await (await download).createReadStream()).toArray()).join('').replace(/^﻿/, '')
  const lines = csv.split('\r\n')
  expect(lines[0]).toBe('title,status,assignee,start,due,tags,link')
  expect(csv).toContain('Cast the lead,To do,')
  expect(csv).toContain('Location scout,In review,')
  expect(csv).toContain('Book the studio,To do,')
  await a.page.keyboard.press('Escape')

  // dates in the popover: a start and a due date on one card, a due date alone (a milestone) on another
  const monday = thisMonday()
  const day = (n: number) => {
    const d = new Date(monday)
    d.setDate(d.getDate() + n)
    return iso(d)
  }
  await showAll(a.page)
  await details(a.page, 'ti-c1')
  await popover(a.page).getByTestId('card-due').fill(day(10))
  await popover(a.page).getByTestId('card-start').fill(day(7))
  await expectSaved(a.page)
  await a.page.keyboard.press('Escape')
  await details(a.page, 'ti-c2')
  await popover(a.page).getByTestId('card-due').fill(day(21))
  await expectSaved(a.page)
  await a.page.keyboard.press('Escape')
  await expect(popover(a.page)).toHaveCount(0)
  await expect
    .poll(async () => {
      const l = await storedLobby(stack, board, 'ti-c1')
      return [l['card:start'], l['card:due']]
    })
    .toEqual([day(7), day(10)])

  // a timeline from the palette (this week on, twelve weeks): it draws those cards, a bar and a milestone
  await palette(a.page, 'timeline', 'timeline.new')
  await expect.poll(() => selection(a.page)).toHaveLength(1)
  const tl = (await selection(a.page))[0] as string
  expect(Object.keys(lobbyOf(await item(a.page, tl)))).toEqual(['timeline'])
  for (const s of [a, b]) await fitBoard(s.page)
  for (const s of [a, b]) {
    await expect(timelineOf(s.page, tl)).toBeVisible()
    await expect(s.page.getByTestId('timeline-bar')).toHaveCount(2)
  }
  await expect(barOf(a.page, 'ti-c1')).toHaveAttribute('data-kind', 'bar')
  await expect(barOf(a.page, 'ti-c2')).toHaveAttribute('data-kind', 'milestone')
  await expect(barOf(a.page, 'ti-n3')).toHaveCount(0)

  // a bar dragged a week to the right moves both dates; bob sees it
  const weekPx = ((await timelineOf(a.page, tl).boundingBox())?.width ?? 0) / 12
  expect(weekPx).toBeGreaterThan(10)
  await dragBar(a.page, 'ti-c1', weekPx)
  await expect.poll(() => datesOf(a.page, 'ti-c1')).toEqual({ start: day(14), due: day(17) })
  await expectSaved(a.page)
  await expect.poll(async () => (await storedLobby(stack, board, 'ti-c1'))['card:start']).toBe(day(14))
  await expect(barOf(b.page, 'ti-c1')).toHaveAttribute('data-start', day(14))
  await expect(barOf(b.page, 'ti-c1')).toHaveAttribute('data-due', day(17))

  // bob only received all of it: he pushed nothing
  expect(bobPushes()).toBe(quiet)

  // a name-only guest (a workshop link): no assignee picker in the popover nor the table
  const r = await post(a, `/api/boards/${board}/review-links`, { role: 'editor', allowGuests: true })
  expect(r.status(), await r.text()).toBe(201)
  const { url } = (await r.json()) as { url: string }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const page = await context.newPage()
    foreign.push(foreignRequests(context))
    await page.goto(url)
    await page.getByTestId('invite-guest-name').fill('Gina Guest')
    await page.getByTestId('invite-guest-join').click()
    await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
    await waitForWorkshopBoard(page)
    await roomSays14(page)
    await noPlanningOverride(page)
    await expectItemsEverywhere([{ page, user: 'gina' }], ['ti-c1'])
    await showAll(page)
    await details(page, 'ti-c1')
    await expect(popover(page).getByTestId('card-guest-hint')).toHaveText("Guests can't assign people.")
    await expect(popover(page).getByTestId('card-assign')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await palette(page, 'card table', 'card-table.open')
    await expect(
      page.locator('[data-testid="card-table-row"] [data-testid="card-table-who"]').first(),
    ).toBeDisabled()
    expect((await storedLobby(stack, board, 'ti-c1'))['card:who']).toBeUndefined()
  } finally {
    await context.close()
  }
  for (const f of foreign) expect(f).toEqual([])
})
