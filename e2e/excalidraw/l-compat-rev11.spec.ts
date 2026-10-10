// Stale pair (c) with the REAL previous web (wave L integration, follow-up 1; docs/EXCALIDRAW-CONTRACTS.md §0b).
// A tab of the web deployed before wave L (437b4e7, CONTRACTS_REV 11: its own build, served on this run's web
// origin, its board socket's frames parsed with its own frozen schemas; ./l-compat-kit.ts) and a tab of this
// tree's web, on one board, through this tree's rev-12 sync and api. For every wave L feature that writes to the
// board, the rev-11 tab:
//  - receives every change: no frame the rev-12 room sends it is one its socket would drop, and it holds exactly
//    the server's board (the convergence hash, tombstones included), the rev-12 tab too;
//  - stays in sync after an offline window (its socket cut and its reconnects held while the rev-12 tab writes,
//    then its catch-up);
//  - and keeps the rev-12 data when it edits those elements: its Frames panel's reorder, skip and auto-order keep
//    the planned minutes, its moves and recolours keep the AI provenance (with the run id) and the kinds.
// Before the per-reader rule its socket dropped every `changes` frame with a `present.mins` (and every op
// committed with it) while showing Saved, and its reorder erased the minutes.
//
//   E2E_OLD_WEB_DIST=<the 437b4e7 web's dist> E2E_PORT_BASE=<base> \
//     pnpm exec playwright test excalidraw/l-compat-rev11.spec.ts --project=chromium --workers=1   (from e2e/)
//
// How to build that dist: ./l-compat-kit.ts. Without it every test here is skipped, saying so.
import type { Page } from '@playwright/test'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  type CanvasElement,
  createItem,
  createNote,
  expectSaved,
  item,
  itemCenterOnScreen,
  items,
  saveState,
  select,
  setViewport,
  updateItem,
} from '../tests/support/canvas.ts'
import { serverSnapshot, storedElement } from '../tests/support/excalidraw.ts'
import { openHistory } from '../tests/support/history.ts'
import {
  AI_API_ENV_3H,
  aiMenu,
  aiObjects,
  applyPreview,
  continueIfAsked,
  FAKE_OPENAI_PORT_3H,
  hasShell,
  openAiMenu,
  showBounds,
} from './ai-kit.ts'
import { focusBoard } from './board-kit.ts'
import {
  expectOldTabHolds,
  OLD_WEB_COMMIT,
  OLD_WEB_DIST,
  OLD_WEB_LAUNCH,
  OLD_WEB_SKIP_REASON,
  type OldTab,
  openOldTab,
} from './l-compat-kit.ts'
import { FILL, headings, makeFrame, makeNotes, sortRun, twelve, waitForSort } from './l8-kit.ts'
import { focusCanvas, grantClipboard, writeClipboard } from './navigation-kit.ts'
import { test as base, expect, post, reloadBoard, seed, type WorkshopCanvasSession } from './workshops-kit.ts'

const test = base.extend<{ oldTabs: OldTab[] }, { openai: FakeOpenAi }>({
  // the previous build's tabs of a test, closed after it (the join fixture closes this tree's)
  oldTabs: async ({ browser: _ }, use) => {
    const tabs: OldTab[] = []
    await use(tabs)
    await Promise.all(tabs.map((t) => t.context.close()))
  },
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(FAKE_OPENAI_PORT_3H)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: AI_API_ENV_3H, launchOptions: OLD_WEB_LAUNCH })
test.skip(!OLD_WEB_DIST, OLD_WEB_SKIP_REASON)
test.beforeEach(({ openai }) => openai.reset())

type Lobby = Record<string, unknown>
const present = (el: CanvasElement | null | undefined) =>
  (el?.customData?.lobby?.present ?? null) as { index?: number; skip?: boolean; mins?: number } | null
const lobbyOf = (el: CanvasElement | null | undefined): Lobby => (el?.customData?.lobby ?? {}) as Lobby
const kindOf = (el: CanvasElement | null | undefined) => lobbyOf(el).kind as string | undefined
const row = (page: Page, id: string) => page.locator(`[data-testid="frame-row"][data-frame-id="${id}"]`)
const RUN_ID = /^air_[0-9A-Za-z]{20}$/

