// OWNER: WS4 (wave T, T3/T4; docs/WAVE-T-CONTRACTS.md §2). Work cards, Kanban and the card table on the Excalidraw
// board page, with the sync's planning switch on (DRAFTROOM_PLANNING=on: the room says 14) and WS4's web switches on
// (t4-kit.ts). alice = owner, bob = editor; a name-only guest joins through a workshop link.
//
//   cd e2e && E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/t4-cards.spec.ts --project=chromium --workers=1
//
// What each test pins:
//  - make a card from the selection bar, set its status, assignee and dates in the popover (start never after due),
//    the other tab live and pushing nothing while it only receives; Ctrl+Z undoes one field;
//  - a Kanban (Ctrl+K "Kanban board"), a column renamed for both tabs; a card dragged between columns writes its
//    position and status in ONE step (one Ctrl+Z undoes both, on the server too); the other tab pushes nothing;
//  - a move that wrote no status (a client of the previous build) shows as a mismatch on both tabs, nobody writes
//    anything on their own, and Tidy (the actor) puts the card back in its column;
//  - the card table: a status edited inline moves a Kanban card into its column in the same step; the CSV out is
//    formula-safe and pasting it back makes the same cards;
//  - a name-only guest sees no assignee picker (and the table's is disabled), may set a status, and a forged
//    assignee write of theirs is refused.
import type { Page } from '@playwright/test'
import { expectSaved, item, itemCenterOnScreen, sceneToScreen, select } from '../tests/support/canvas.ts'
import { forgeSession, storedElement } from '../tests/support/excalidraw.ts'
import {
  cardKeys,
  chips,
  expect,
  expectItemsEverywhere,
  focusCanvas,
  lobbyIn,
  openCard,
  planningOn,
  popover,
  post,
  roomSays14,
  seedPlanning,
  showAll,
  storedLobby,
  test,
  waitForWorkshopBoard,
  withPlanning,
} from './t4-kit.ts'

test.use({ syncEnv: { DRAFTROOM_PLANNING: 'on' }, viewport: { width: 1440, height: 900 } })

const TOP = 72 + 16 // the Kanban's header band and padding (features/kanban/layout.ts)

/** Drags element `id` so its centre lands on scene point `to`. */
async function dragTo(page: Page, id: string, to: { x: number; y: number }) {
  const from = await itemCenterOnScreen(page, id)
  const target = await sceneToScreen(page, to)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 12 })
  await page.mouse.up()
}

const pushesOf = (s: { net: { sentPushes(): unknown[] } }) => s.net.sentPushes().length

/** Where a card's bound label sits relative to the card, as the server stores both (a move keeps it). */
async function labelOffset(stack: Parameters<typeof storedElement>[0], board: string, id: string) {
  const card = (await storedElement(stack, board, id)) as {
    x: number
    y: number
    boundElements?: { id: string; type: string }[] | null
  }
  const labelId = card.boundElements?.find((b) => b.type === 'text')?.id
  expect(labelId).toBeTruthy()
  const label = (await storedElement(stack, board, labelId as string)) as { x: number; y: number }
  return { dx: Math.round(label.x - card.x), dy: Math.round(label.y - card.y) }
}

async function openTable(page: Page) {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByTestId('command-palette-input').fill('card table')
  await page.locator('[data-testid="command-palette-option"][data-entry-id="cmd:card-table.open"]').click()
  await expect(page.getByTestId('card-table')).toBeVisible()
}

