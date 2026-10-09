// Wave L time travel (owner W7): the History panel's scrubber over every checkpoint with a visual diff against the
// board now (L7-1), and "Restore these" into the live board for everyone, with "Undo restore" (L7-2).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l7-time-travel.spec.ts --project=chromium --workers=1
//
//  - scrubbing 10 checkpoints stays under GET /api/snapshots/:sid/content's 60 a minute (a tick is asked for once
//    the scrubber rests on it; a quick scrub asks for the last one only); the p95 tick-to-preview on a board of
//    500 elements is recorded and under 400 ms; the keyboard moves the scrubber (Left/Right, Home/End);
//  - axe finds nothing on the open dialog;
//  - a viewer scrubs and sees the changes but is offered no restore;
//  - two browsers: A restores 3 notes (2 deleted since, 1 moved), B sees them within sync latency and pushes
//    nothing in reaction; "Undo restore" brings back the board as it was before the restore, on the server too.
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import type { Api } from '../tests/support/api.ts'
import { createItem, expect, expectSaved, pushedOps, test } from '../tests/support/canvas.ts'
import { openHistory } from '../tests/support/history.ts'
import { describeServerBoard, describeTab, NOTE_FILL, onBoard, placement } from './history-kit.ts'

// ---- helpers ----------------------------------------------------------------------------------------------

const dialog = (page: Page) => page.getByTestId('checkpoint-preview-dialog')
const timeline = (page: Page) => dialog(page).getByTestId('history-timeline')

/** The tick shown is drawn: the bitmap shows the checkpoint the timeline is on. */
async function expectDrawn(page: Page, timeout = 20_000): Promise<string> {
  const d = dialog(page)
  await expect
    .poll(
      async () => {
        const [want, drawn] = await Promise.all([
          d.getAttribute('data-snapshot-id'),
          d.getAttribute('data-drawn-id'),
        ])
        return !!want && want === drawn
      },
      { timeout, message: 'the bitmap shows the checkpoint the timeline is on' },
    )
    .toBe(true)
  return (await d.getAttribute('data-snapshot-id')) as string
}

/** Opens "Time travel" from the open History panel: the dialog on the newest checkpoint, drawn. */
async function openTimeTravel(page: Page): Promise<Locator> {
  await page.getByTestId('history-time-travel').click()
  await expect(dialog(page)).toBeVisible()
  await expectDrawn(page)
  return dialog(page)
}

const tickIndex = async (page: Page) => Number(await timeline(page).getAttribute('data-index'))

async function saveCheckpoint(api: Api, board: string, name: string): Promise<string> {
  const res = await api.fetch('POST', `/api/boards/${board}/snapshots`, { name })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

/** `n` notes with words through the page's canvas, `per` to a transaction (one push each), then Saved. */
async function bulkNotes(page: Page, prefix: string, n: number, per = 100): Promise<string[]> {
  const ids: string[] = []
  for (let start = 0; start < n; start += per) {
    const batch = Array.from({ length: Math.min(per, n - start) }, (_, k) => {
      const i = start + k
      return { id: `${prefix}${i}`, x: (i % 25) * 240, y: Math.floor(i / 25) * 240, text: `Idea ${i}` }
    })
    await page.evaluate((list) => {
      const b = (
        window as unknown as {
          __lobbyBoard?: {
            canvas: {
              transact(
                l: string,
                fn: (tx: {
                  createMany(items: { kind: string; props: Record<string, unknown> }[]): string[]
                }) => void,
              ): void
            }
          }
        }
      ).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page?)')
      b.canvas.transact('e2e: notes', (tx) => tx.createMany(list.map((props) => ({ kind: 'note', props }))))
    }, batch)
    await expectSaved(page, 60_000)
    ids.push(...batch.map((b) => b.id))
  }
  return ids
}