/** One transaction (one push, one commit) that writes a frame's whole `present` and moves another element. */
async function minutesAndMove(
  page: Page,
  frameId: string,
  value: { index?: number; skip?: boolean; mins?: number },
  movedId: string,
  to: { x: number; y: number },
): Promise<void> {
  await page.evaluate(
    ({ frameId, value, movedId, to }) => {
      type Tx = { update(id: string, p: Record<string, unknown>): void }
      const b = (
        window as unknown as { __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } } }
      ).__lobbyBoard
      b.canvas.transact('e2e: minutes and a move', (tx) => {
        tx.update(frameId, { customData: { lobby: { present: value } } })
        tx.update(movedId, to)
      })
    },
    { frameId, value, movedId, to },
  )
  await expectSaved(page)
  expect((await saveState(page)).lastReject).toBeNull()
}

interface Pair {
  readonly a: WorkshopCanvasSession
  readonly old: OldTab
}

/**
 * This tree's tab (alice, the owner) and the previous build's (bob, an editor), on the test's board; checks that
 * the previous build is what runs (its own entry script, a connect URL with no revision) and that this tree's tab
 * names its revision (rev 12).
 */
async function pair(
  join: (h: string, role?: 'owner' | 'editor') => Promise<WorkshopCanvasSession>,
  browser: Parameters<typeof openOldTab>[0],
  board: string,
  users: { grant(board: string, handle: string, role: 'editor'): Promise<Parameters<typeof openOldTab>[2]> },
  oldTabs: OldTab[],
): Promise<Pair> {
  const a = await join('alice')
  const aUrls: string[] = []
  a.page.on('websocket', (ws) => aUrls.push(ws.url()))
  await reloadBoard(a)
  expect(aUrls.length).toBeGreaterThan(0)
  for (const u of aUrls) expect(new URL(u).searchParams.get('rev')).toBe('12')
  const old = await openOldTab(browser, board, await users.grant(board, 'bob', 'editor'))
  oldTabs.push(old)
  expect(old.served.some((p) => p.startsWith('/assets/index-'))).toBe(true)
  expect(old.socket.connectUrls.length).toBeGreaterThan(0)
  for (const u of old.socket.connectUrls) expect(new URL(u).searchParams.has('rev')).toBe(false)
  test.info().annotations.push({ type: 'previous web', description: `${OLD_WEB_COMMIT} (${OLD_WEB_DIST})` })
  return { a, old }
}

/**
 * The previous build's tab edits `edits` (moves, recolours) through its own canvas (its facade: its transact and
 * its sync engine); every one lands (Saved, nothing refused) and the stored `customData.lobby` of each element is
 * what it was: the rev-12 data it carries (AI provenance with the run id, kinds, minutes) is kept.
 */
async function oldTabEdits(
  p: Pair,
  stack: Parameters<typeof serverSnapshot>[0],
  board: string,
  edits: readonly { id: string; patch: Record<string, unknown> }[],
): Promise<void> {
  const before = (await serverSnapshot(stack, board)).elements
  const lobbyBefore = new Map(
    edits.map((e) => [e.id, lobbyOf(before.find((x) => x.id === e.id) as CanvasElement)]),
  )
  for (const e of edits) await updateItem(p.old.page, e.id, e.patch)
  await expectSaved(p.old.page)
  expect((await saveState(p.old.page)).lastReject).toBeNull()
  await expectOldTabHolds(stack, board, p.old, [p.a.page])
  const after = (await serverSnapshot(stack, board)).elements
  for (const e of edits) {
    const el = after.find((x) => x.id === e.id) as CanvasElement
    for (const [k, v] of Object.entries(e.patch))
      expect((el as Record<string, unknown>)[k], `${e.id}.${k}`).toEqual(v)
    expect(lobbyOf(el), `${e.id}: its customData.lobby`).toEqual(lobbyBefore.get(e.id))
  }
}

// ---- 1. W5's run of show -----------------------------------------------------------------------------------