test('make a card, set its fields in the popover; the other tab sees each change and pushes nothing', async ({
  join,
  board,
  stack,
}) => {
  const a = await withPlanning(await join('alice'))
  const b = await withPlanning(await join('bob', 'editor'))
  await seedPlanning(a.page, { cards: [{ id: 't4-n1', x: 0, y: 0, text: 'Book the studio' }] })
  await expectItemsEverywhere([a, b], ['t4-n1'])
  for (const s of [a, b]) await showAll(s.page)
  const bobPushes = pushesOf(b)

  // the selection bar makes it a card ("To do")
  await select(a.page, ['t4-n1'])
  await a.page.getByTestId('selection-card-make').click()
  await expect
    .poll(() => storedLobby(stack, board, 't4-n1').then(cardKeys))
    .toEqual({ 'card:status': 'todo' })
  await expect(chips(b.page, 't4-n1')).toHaveAttribute('data-status', 'todo')
  await expect(chips(b.page, 't4-n1').getByTestId('card-chip-status')).toContainText('To do')

  // the popover: status, assignee (a member), dates
  await openCard(a.page, 't4-n1')
  await popover(a.page).getByTestId('card-status-doing').click()
  await expect(chips(b.page, 't4-n1')).toHaveAttribute('data-status', 'doing')
  await popover(a.page).getByTestId('card-assign').click()
  await popover(a.page).locator(`[data-testid="card-assign-option"][data-uid="${b.id}"]`).click()
  await expect(chips(b.page, 't4-n1').getByTestId('card-chip-who')).toHaveAttribute('data-uid', b.id)
  await popover(a.page).getByTestId('card-due').fill('2026-10-30')
  await expect(chips(b.page, 't4-n1').getByTestId('card-chip-due')).toBeVisible()
  // a start after the due date is refused with words, and nothing is written
  await popover(a.page).getByTestId('card-start').fill('2026-11-05')
  await expect(popover(a.page).getByTestId('card-problem')).toContainText('after the due date')
  await popover(a.page).getByTestId('card-start').fill('2026-10-20')
  await expectSaved(a.page)
  await expect
    .poll(() => storedLobby(stack, board, 't4-n1').then(cardKeys))
    .toEqual({
      'card:status': 'doing',
      'card:who': b.id,
      'card:due': '2026-10-30',
      'card:start': '2026-10-20',
    })

  // bob only received: he pushed nothing
  expect(pushesOf(b)).toBe(bobPushes)

  // Ctrl+Z undoes the last field only (the start date), the rest stays
  await a.page.keyboard.press('Escape')
  await expect(popover(a.page)).toHaveCount(0)
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect
    .poll(() => storedLobby(stack, board, 't4-n1').then(cardKeys))
    .toEqual({ 'card:status': 'doing', 'card:who': b.id, 'card:due': '2026-10-30' })
  expect(pushesOf(b)).toBe(bobPushes)
})

test('a Kanban from the palette: five columns on both tabs, a column renamed for both', async ({
  join,
  board,
  stack,
}) => {
  const a = await withPlanning(await join('alice'))
  const b = await withPlanning(await join('bob', 'editor'))

  // Ctrl+K "Kanban board": a frame with five columns, on both tabs
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+k')
  await a.page.getByTestId('command-palette-input').fill('kanban')
  await a.page.locator('[data-testid="command-palette-option"][data-entry-id="cmd:kanban.new"]').click()
  await expect(a.page.getByTestId('kanban')).toHaveCount(1)
  const made = (await a.page.getByTestId('kanban').getAttribute('data-element-id')) as string
  await expectItemsEverywhere([a, b], [made])
  await showAll(b.page)
  await expect(b.page.locator('[data-testid="kanban"] [data-testid="kanban-column"]')).toHaveCount(5)
  await expect(b.page.getByTestId('kanban-column-name')).toHaveText([
    'To do',
    'In progress',
    'In review',
    'Blocked',
    'Done',
  ])

  // a column renamed in place (one key, the frame's kanban value), for both
  await a.page
    .locator('[data-testid="kanban-column"][data-status="doing"] [data-testid="kanban-column-name"]')
    .click()
  await a.page.getByTestId('kanban-column-rename').fill('Shooting')
  await a.page.keyboard.press('Enter')
  await expect(
    b.page.locator('[data-testid="kanban-column"][data-status="doing"] [data-testid="kanban-column-name"]'),
  ).toHaveText('Shooting')
  await expect
    .poll(() => storedLobby(stack, board, made))
    .toEqual({ kanban: { labels: { doing: 'Shooting' } } })
})

