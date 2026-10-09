// Wave L (W2, L2-3): Wrap up and Catch me up in two browsers, against the real api and sync server, with the e2e
// AI fake (ai-kit `fakeAiRuns`: the api's own answer where it runs 'recap' (W1), else the canned recap, whose top
// voted list comes from the board's revealed tallies just as the api's does).
//  - Notes are made by two people, a vote is revealed, and Wrap up runs: the top voted list equals the tallies;
//    "Planned vs actual" lists the run of show's sections (W5's agendaActuals; annotated where this build has no
//    run of show yet); "Add as Recap frame" gets no server rejection, bob sees it, one Ctrl+Z removes all of it;
//    Copy as Markdown copies the Markdown; "Export recap as PDF" is a download.
//  - A viewer limited by the export policy gets the honest no-AI recap (no /ai/run at all) and no PDF export.
//  - The e2e network assertion: nothing leaves Lobby's origins.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/l2-wrapup.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import { expectSaved, items, saveState } from '../tests/support/canvas.ts'
import { pressUndo, pushCount } from '../tests/support/excalidraw.ts'
import { collectDownloads, downloadFrom } from '../tests/support/present-export.ts'
import {
  AI_API_ENV_3H,
  aiRunRequests,
  FAKE_OPENAI_PORT_3H,
  fakeAiRuns,
  foreignRequests,
  hasShell,
} from './ai-kit.ts'
import { expect, post, seed, showAll, type WorkshopCanvasSession, test as wk } from './workshops-kit.ts'

const test = wk.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(FAKE_OPENAI_PORT_3H)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: AI_API_ENV_3H })
test.beforeEach(({ openai }) => openai.reset())

const NOTES = [
  { id: 'l2w-a', x: 0, y: 0, text: 'Summer beach screenings' },
  { id: 'l2w-b', x: 260, y: 0, text: 'Solstice trailer drop' },
  { id: 'l2w-c', x: 520, y: 0, text: 'Creator reaction videos' },
  { id: 'l2w-d', x: 780, y: 0, text: 'Ski lodge premiere' },
]

/** Right-click on empty canvas → AI › Wrap up this session; continues the notice when it shows. */
async function wrapUp(page: Page) {
  expect(await hasShell(page, 'contextMenu')).toBe(true)
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  // top right: clear of the notes and of the vote's results card at the bottom
  await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.2, { button: 'right' })
  await page.getByRole('menuitem', { name: 'AI' }).click()
  await page.getByRole('menuitem', { name: 'Wrap up this session' }).click()
  const cont = page.getByTestId('ai-notice-continue')
  const done = page.locator('[data-testid="recap-panel"][data-status="done"]')
  await expect(cont.or(done).first()).toBeVisible({ timeout: 20_000 })
  if (await cont.isVisible()) await cont.click()
  await expect(done).toBeVisible({ timeout: 20_000 })
  return done
}

/** The board's revealed tallies as the api has them (ref, count, rank), top 5 in rank order. */
async function tallies(s: WorkshopCanvasSession, board: string) {
  const res = await s.api.fetch('GET', `/api/boards/${board}/workshop`)
  const body = (await res.json()) as {
    vote?: { results?: { shapeId: string; count: number; rank: number }[] }
  }
  return (body.vote?.results ?? [])
    .filter((r) => r.count > 0)
    .sort((p, q) => p.rank - q.rank || q.count - p.count)
    .slice(0, 5)
    .map((r) => ({ ref: r.shapeId, votes: r.count, rank: r.rank }))
}