test('L-compat 1 (W5 run of show): the minutes reach the 437b4e7 tab in every frame, after an offline window too; its Frames panel keeps them', async ({
  join,
  browser,
  board,
  users,
  stack,
  oldTabs,
}) => {
  test.setTimeout(180_000)
  const p = await pair(join, browser, board, users, oldTabs)
  const { a, old } = p
  await old.page.getByTestId('dock-tab-frames').click()
  await expect(old.page.getByTestId('frame-outline')).toBeVisible()

  await seed(a.page, {
    frames: [
      { id: 'cx-f1', x: 0, y: 0, w: 800, h: 450, name: 'Warm-up' },
      { id: 'cx-f2', x: 1000, y: 0, w: 800, h: 450, name: 'Ideas' },
      { id: 'cx-f3', x: 2000, y: 0, w: 800, h: 450, name: 'Wrap' },
    ],
    notes: [{ id: 'cx-n1', x: 60, y: 120, text: 'Coffee first' }],
  })
  await expectOldTabHolds(stack, board, old, [a.page])
  // the previous build's Frames panel has no minutes stepper (it is wave K's)
  await expect(row(old.page, 'cx-f1')).toBeVisible()
  await expect(old.page.getByTestId('frame-mins-add')).toHaveCount(0)

  await test.step('alice plans minutes with her Frames panel’s stepper and reorders: bob receives every write', async () => {
    await a.page.getByTestId('dock-tab-frames').click()
    await expect(a.page.getByTestId('frame-outline')).toBeVisible()
    await row(a.page, 'cx-f1').getByTestId('frame-mins-add').click()
    await row(a.page, 'cx-f2').getByTestId('frame-mins-add').click()
    await row(a.page, 'cx-f2').getByTestId('frame-mins-up').click()
    await expect(row(a.page, 'cx-f2').getByTestId('frame-mins')).toContainText('6 min')
    await row(a.page, 'cx-f3').getByTestId('frame-mins-add').click()
    // a reorder writes every moved frame's present whole: index and minutes together
    await a.page.getByRole('button', { name: 'Move Warm-up down' }).click()
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    await expectOldTabHolds(stack, board, old, [a.page])
    expect(present(await item(old.page, 'cx-f2'))).toMatchObject({ mins: 6 })
    expect(present(await item(old.page, 'cx-f1'))).toMatchObject({ index: 1, mins: 5 })
    // they reached it as the `c` ops of the stored frames (its schemas refuse a patch with mins)
    type WireOp = { k: string; el?: CanvasElement; c?: { present?: { mins?: number } } }
    const ops = old.socket.frames
      .filter((f) => f.startsWith('{"type":"changes"'))
      .flatMap((f) => (JSON.parse(f) as { ops: WireOp[] }).ops)
    expect(ops.some((o) => o.k === 'c' && present(o.el)?.mins === 6)).toBe(true)
    expect(ops.filter((o) => o.k === 'p' && o.c?.present?.mins !== undefined)).toEqual([])
    // the minutes and a note's move in one push (one commit, one `changes` frame), while bob is online
    await minutesAndMove(a.page, 'cx-f1', { index: 1, mins: 8 }, 'cx-n1', { x: 200, y: 200 })
    await expectOldTabHolds(stack, board, old, [a.page])
    expect(present(await item(old.page, 'cx-f1'))?.mins).toBe(8)
    expect((await item(old.page, 'cx-n1'))?.x).toBe(200)
  })

  await test.step('bob is offline while alice changes the minutes and moves a note in the same breath; back online he catches up', async () => {
    await old.cut()
    await expect.poll(async () => (await saveState(old.page)).state, { timeout: 15_000 }).toBe('offline')
    await row(a.page, 'cx-f3').getByTestId('frame-mins-up').click()
    await minutesAndMove(a.page, 'cx-f1', { index: 1, mins: 12 }, 'cx-n1', { x: 300, y: 260 })
    // bob really has not got them yet
    expect(present(await item(old.page, 'cx-f1'))?.mins).toBe(8)
    await old.restore()
    await expectOldTabHolds(stack, board, old, [a.page], 30_000)
    expect(present(await item(old.page, 'cx-f1'))?.mins).toBe(12)
    expect(present(await item(old.page, 'cx-f3'))?.mins).toBe(6)
    expect((await item(old.page, 'cx-n1'))?.x).toBe(300)
  })

  await test.step('bob reorders, skips and auto-orders in his own Frames panel: the server keeps every frame’s minutes', async () => {
    await old.page.getByRole('button', { name: 'Move Wrap up' }).click()
    await expectSaved(old.page)
    await row(old.page, 'cx-f2').getByTestId('frame-skip').click()
    await expectSaved(old.page)
    expect((await saveState(old.page)).lastReject).toBeNull()
    const mid = (await serverSnapshot(stack, board)).elements
    const minsNow = (id: string) => present(mid.find((e) => e.id === id) as CanvasElement)?.mins
    expect([minsNow('cx-f1'), minsNow('cx-f2'), minsNow('cx-f3')]).toEqual([12, 6, 6])
    expect(present(mid.find((e) => e.id === 'cx-f2') as CanvasElement)?.skip).toBe(true)
    // Auto-order writes each frame's present with no index (null when it is not skipped either)
    await old.page.getByTestId('frames-auto-order').click()
    await expectSaved(old.page)
    expect((await saveState(old.page)).lastReject).toBeNull()
    const after = (await serverSnapshot(stack, board)).elements
    const at = (id: string) => present(after.find((e) => e.id === id) as CanvasElement)
    expect(at('cx-f1')).toEqual({ mins: 12 })
    expect(at('cx-f2')).toEqual({ skip: true, mins: 6 })
    expect(at('cx-f3')).toEqual({ mins: 6 })
    await expectOldTabHolds(stack, board, old, [a.page])
    // alice's panel still plans them
    await expect(row(a.page, 'cx-f1').getByTestId('frame-mins')).toContainText('12 min')
  })

  await test.step('bob’s Ctrl+Z of the auto-order is his undo (the server’s fix folded into the step): the order is back, the minutes stay', async () => {
    await old.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
    await old.page.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(async () => present((await storedElement(stack, board, 'cx-f1')) as CanvasElement))
      .toEqual({ index: 2, mins: 12 })
    expect(present((await storedElement(stack, board, 'cx-f3')) as CanvasElement)).toEqual({
      index: 1,
      mins: 6,
    })
    expect(present((await storedElement(stack, board, 'cx-f2')) as CanvasElement)).toEqual({
      index: 0,
      skip: true,
      mins: 6,
    })
    await expectSaved(old.page)
    expect((await saveState(old.page)).lastReject).toBeNull()
    await expectOldTabHolds(stack, board, old, [a.page])
    expect(lobbyOf(await item(a.page, 'cx-f3')).present).toEqual({ index: 1, mins: 6 })
  })
})