test('a drag between Kanban columns writes position and status in ONE step; one Ctrl+Z undoes both', async ({
  join,
  board,
  stack,
}) => {
  const a = await withPlanning(await join('alice'))
  const b = await withPlanning(await join('bob', 'editor'))
  await seedPlanning(a.page, {
    kanbans: [{ id: 't4-k', x: 0, y: 0, w: 1500, h: 900, value: { labels: { doing: 'Shooting' } } }],
    cards: [
      {
        id: 't4-c1',
        x: 50,
        y: 120,
        text: 'Cast the lead',
        frameId: 't4-k',
        lobby: { 'card:status': 'todo' },
      },
    ],
  })
  await expectItemsEverywhere([a, b], ['t4-k', 't4-c1'])
  for (const s of [a, b]) await showAll(s.page)
  await select(a.page, [])
  await focusCanvas(a.page)
  const bobPushes = pushesOf(b)
  const before = (await storedElement(stack, board, 't4-c1')) as { x: number; y: number }
  const offset = await labelOffset(stack, board, 't4-c1')

  // drag it into "Shooting" (the second column, 300..600), off the column's slot: it snaps into the column, its
  // status follows, and its label moves with it (the snap moves the label by the same delta)
  await dragTo(a.page, 't4-c1', { x: 420, y: 400 })
  await expectSaved(a.page)
  await expect.poll(async () => (await storedLobby(stack, board, 't4-c1'))['card:status']).toBe('doing')
  const after = (await storedElement(stack, board, 't4-c1')) as { x: number; y: number; frameId: string }
  expect(after.x).toBe(350)
  expect(after.frameId).toBe('t4-k')
  expect(await labelOffset(stack, board, 't4-c1')).toEqual(offset)
  await expect(chips(b.page, 't4-c1')).toHaveAttribute('data-status', 'doing')
  await expect(
    b.page.locator('[data-testid="kanban-column"][data-status="doing"] [data-testid="kanban-column-count"]'),
  ).toHaveAttribute('data-count', '1')
  // the other tab only drew it
  expect(pushesOf(b)).toBe(bobPushes)

  // ONE Ctrl+Z takes back the move and the status, on the server too
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await storedLobby(stack, board, 't4-c1'))['card:status']).toBe('todo')
  const undone = (await storedElement(stack, board, 't4-c1')) as { x: number; y: number }
  expect({ x: undone.x, y: undone.y }).toEqual({ x: before.x, y: before.y })
  await expect(chips(b.page, 't4-c1')).toHaveAttribute('data-status', 'todo')
  expect(pushesOf(b)).toBe(bobPushes)
})

test('a move that wrote no status shows as a mismatch on both tabs; nobody writes on their own; Tidy fixes it', async ({
  join,
  board,
  stack,
}) => {
  const a = await withPlanning(await join('alice'))
  const b = await withPlanning(await join('bob', 'editor'))
  await seedPlanning(a.page, {
    kanbans: [{ id: 't4-km', x: 0, y: 0, w: 1500, h: 900 }],
    cards: [
      { id: 't4-r1', kind: 'rectangle', x: 50, y: TOP, frameId: 't4-km', lobby: { 'card:status': 'todo' } },
      { id: 't4-r2', kind: 'rectangle', x: 1250, y: TOP, frameId: 't4-km', lobby: { 'card:status': 'done' } },
    ],
  })
  await expectItemsEverywhere([a, b], ['t4-km', 't4-r1', 't4-r2'])
  for (const s of [a, b]) await showAll(s.page)
  const c = await join('carol', 'editor')
  const pushes = [pushesOf(a), pushesOf(b)]

  // a client of the previous build moves the "To do" card into "Done": a position, no status (carol's forged
  // socket names no contracts revision, as an older client)
  const { socket, welcome } = await forgeSession(c.page, board)
  try {
    const el = (await storedElement(stack, board, 't4-r1')) as { version: number }
    await socket.send({
      type: 'push',
      seq: 1,
      base: welcome.clock,
      ops: [{ k: 'p', id: 't4-r1', pv: el.version, g: { pos: { x: 1250, y: TOP + 160 } } }],
    })
    const ack = await socket.next('ack')
    expect(ack.r.map((r: { ok: boolean }) => r.ok)).toEqual([true])
  } finally {
    await socket.close()
  }
  for (const s of [a, b]) {
    await expect.poll(async () => (await item(s.page, 't4-r1'))?.x).toBe(1250)
    const hint = s.page.locator(
      '[data-testid="kanban-column"][data-status="done"] [data-testid="kanban-mismatch"]',
    )
    await expect(hint).toContainText('1 card in the wrong column')
    // the status stays canonical: the chip says "To do"
    await expect(chips(s.page, 't4-r1')).toHaveAttribute('data-status', 'todo')
  }
  // nobody writes on their own (a reader never infers a status from a position)
  await a.page.waitForTimeout(1500)
  expect([pushesOf(a), pushesOf(b)]).toEqual(pushes)
  expect((await storedLobby(stack, board, 't4-r1'))['card:status']).toBe('todo')

  // Tidy: the actor's re-layout puts it back at the top of "To do"
  await a.page
    .locator('[data-testid="kanban-column"][data-status="done"] [data-testid="kanban-tidy"]')
    .click()
  await expect.poll(async () => (await storedElement(stack, board, 't4-r1'))?.x).toBe(50)
  await expect(b.page.getByTestId('kanban-mismatch')).toHaveCount(0)
  expect(pushesOf(b)).toBe(pushes[1])
})