/** Moves `id` by a scene delta through the page's canvas (one undo step), then Saved. */
async function moveBy(page: Page, id: string, dx: number, dy = 0): Promise<void> {
  await page.evaluate(
    ({ id, dx, dy }) => {
      const b = (
        window as unknown as {
          __lobbyBoard?: {
            canvas: {
              get(id: string): { x: number; y: number } | undefined
              transact(
                l: string,
                fn: (tx: { update(i: string, p: Record<string, unknown>): void }) => void,
              ): void
            }
          }
        }
      ).__lobbyBoard
      if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page?)')
      const el = b.canvas.get(id)
      if (!el) throw new Error(`no ${id}`)
      b.canvas.transact('e2e: move', (tx) => tx.update(id, { x: el.x + dx, y: el.y + dy }))
    },
    { id, dx, dy },
  )
  await expectSaved(page)
}

/** Deletes `ids` in one step through the page's canvas. */
async function deleteAll(page: Page, ids: string[]): Promise<void> {
  await page.evaluate((list) => {
    const b = (
      window as unknown as {
        __lobbyBoard?: {
          canvas: { transact(l: string, fn: (tx: { delete(id: string): void }) => void): void }
        }
      }
    ).__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page?)')
    b.canvas.transact('e2e: delete', (tx) => {
      for (const id of list) tx.delete(id)
    })
  }, ids)
  await expectSaved(page)
}

/** p-th percentile (nearest rank). */
function percentile(values: readonly number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] as number
}

/** Every GET /api/snapshots/:sid/content of the page: its status. */
function contentRequests(page: Page): number[] {
  const statuses: number[] = []
  page.on('response', (res) => {
    if (/\/api\/snapshots\/[^/]+\/content$/.test(new URL(res.url()).pathname)) statuses.push(res.status())
  })
  return statuses
}

// ---- L7-1: the scrubber ------------------------------------------------------------------------------------

test('scrubbing 10 checkpoints of a 500-element board: under the rate limit, keyboard, p95 tick-to-preview (recorded)', async ({
  canvasSession,
  board,
  users,
}, testInfo) => {
  test.setTimeout(300_000)
  const a = await canvasSession('alice')
  const api = await users.api('alice')
  const ids = await bulkNotes(a.page, 'tt', 250)
  await expect.poll(async () => (await describeTab(a.page)).length, { timeout: 30_000 }).toBe(250)
  // 10 checkpoints, one note moved between each
  for (let i = 0; i < 10; i++) {
    if (i) await moveBy(a.page, ids[i] as string, 0, 120)
    await saveCheckpoint(api, board, `Step ${i + 1}`)
  }
  const statuses = contentRequests(a.page)
  await openHistory(a.page)
  const startedAt = Date.now()
  const d = await openTimeTravel(a.page)
  await expect(timeline(a.page)).toHaveAttribute('aria-valuemax', '10')
  expect(await tickIndex(a.page)).toBe(9)

  await test.step('the keyboard: Home is the oldest, End the newest, Left and Right one step', async () => {
    await timeline(a.page).focus()
    await a.page.keyboard.press('Home')
    await expect(timeline(a.page)).toHaveAttribute('data-index', '0')
    await expect(timeline(a.page)).toHaveAttribute('aria-valuetext', /Step 1, .+ \(1 of 10\)$/)
    await expectDrawn(a.page)
    await a.page.keyboard.press('End')
    await expect(timeline(a.page)).toHaveAttribute('data-index', '9')
    await a.page.keyboard.press('ArrowLeft')
    await expect(timeline(a.page)).toHaveAttribute('data-index', '8')
    await a.page.keyboard.press('ArrowRight')
    await expect(timeline(a.page)).toHaveAttribute('data-index', '9')
    await expectDrawn(a.page)
  })

  const ticks: number[] = []
  await test.step('one tick at a time, oldest to newest: each preview drawn, tick-to-preview recorded', async () => {
    await a.page.keyboard.press('Home')
    await expectDrawn(a.page)
    for (let i = 1; i < 10; i++) {
      await a.page.keyboard.press('ArrowRight')
      await expect(timeline(a.page)).toHaveAttribute('data-index', String(i))
      const id = await expectDrawn(a.page)
      await expect(d).toHaveAttribute('data-shape-count', '250')
      expect(id).toBe(await d.getAttribute('data-snapshot-id'))
      ticks.push(Number(await d.getAttribute('data-tick-ms')))
      // the diff of a checkpoint i steps back: i notes moved since
      await expect(d.getByTestId('history-diff-summary')).toContainText(
        i === 9 ? 'No differences' : `${9 - i} moved or resized`,
      )
    }
  })

  await test.step('a quick scrub asks for the tick it rests on only', async () => {
    await d.getByTestId('checkpoint-preview-close').click()
    await expect(d).toHaveCount(0)
    const before = statuses.length
    await openTimeTravel(a.page)
    await timeline(a.page).focus()
    for (let i = 0; i < 9; i++) await a.page.keyboard.press('ArrowLeft')
    await expect(timeline(a.page)).toHaveAttribute('data-index', '0')
    await expectDrawn(a.page)
    // the newest (opened at once), the oldest (rested on) and one neighbour fetched ahead, nothing in between
    await expect.poll(() => statuses.length - before).toBeLessThanOrEqual(3)
  })

  const p95 = percentile(ticks, 95)
  const report = { ticks, p50: percentile(ticks, 50), p95, contentRequests: statuses.length, elements: 500 }
  console.log('[l7-tick-to-preview]', JSON.stringify(report))
  testInfo.annotations.push({ type: 'l7-tick-to-preview', description: JSON.stringify(report) })
  // under the limit, and never refused
  expect(
    statuses.every((s) => s === 200),
    JSON.stringify(statuses),
  ).toBe(true)
  expect(statuses.length).toBeLessThan(60)
  expect(Date.now() - startedAt).toBeLessThan(120_000)
  expect(p95).toBeLessThan(400)
})