// ---- 2. AI on the board (W2, W1; W4's diagram, W8's sort by a lens and 2x2) ------------------------------------

/** W2's privacy notice, when this person has not agreed yet, then W2's preview: Apply. */
async function continueThenApply(page: Page) {
  const notice = page.getByTestId('ai-notice-continue')
  const panel = page.getByTestId('ai-preview-panel')
  await expect(notice.or(panel).first()).toBeVisible({ timeout: 20_000 })
  if (await notice.isVisible()) await notice.click()
  await applyPreview(page)
}

/** Right-click on empty canvas → AI › Wrap up this session, then Add as Recap frame. */
async function recapFrame(page: Page): Promise<CanvasElement> {
  expect(await hasShell(page, 'contextMenu')).toBe(true)
  // nothing selected, and an empty part of the board in view: the canvas's own context menu
  await select(page, [])
  await setViewport(page, { x: 30_000, y: 30_000, zoom: 1 })
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no canvas')
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5, { button: 'right' })
  await page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Wrap up this session' }).click()
  const cont = page.getByTestId('ai-notice-continue')
  const done = page.locator('[data-testid="recap-panel"][data-status="done"]')
  await expect(cont.or(done).first()).toBeVisible({ timeout: 20_000 })
  if (await cont.isVisible()) await cont.click()
  await expect(done).toBeVisible({ timeout: 20_000 })
  await done.getByTestId('recap-add').click()
  await expectSaved(page)
  expect((await saveState(page)).lastReject).toBeNull()
  let frame: CanvasElement | undefined
  await expect
    .poll(async () => {
      frame = (await items(page)).find((e) => e.type === 'frame' && String(e.name).startsWith('Recap · '))
      return !!frame
    })
    .toBe(true)
  await page.getByTestId('recap-panel').getByRole('button', { name: 'Close recap' }).click()
  return frame as CanvasElement
}