test('the card table: an inline status moves a Kanban card in one step; the CSV is formula-safe and pastes back', async ({
  join,
  board,
  stack,
}) => {
  const a = await withPlanning(await join('alice'))
  const b = await withPlanning(await join('bob', 'editor'))
  await seedPlanning(a.page, {
    kanbans: [{ id: 't4-kt', x: 0, y: 0, w: 1500, h: 900 }],
    cards: [
      {
        id: 't4-t1',
        x: 50,
        y: TOP,
        text: '=SUM(A1:A9) budget',
        frameId: 't4-kt',
        lobby: { 'card:status': 'todo', 'card:who': b.id, 'card:due': '2026-11-02' },
      },
      {
        id: 't4-t2',
        x: 50,
        y: TOP + 230,
        text: 'Location scout',
        frameId: 't4-kt',
        lobby: { 'card:status': 'todo' },
      },
    ],
  })
  await expectItemsEverywhere([a, b], ['t4-t1', 't4-t2'])
  await showAll(a.page)
  await openTable(a.page)
  const rows = a.page.getByTestId('card-table-row')
  await expect(rows).toHaveCount(2)
  await expect(a.page.getByTestId('card-table-summary')).toHaveText('2 cards')

  // an inline status edit: the card moves to the bottom of "In review", in the same step, its label with it
  const offset = await labelOffset(stack, board, 't4-t2')
  await a.page
    .locator('[data-testid="card-table-row"][data-element-id="t4-t2"] [data-testid="card-table-status"]')
    .selectOption('review')
  await expect.poll(async () => (await storedLobby(stack, board, 't4-t2'))['card:status']).toBe('review')
  await expect.poll(async () => (await storedElement(stack, board, 't4-t2'))?.x).toBe(650)
  expect(await labelOffset(stack, board, 't4-t2')).toEqual(offset)
  await expect(chips(b.page, 't4-t2')).toHaveAttribute('data-status', 'review')
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await storedLobby(stack, board, 't4-t2'))['card:status']).toBe('todo')
  expect((await storedElement(stack, board, 't4-t2'))?.x).toBe(50)

  // CSV out: a header, the status in words, the formula cell neutralised
  const download = a.page.waitForEvent('download')
  await a.page.getByTestId('card-table-export').click()
  const file = await download
  const csv = (await (await file.createReadStream()).toArray()).join('')
  const lines = csv.replace(/^﻿/, '').split('\r\n')
  expect(lines[0]).toBe('title,status,assignee,start,due,tags,link')
  expect(csv).toContain(`'=SUM(A1:A9) budget,To do,${b.name},,2026-11-02,,`)
  expect(csv).toContain('Location scout,To do,,,,,')

  // paste it back: the same two cards again (titles, statuses, the assignee by name, the due date), in one step
  await a.page.getByTestId('card-table-import-open').click()
  await a.page.getByTestId('card-table-import-text').fill(csv.replace(/^﻿/, ''))
  await a.page.getByTestId('card-table-import-create').click()
  await expect(rows).toHaveCount(4)
  await expectSaved(a.page)
  const cards = await a.page.evaluate(() => {
    const c = (
      window as unknown as {
        __lobbyBoard: {
          canvas: {
            index: {
              withLobbyKey(k: string): { id: string; customData?: { lobby?: Record<string, unknown> } }[]
            }
            text: { of(id: string): string }
          }
        }
      }
    ).__lobbyBoard.canvas
    return c.index
      .withLobbyKey('card:status')
      .map((e) => ({
        title: c.text.of(e.id),
        keys: Object.fromEntries(
          Object.entries(e.customData?.lobby ?? {}).filter(([k]) => k.startsWith('card:')),
        ),
      }))
      .sort((x, y) => x.title.localeCompare(y.title))
  })
  expect(cards).toEqual([
    {
      title: '=SUM(A1:A9) budget',
      keys: { 'card:status': 'todo', 'card:who': b.id, 'card:due': '2026-11-02' },
    },
    {
      title: '=SUM(A1:A9) budget',
      keys: { 'card:status': 'todo', 'card:who': b.id, 'card:due': '2026-11-02' },
    },
    { title: 'Location scout', keys: { 'card:status': 'todo' } },
    { title: 'Location scout', keys: { 'card:status': 'todo' } },
  ])
  // one Ctrl+Z takes the whole paste back
  await focusCanvas(a.page)
  await a.page.keyboard.press('ControlOrMeta+z')
  await expect(rows).toHaveCount(2)
})