test('Wrap up after a revealed vote: the top voted list equals the tallies; the Recap frame lands with no rejection, bob sees it, one undo removes it; Markdown and PDF', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  const foreign = [...foreignRequests(a.page), ...foreignRequests(b.page)]
  await seed(a.page, { notes: NOTES.slice(0, 2) })
  await seed(b.page, { notes: NOTES.slice(2) })
  await expect.poll(async () => (await items(a.page)).filter((e) => e.type === 'stickynote').length).toBe(4)
  await showAll(a.page)

  await test.step('a vote: bob gives three dots, alice two, alice reveals', async () => {
    const r = await post(a, `/api/boards/${board}/votes`, {
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
    })
    expect(r.status(), await r.text()).toBe(201)
    const sid = ((await r.json()) as { session: { id: string } }).session.id
    for (const [s, id] of [
      [b, 'l2w-b'],
      [b, 'l2w-b'],
      [b, 'l2w-c'],
      [a, 'l2w-b'],
      [a, 'l2w-a'],
    ] as const)
      expect((await post(s, `/api/votes/${sid}/cast`, { shapeId: `shape:${id}`, delta: 1 })).status()).toBe(
        200,
      )
    expect((await post(a, `/api/votes/${sid}/reveal`)).status()).toBe(200)
    await expect(a.page.locator('[data-testid="vote-count"][data-shape-id$="l2w-b"]')).toHaveAttribute(
      'data-rank',
      '1',
    )
  })

  const fake = await fakeAiRuns(a.page)
  const panel = await wrapUp(a.page)
  const call = fake.of('recap')[0]
  test.info().annotations.push({ type: 'recap', description: `answered by the ${call?.served ?? 'nobody'}` })
  expect(call?.body).toMatchObject({ action: 'recap', mode: 'panel', scope: { kind: 'since' } })

  await test.step('the top voted list equals the revealed tallies', async () => {
    const want = await tallies(a, board)
    expect(want.map((w) => w.votes)).toEqual([3, 1, 1])
    const shown = await panel.getByTestId('recap-vote').evaluateAll((els) =>
      els.map((e) => ({
        ref: e.getAttribute('data-ref'),
        votes: Number(e.getAttribute('data-votes')),
        rank: Number(e.getAttribute('data-rank')),
      })),
    )
    expect(shown).toEqual(want)
    await expect(panel.getByTestId('recap-top-voted')).toContainText('Solstice trailer drop')
  })

  await test.step('planned vs actual: the run of show’s sections', async () => {
    const rows = await panel.getByTestId('recap-pva-row').count()
    if (rows === 0)
      test.info().annotations.push({
        type: 'planned vs actual',
        description:
          'not shown: no run of show recorded (W5 agendaActuals is the foundation stub on this branch)',
      })
    else expect(rows).toBe(2)
  })

  await test.step('Copy as Markdown', async () => {
    await a.page.evaluate(() => {
      const w = window as unknown as { __copied: string[] }
      w.__copied = []
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (t: string) => void w.__copied.push(t),
      })
    })
    await panel.getByTestId('recap-copy').click()
    await expect(panel.getByTestId('recap-copy')).toHaveText('Copied')
    const md = await a.page.evaluate(() => (window as unknown as { __copied: string[] }).__copied[0] ?? '')
    expect(md.startsWith('# Recap · ')).toBe(true)
    expect(md).toContain('## Top voted')
    expect(md).toContain('1. Solstice trailer drop (3 votes)')
  })

  const before = (await items(a.page)).length
  await test.step('Add as Recap frame: no server rejection, bob sees it', async () => {
    const bPushes = await pushCount(b.page)
    await panel.getByTestId('recap-add').click()
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    const frame = (await items(a.page)).find(
      (e) => e.type === 'frame' && String(e.name).startsWith('Recap · '),
    )
    expect(frame).toBeTruthy()
    await expect
      .poll(async () => (await items(b.page)).some((e) => e.type === 'frame' && e.id === frame?.id))
      .toBe(true)
    // bob only watched
    expect(await pushCount(b.page)).toBe(bPushes)
  })

  await test.step('Export recap as PDF: a download', async () => {
    await panel.getByTestId('recap-pdf').click()
    const dialog = a.page.getByTestId('export-dialog')
    await expect(dialog).toBeVisible()
    const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
    expect(pdf.name).toMatch(/\.pdf$/)
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-')
    await a.page.keyboard.press('Escape')
  })

  await test.step('one Ctrl+Z removes the frame and everything in it, for both', async () => {
    await a.page.getByTestId('recap-panel').getByRole('button', { name: 'Close recap' }).click()
    await a.page.locator('[data-lobby-board-canvas]').click({ position: { x: 40, y: 500 } })
    await pressUndo(a.page)
    await expect.poll(async () => (await items(a.page)).length).toBe(before)
    await expect
      .poll(async () =>
        (await items(b.page)).some((e) => e.type === 'frame' && String(e.name).startsWith('Recap')),
      )
      .toBe(false)
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
  })
  expect(foreign).toEqual([])
})

/** Board menu › Board › Catch me up; continues the notice when it shows; the finished panel. */
async function catchMeUp(page: Page) {
  await page.getByTestId('main-menu.button').click()
  await page.getByTestId('main-menu-sub.dr-board-button').click()
  await page.getByRole('menuitem', { name: 'Catch me up' }).click()
  const cont = page.getByTestId('ai-notice-continue')
  const done = page.locator('[data-testid="recap-panel"][data-status="done"]')
  await expect(cont.or(done).first()).toBeVisible({ timeout: 20_000 })
  if (await cont.isVisible()) await cont.click()
  await expect(done).toBeVisible({ timeout: 20_000 })
  return done
}

test('a viewer the export policy limits gets the recap without AI (no /ai/run) and no PDF export; the owner gets both', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  await seed(a.page, { notes: NOTES })
  // a recap frame on the board: what "Export recap as PDF" would export
  await a.page.evaluate(() =>
    (
      window as unknown as {
        __lobbyBoard: {
          canvas: { transact(l: string, fn: (tx: { create(k: string, p: object): string }) => void): void }
        }
      }
    ).__lobbyBoard.canvas.transact('e2e: recap frame', (tx) => {
      tx.create('frame', {
        x: 1200,
        y: 0,
        width: 800,
        height: 400,
        name: 'Recap · earlier',
        customData: { lobby: { kind: 'recap' } },
      })
    }),
  )
  await expectSaved(a.page)
  const res = await a.api.fetch('PUT', `/api/boards/${board}/export-policy`, { exportPolicy: 'editors' })
  expect(res.status()).toBe(200)

  const v = await join('vera', 'viewer')
  const runs = aiRunRequests(v.page)
  const downloads = collectDownloads(v.page)
  await expect.poll(async () => (await items(v.page)).filter((e) => e.type === 'stickynote').length).toBe(4)
  await test.step('vera: Catch me up without AI, says why, and offers no PDF export', async () => {
    const panel = await catchMeUp(v.page)
    await expect(panel).toHaveAttribute('data-ai', 'false')
    await expect(panel.getByTestId('recap-ai-note')).toHaveText(
      'Without AI: AI is off for you on this board.',
    )
    await expect(panel.getByTestId('recap-add')).toHaveCount(0)
    await expect(panel.getByTestId('recap-copy')).toBeVisible()
    await expect(panel.getByTestId('recap-pdf')).toHaveCount(0)
    expect(runs).toEqual([])
    expect(downloads).toEqual([])
  })

  await test.step('control: the owner (not limited) gets the AI recap and the PDF export of the recap frame', async () => {
    const fake = await fakeAiRuns(a.page)
    const panel = await catchMeUp(a.page)
    expect(fake.of('recap')[0]?.body).toMatchObject({ action: 'recap', scope: { kind: 'since' } })
    await expect(panel).toHaveAttribute('data-ai', 'true')
    await expect(panel.getByTestId('recap-pdf')).toBeVisible()
  })
})