/** Diagram from words, from a note's context menu, with the fake's `nodes` and `edges`. */
async function diagramFromWords(page: Page, openai: FakeOpenAi, note: string, n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    id: `s${i + 1}`,
    label: `Step ${i + 1}`,
    kind: (['process', 'decision', 'terminal', 'io'] as const)[i % 4],
  }))
  const edges = Array.from({ length: n - 1 }, (_, i) => ({
    from: `s${i + 1}`,
    to: `s${i + 2}`,
    label: i % 3 ? '' : 'next',
  }))
  openai.next({ kind: 'content', content: { nodes, edges } })
  // the note in view (the step before may have looked elsewhere)
  const el = await item(page, note)
  if (!el) throw new Error(`no ${note}`)
  await setViewport(page, { x: el.x - 300, y: el.y - 200, zoom: 1 })
  await focusBoard(page)
  await select(page, [note])
  const at = await itemCenterOnScreen(page, note)
  await page.mouse.click(at.x, at.y, { button: 'right' })
  await page.getByRole('menuitem', { name: /Diagram from words/ }).click()
  await page.getByTestId('diagram-prompt-text').fill('Brief, concept, review, ship')
  await page.getByTestId('diagram-prompt-create').click()
  await continueIfAsked(page)
  // over 20 elements W2's shared preview comes first
  const apply = page.getByTestId('ai-preview-apply')
  const shapes = async () => (await items(page)).filter((e) => kindOf(e) === 'ai-diagram-node').length
  await expect
    .poll(
      async () => {
        if (await apply.isVisible().catch(() => false)) await apply.click().catch(() => {})
        return shapes()
      },
      { timeout: 30_000 },
    )
    .toBe(n)
  await expectSaved(page)
  expect((await saveState(page)).lastReject).toBeNull()
}

test('L-compat 2 (AI on the board): AI notes with run ids, the Recap frame, a diagram from words, sort by a lens and Place with AI reach the 437b4e7 tab; its edits keep the provenance', async ({
  join,
  browser,
  board,
  users,
  stack,
  openai,
  oldTabs,
}) => {
  test.setTimeout(300_000)
  const p = await pair(join, browser, board, users, oldTabs)
  const { a, old } = p
  await waitForSort(a.page)

  await test.step('W2: AI › Action items on three notes: the AI-made notes (and their heading) carry the run id; bob holds them', async () => {
    const ids: string[] = []
    for (const [i, text] of ['Book the venue', 'Draft the brief', 'Call the studio'].entries()) {
      ids.push(await createNote(a.page, { x: i * 260, y: 0, text }))
      await expectSaved(a.page)
    }
    await showBounds(a.page, { x: -40, y: -40, w: 860, h: 300 })
    await select(a.page, ids)
    await openAiMenu(a.page)
    await aiMenu(a.page).getByTestId('ai-actions').click()
    await continueIfAsked(a.page)
    await expect(a.page.getByTestId('ai-done')).toContainText('Added 3 action items.', { timeout: 20_000 })
    await expectSaved(a.page)
    const made = await aiObjects(a.page)
    expect(made.filter((o) => o.kind === 'action-item')).toHaveLength(3)
    for (const o of made)
      expect((lobbyOf(await item(a.page, o.id)).ai as { run?: string }).run).toMatch(RUN_ID)
    await expectOldTabHolds(stack, board, old, [a.page])
    expect((await aiObjects(old.page)).map((o) => o.id).sort()).toEqual(made.map((o) => o.id).sort())
  })

  await test.step('W2: Wrap up, Add as Recap frame: bob holds the frame and its parts', async () => {
    const frame = await recapFrame(a.page)
    await expectOldTabHolds(stack, board, old, [a.page])
    expect(await item(old.page, frame.id)).toBeTruthy()
  })

  await test.step('W4 with W1: Diagram from words (24 nodes, past the preview): bob holds every node and connector', async () => {
    const note = await createNote(a.page, { x: 0, y: 2600, text: 'Brief, concept, review, ship' })
    await expectSaved(a.page)
    await diagramFromWords(a.page, openai, note, 24)
    await expectOldTabHolds(stack, board, old, [a.page])
  })

  await test.step('W8 with W1: sort by a lens (headings with the run id) and Place with AI on a new 2x2: bob holds both', async () => {
    await setViewport(a.page, { x: 5900, y: -100, zoom: 0.5 })
    const frame = await makeFrame(a.page, 6000, 0, 2400, 1100, 'Journey')
    const ids = await makeNotes(a.page, twelve(6060, 120), frame)
    await select(a.page, ids)
    const sorted = sortRun(a.page, 'sort.lens', { lens: 'journey stage' })
    await continueThenApply(a.page)
    expect(await sorted).toBe(true)
    await expect.poll(async () => (await headings(a.page)).length).toBe(2)
    for (const h of await headings(a.page)) expect((lobbyOf(h).ai as { run?: string }).run).toMatch(RUN_ID)
    await expectSaved(a.page)
    await expectOldTabHolds(stack, board, old, [a.page])
    await select(a.page, ids)
    const placed = sortRun(a.page, 'sort.place', {
      axes: [
        { name: 'Effort', low: 'Low effort', high: 'High effort' },
        { name: 'Impact', low: 'Low impact', high: 'High impact' },
      ],
    })
    await continueThenApply(a.page)
    expect(await placed).toBe(true)
    await expect.poll(async () => (await items(a.page)).some((e) => kindOf(e) === 'sort-matrix')).toBe(true)
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    await expectOldTabHolds(stack, board, old, [a.page])
  })

  await test.step('bob moves and recolours what AI made: every element keeps its provenance, run id and kind', async () => {
    const all = await items(old.page)
    const pick = (kind: string) => {
      const el = all.find((e) => kindOf(e) === kind && !(e.type === 'text' && e.containerId))
      if (!el) throw new Error(`no ${kind} on bob's board`)
      return el
    }
    const note = pick('ai-action-item')
    const node = pick('ai-diagram-node')
    const heading = pick('ai-sort-label')
    const matrix = pick('sort-matrix')
    await oldTabEdits(p, stack, board, [
      { id: note.id, patch: { x: note.x + 40, y: note.y + 30 } },
      { id: node.id, patch: { backgroundColor: '#ffc9c9' } },
      { id: heading.id, patch: { x: heading.x + 25 } },
      { id: matrix.id, patch: { name: 'Effort and impact' } },
    ])
    for (const id of [note.id, node.id, heading.id])
      expect((lobbyOf(await storedElement(stack, board, id)).ai as { run?: string }).run).toMatch(RUN_ID)
  })

  await test.step('bob is offline while alice runs AI again (action items); back online he holds the new run', async () => {
    await old.cut()
    await expect.poll(async () => (await saveState(old.page)).state, { timeout: 15_000 }).toBe('offline')
    const ids: string[] = []
    for (const [i, text] of ['Pick the date', 'Order the props'].entries()) {
      ids.push(await createNote(a.page, { x: i * 260, y: 4400, text }))
      await expectSaved(a.page)
    }
    await showBounds(a.page, { x: -40, y: 4360, w: 600, h: 300 })
    await select(a.page, ids)
    await openAiMenu(a.page)
    await aiMenu(a.page).getByTestId('ai-actions').click()
    await continueIfAsked(a.page)
    await expect(a.page.getByTestId('ai-done')).toContainText('action items', { timeout: 20_000 })
    await expectSaved(a.page)
    await old.restore()
    await expectOldTabHolds(stack, board, old, [a.page], 30_000)
  })
})