test('a name-only guest: no assignee picker, may set a status; a forged assignee write of theirs is refused', async ({
  join,
  browser,
  board,
  stack,
}) => {
  const a = await withPlanning(await join('alice'))
  await seedPlanning(a.page, {
    cards: [{ id: 't4-g1', x: 0, y: 0, text: 'Mood board', lobby: { 'card:status': 'todo' } }],
  })
  const r = await post(a, `/api/boards/${board}/review-links`, { role: 'editor', allowGuests: true })
  expect(r.status(), await r.text()).toBe(201)
  const { url } = (await r.json()) as { url: string }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    await planningOn(context)
    const page = await context.newPage()
    await page.goto(url)
    await page.getByTestId('invite-guest-name').fill('Gina Guest')
    await page.getByTestId('invite-guest-join').click()
    await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
    await waitForWorkshopBoard(page)
    await roomSays14(page)
    await expectItemsEverywhere([{ page, user: 'gina' }], ['t4-g1'])
    await showAll(page)

    await openCard(page, 't4-g1')
    await expect(popover(page).getByTestId('card-guest-hint')).toHaveText("Guests can't assign people.")
    await expect(popover(page).getByTestId('card-assign')).toHaveCount(0)
    // a status is theirs to set
    await popover(page).getByTestId('card-status-blocked').click()
    await expect.poll(async () => (await storedLobby(stack, board, 't4-g1'))['card:status']).toBe('blocked')
    await expect(chips(a.page, 't4-g1')).toHaveAttribute('data-status', 'blocked')
    await page.keyboard.press('Escape')

    // the table's assignee cell is disabled for them
    await openTable(page)
    await expect(page.locator('[data-testid="card-table-row"] [data-testid="card-table-who"]')).toBeDisabled()

    // an assignee written anyway from their own tab (past the UI): the room refuses it, the tab takes it back
    await page.evaluate(
      ([id, uid]) => {
        type Tx = { update(id: string, patch: Record<string, unknown>): void }
        const b = (
          window as unknown as {
            __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } }
          }
        ).__lobbyBoard
        b.canvas.transact('forged assignee', (tx) =>
          tx.update(id as string, { customData: { lobby: { 'card:who': uid } } }),
        )
      },
      ['t4-g1', a.id],
    )
    await expect
      .poll(async () => (await lobbyIn(page, 't4-g1'))['card:who'], { timeout: 15_000 })
      .toBeUndefined()
    expect((await storedLobby(stack, board, 't4-g1'))['card:who']).toBeUndefined()
    expect(await lobbyIn(a.page, 't4-g1')).not.toHaveProperty('card:who')
  } finally {
    await context.close()
  }
})