test('the time-travel dialog passes the accessibility audit (axe), changes listed', async ({
  canvasSession,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  const api = await users.api('alice')
  await expectSaved(a.page)
  for (const [i, id] of ['ax1', 'ax2', 'ax3'].entries())
    await createItem(a.page, 'note', {
      id,
      x: i * 260,
      y: 0,
      text: `Topic ${i}`,
      backgroundColor: NOTE_FILL.yellow,
    })
  await expectSaved(a.page)
  await saveCheckpoint(api, board, 'Before')
  await deleteAll(a.page, ['ax1'])
  await moveBy(a.page, 'ax2', 0, 300)
  await saveCheckpoint(api, board, 'After')
  await openHistory(a.page)
  const d = await openTimeTravel(a.page)
  await timeline(a.page).focus()
  await a.page.keyboard.press('Home')
  await expectDrawn(a.page)
  await expect(d.getByTestId('history-diff-summary')).toContainText('1 removed since · 1 moved or resized')
  await d.getByTestId('history-diff-details').locator('summary').click()
  await expect(d.getByTestId('history-diff-item')).toHaveCount(2)
  const results = await new AxeBuilder({ page: a.page })
    .include('[data-testid="checkpoint-preview-dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([])
  // what axe could not decide: only colour contrast over the bitmap (the same acceptance as the board's audit)
  const undecided = results.incomplete
    .filter((v) => v.id !== 'color-contrast')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  expect(undecided).toEqual([])
})

test('a viewer scrubs and sees the changes, but is offered no restore', async ({
  canvasSession,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  const v = await canvasSession('bob', { role: 'viewer' })
  const api = await users.api('alice')
  await createItem(a.page, 'note', { id: 'vw1', x: 0, y: 0, text: 'Agenda', backgroundColor: NOTE_FILL.blue })
  await expectSaved(a.page)
  await saveCheckpoint(api, board, 'First')
  await moveBy(a.page, 'vw1', 400)
  await saveCheckpoint(api, board, 'Second')
  await expect.poll(async () => (await placement(v.page, 'vw1'))?.x).toBe(400)
  await openHistory(v.page)
  const d = await openTimeTravel(v.page)
  await timeline(v.page).focus()
  await v.page.keyboard.press('ArrowLeft')
  await expectDrawn(v.page)
  await expect(d.getByTestId('history-diff-summary')).toContainText('1 moved or resized')
  await expect(d.getByTestId('history-restore-elements')).toHaveCount(0)
  await expect(d.getByTestId('history-select-changes')).toHaveCount(0)
  await d.getByTestId('history-diff-details').locator('summary').click()
  await expect(d.getByTestId('history-diff-item')).toHaveCount(1)
  await expect(d.getByTestId('history-diff-select')).toHaveCount(0)
  // and the api would refuse it anyway
  const bobApi = await users.api('bob')
  const sid = (await d.getAttribute('data-snapshot-id')) as string
  const res = await bobApi.fetch('POST', `/api/boards/${board}/snapshots/${sid}/restore-elements`, {
    ids: ['vw1'],
  })
  expect(res.status()).toBe(403)
})

// ---- L7-2: restore into the live board, for everyone -------------------------------------------------------

test('two browsers: A restores 3 notes, B sees them within sync latency and pushes nothing; Undo restore brings back the board before', async ({
  canvasSession,
  board,
  stack,
  users,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const api = await users.api('alice')
  for (const [i, id] of ['rs1', 'rs2', 'rs3', 'rs4'].entries())
    await createItem(a.page, 'note', {
      id,
      x: i * 260,
      y: 0,
      text: `Workshop idea ${i + 1}`,
      backgroundColor: NOTE_FILL.green,
    })
  await expectSaved(a.page)
  const workshop = await describeServerBoard(stack, board)
  await saveCheckpoint(api, board, 'After the workshop')
  // the board gets wrecked: two notes deleted, one moved away
  await deleteAll(a.page, ['rs1', 'rs2'])
  await moveBy(a.page, 'rs3', 900, 600)
  await expect.poll(() => onBoard(b.page, 'rs1')).toBe(false)
  await expect.poll(async () => (await placement(b.page, 'rs3'))?.x).toBe(520 + 900)
  const wrecked = await describeServerBoard(stack, board)
  await expectSaved(b.page)
  const bobPushes = (await pushedOps(b.page)).length

  await openHistory(a.page)
  const d = await openTimeTravel(a.page)
  await expect(d).toContainText('After the workshop')
  await expect(d.getByTestId('history-diff-summary')).toContainText('2 removed since · 1 moved or resized')
  await d.getByTestId('history-select-changes').click()
  const restoreButton = d.getByTestId('history-restore-elements')
  await expect(restoreButton).toHaveText('Restore 3 objects')
  const clickedAt = Date.now()
  await restoreButton.click()
  await expect(a.page.getByTestId('history-restored-notice')).toContainText(
    'Restored 3 objects for everyone.',
  )
  await expect(d).toHaveCount(0)

  let latencyMs = 0
  await test.step('B sees them within sync latency, without a reload', async () => {
    await expect
      .poll(
        async () =>
          (await onBoard(b.page, 'rs1')) &&
          (await onBoard(b.page, 'rs2')) &&
          (await placement(b.page, 'rs3'))?.x === 520,
        { timeout: 5_000 },
      )
      .toBe(true)
    latencyMs = Date.now() - clickedAt
    expect(await describeServerBoard(stack, board)).toEqual(workshop)
    await expect.poll(() => describeTab(b.page)).toEqual(workshop)
    console.log('[l7-restore-latency-ms]', latencyMs)
  })

  await test.step('B pushes nothing in reaction', async () => {
    await b.page.waitForTimeout(1_500)
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })

  await test.step('Undo restore: the board as it was before the restore, for both, on the server too', async () => {
    await a.page.getByTestId('history-undo-restore').click()
    await expect(a.page.getByTestId('history-restored-notice')).toContainText('Restore undone')
    await expect.poll(() => describeServerBoard(stack, board), { timeout: 10_000 }).toEqual(wrecked)
    await expect.poll(() => describeTab(b.page)).toEqual(wrecked)
    await expect.poll(() => describeTab(a.page)).toEqual(wrecked)
    await b.page.waitForTimeout(1_500)
    expect((await pushedOps(b.page)).length).toBe(bobPushes)
  })
})