// ---- 3. builders without AI (W4's Mermaid paste and next shape, W8's sort headings and pieces) -------------------

/** A small Mermaid flowchart: 8 nodes of mixed kinds, labelled and plain links. */
const CHART = [
  'flowchart TD',
  '  A[Brief] --> B{Approved?}',
  '  B -->|yes| C((Shoot))',
  '  B -->|no| D[/Rework/]',
  '  D --> A',
  '  C --> E[Edit]',
  '  E --> F[Grade]',
  '  F --> G[Mix]',
  '  G --> H[Deliver]',
].join('\n')

test('L-compat 3 (no AI): a pasted Mermaid chart, the flow’s next shape, sort headings and pieces reach the 437b4e7 tab; its edits keep their kinds', async ({
  join,
  browser,
  board,
  users,
  stack,
  oldTabs,
}) => {
  test.setTimeout(240_000)
  const p = await pair(join, browser, board, users, oldTabs)
  const { a, old } = p
  await grantClipboard(a.context)
  await waitForSort(a.page)

  await test.step('W4: Mermaid paste as a diagram: bob holds every shape, connector and label', async () => {
    await setViewport(a.page, { x: -200, y: -200, zoom: 0.6 })
    await writeClipboard(a.page, { 'text/plain': CHART })
    await focusBoard(a.page)
    await a.page.keyboard.press('ControlOrMeta+v')
    await expect(a.page.getByTestId('mermaid-paste-prompt')).toBeVisible()
    await a.page.getByTestId('mermaid-paste-diagram').click()
    await expect.poll(async () => (await items(a.page)).filter((e) => e.type === 'arrow').length).toBe(8)
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    await expectOldTabHolds(stack, board, old, [a.page])
  })

  await test.step('W4: Ctrl+Right makes the next connected shape (the connector the room’s): bob holds both', async () => {
    const src = await createItem(a.page, 'rectangle', { x: 0, y: 3000, width: 160, height: 80 })
    await expectSaved(a.page)
    await setViewport(a.page, { x: -100, y: 2800, zoom: 1 })
    await select(a.page, [src])
    await focusCanvas(a.page)
    await a.page.keyboard.press('ControlOrMeta+ArrowRight')
    await expect
      .poll(async () =>
        (await items(a.page)).some(
          (e) =>
            e.type === 'arrow' &&
            (e as { startBinding?: { elementId?: string } }).startBinding?.elementId === src,
        ),
      )
      .toBe(true)
    await a.page.keyboard.press('Escape')
    await expectSaved(a.page)
    await expectOldTabHolds(stack, board, old, [a.page])
  })

  await test.step('W8: sort by colour into labelled columns: bob holds the headings and the moves', async () => {
    const frame = await makeFrame(a.page, 0, 5000, 2000, 900, 'Colours')
    const ids = await makeNotes(
      a.page,
      [
        { x: 60, y: 5120, text: 'one', fill: FILL.sky },
        { x: 300, y: 5120, text: 'two', fill: FILL.butter },
        { x: 540, y: 5120, text: 'three', fill: FILL.sky },
      ],
      frame,
    )
    await select(a.page, ids)
    expect(await sortRun(a.page, 'sort.colour')).toBe(true)
    await expect.poll(async () => (await headings(a.page)).length).toBe(2)
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    await expectOldTabHolds(stack, board, old, [a.page])
  })

  await test.step('W8: pieces from the Pieces panel (Decision, a button, a persona): bob holds every element', async () => {
    await setViewport(a.page, { x: 3000, y: 5000, zoom: 1 })
    await a.page.getByTestId('dock-tab-pieces').click()
    await expect(a.page.getByTestId('pieces-panel')).toBeVisible()
    for (const word of ['dec', 'button', 'persona']) {
      const count = (await items(a.page)).filter((e) => (kindOf(e) ?? '').startsWith('piece-')).length
      await a.page.getByTestId('piece-search').fill(word)
      await a.page.getByTestId('piece-search').press('Enter')
      await expect
        .poll(async () => (await items(a.page)).filter((e) => (kindOf(e) ?? '').startsWith('piece-')).length)
        .toBeGreaterThan(count)
      await expectSaved(a.page)
    }
    expect((await saveState(a.page)).lastReject).toBeNull()
    await expectOldTabHolds(stack, board, old, [a.page])
  })

  await test.step('bob moves a piece, a sort heading and a flow shape: every kind stays, the connectors are re-snapped by the room', async () => {
    const all = await items(old.page)
    const piece =
      all.find(
        (e) =>
          (kindOf(e) ?? '').startsWith('piece-') &&
          !(e.type === 'text' && e.containerId) &&
          !e.groupIds?.length,
      ) ?? all.find((e) => (kindOf(e) ?? '').startsWith('piece-') && e.type !== 'text')
    const heading = all.find((e) => kindOf(e) === 'sort-label')
    const shape = all.find((e) => e.type === 'diamond' && !kindOf(e))
    if (!piece || !heading || !shape) throw new Error('bob is missing what he edits')
    await oldTabEdits(p, stack, board, [
      { id: piece.id, patch: { backgroundColor: '#d0bfff' } },
      { id: heading.id, patch: { x: heading.x + 30 } },
      { id: shape.id, patch: { x: shape.x + 60, y: shape.y + 20 } },
    ])
  })

  await test.step('bob is offline while alice adds a piece and the next shape; back online he holds them', async () => {
    await old.cut()
    await expect.poll(async () => (await saveState(old.page)).state, { timeout: 15_000 }).toBe('offline')
    await a.page.getByTestId('piece-search').fill('stage')
    await a.page.getByTestId('piece-search').press('Enter')
    await expect.poll(async () => (await items(a.page)).some((e) => kindOf(e) === 'piece-stage')).toBe(true)
    await expectSaved(a.page)
    await old.restore()
    await expectOldTabHolds(stack, board, old, [a.page], 30_000)
  })
})

// ---- 4. W7's restore and W5's vote results to the board ------------------------------------------------------------

test('L-compat 4 (restore, vote results): a restore of frames with minutes and the vote’s chart and winners reach the 437b4e7 tab; its edits keep them', async ({
  join,
  browser,
  board,
  users,
  stack,
  oldTabs,
}) => {
  test.setTimeout(240_000)
  const p = await pair(join, browser, board, users, oldTabs)
  const { a, old } = p
  const api = await users.api('alice')
  await seed(a.page, {
    frames: [{ id: 'rx-f1', x: 0, y: 0, w: 1200, h: 600, name: 'Kick-off' }],
    notes: [
      { id: 'rx-n1', x: 60, y: 120, text: 'Idea A' },
      { id: 'rx-n2', x: 320, y: 120, text: 'Idea B' },
      { id: 'rx-n3', x: 580, y: 120, text: 'Idea C' },
    ],
  })
  await minutesAndMove(a.page, 'rx-f1', { index: 0, mins: 15 }, 'rx-n3', { x: 600, y: 140 })
  await expectOldTabHolds(stack, board, old, [a.page])

  await test.step('W7: a checkpoint, the board changed (minutes, a note deleted and one moved), Restore these: bob holds the restored board', async () => {
    const res = await api.fetch('POST', `/api/boards/${board}/snapshots`, { name: 'Before the changes' })
    expect(res.status(), await res.text()).toBe(201)
    await minutesAndMove(a.page, 'rx-f1', { index: 0, mins: 40 }, 'rx-n2', { x: 900, y: 900 })
    await a.page.evaluate(() => {
      type Tx = { delete(id: string): void }
      const b = (
        window as unknown as { __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } } }
      ).__lobbyBoard
      b.canvas.transact('e2e: delete', (tx) => tx.delete('rx-n1'))
    })
    await expectSaved(a.page)
    await expectOldTabHolds(stack, board, old, [a.page])
    await openHistory(a.page)
    await a.page.getByTestId('history-time-travel').click()
    const d = a.page.getByTestId('checkpoint-preview-dialog')
    await expect(d).toBeVisible()
    await expect(d).toContainText('Before the changes')
    await d.getByTestId('history-select-changes').click()
    await d.getByTestId('history-restore-elements').click()
    await expect(a.page.getByTestId('history-restored-notice')).toContainText('for everyone')
    await expect
      .poll(async () => present((await storedElement(stack, board, 'rx-f1')) as CanvasElement)?.mins)
      .toBe(15)
    await expectOldTabHolds(stack, board, old, [a.page])
    expect(present(await item(old.page, 'rx-f1'))?.mins).toBe(15)
    expect(await item(old.page, 'rx-n1')).toBeTruthy()
    expect((await item(old.page, 'rx-n2'))?.x).toBe(320)
  })

  await test.step('W5: a vote cast by both and revealed, Results to board and Gather the winners: bob holds the chart and the winners', async () => {
    const r = await post(a, `/api/boards/${board}/votes`, {
      title: 'Pick one',
      votesPerPerson: 3,
      onePerObject: false,
      scope: 'board',
    })
    expect(r.status(), await r.text()).toBe(201)
    const sid = ((await r.json()) as { session: { id: string } }).session.id
    const bobApi = await users.api('bob')
    for (const [who, id] of [
      [api, 'rx-n1'],
      [api, 'rx-n1'],
      [api, 'rx-n2'],
      [bobApi, 'rx-n1'],
      [bobApi, 'rx-n3'],
    ] as const) {
      const c = await who.fetch('POST', `/api/votes/${sid}/cast`, { shapeId: `shape:${id}`, delta: 1 })
      expect(c.status(), await c.text()).toBe(200)
    }
    await a.page.getByTestId('dock-tab-voting').click()
    await expect(a.page.getByTestId('vote-reveal')).toBeVisible()
    await a.page.getByTestId('vote-reveal').click()
    await expect(a.page.getByTestId('vote-chart')).toBeVisible({ timeout: 8_000 })
    await a.page.getByTestId('vote-results-to-board').click()
    await expect
      .poll(async () => (await items(a.page)).filter((e) => kindOf(e) === 'vote-chart').length, {
        timeout: 8_000,
      })
      .toBeGreaterThan(3)
    await expectSaved(a.page)
    await a.page.getByTestId('vote-gather').click()
    await expect.poll(async () => (await items(a.page)).some((e) => kindOf(e) === 'vote-winners')).toBe(true)
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    await expectOldTabHolds(stack, board, old, [a.page])
  })

  await test.step('bob moves the chart frame and renames the restored frame: kinds and minutes stay', async () => {
    const chart = (await items(old.page)).find((e) => e.type === 'frame' && kindOf(e) === 'vote-chart')
    if (!chart) throw new Error('no chart frame at bob')
    await oldTabEdits(p, stack, board, [
      { id: chart.id, patch: { x: chart.x + 50 } },
      { id: 'rx-f1', patch: { name: 'Kick-off (done)' } },
    ])
    expect(present((await storedElement(stack, board, 'rx-f1')) as CanvasElement)?.mins).toBe(15)
  })
})
