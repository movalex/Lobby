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
//    the planned minutes, its moves and recolours keep the AI provenance (with the run id) and the kinds;
//  - and what it queued offline keeps them too when this tree's web takes the queue over after the tab closes
//    (L-compat 1b: that web sends it on a rev-12 socket, so its engine completes the old page's values first).
// Before the per-reader rule its socket dropped every `changes` frame with a `present.mins` (and every op
// committed with it) while showing Saved, and its reorder erased the minutes.
//
//   E2E_OLD_WEB_DIST=<the 437b4e7 web's dist> E2E_PORT_BASE=<base> \
//     pnpm exec playwright test excalidraw/l-compat-rev11.spec.ts --project=chromium --workers=1   (from e2e/)
//
// How to build that dist: ./l-compat-kit.ts. Without it every test here is skipped, saying so.
import type { Page } from '@playwright/test'
import { attachRelay, cut } from '../spike-b/support/relay.ts'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  type CanvasElement,
  canvasCall,
  createItem,
  createNote,
  expectSaved,
  setViewport as facadeSetViewport,
  hash,
  item,
  itemCenterOnScreen,
  items,
  saveState,
  select,
  updateItem,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { serverSnapshot, storedElement } from '../tests/support/excalidraw.ts'
import { openHistory } from '../tests/support/history.ts'
import { WEB_URL } from '../tests/support/ports.ts'
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
import { cameraIdle, focusCanvas, grantClipboard, writeClipboard } from './navigation-kit.ts'
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

/**
 * Every camera move here, once the camera is still. The facade's set does not stop a camera animation that is still
 * running (a paste's or an AI result's bring-into-view, 320 ms; ./ai-kit.ts showBounds), and the rounds of
 * liveThenCaughtUp follow each other within that: its next frame took the camera back to what the last round made,
 * and the click meant for empty canvas selected a shape of it (W4's second Mermaid paste then went nowhere: the
 * shape's selection bar lay under the pointer, where Excalidraw takes no paste).
 */
async function setViewport(page: Page, v: { x: number; y: number; zoom: number }): Promise<void> {
  await cameraIdle(page)
  await facadeSetViewport(page, v)
}

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

/** The `c:` groups of every offline queue entry this page's origin holds for `board` (IndexedDB lobby-offline). */
async function queuedGroups(page: Page, board: string): Promise<Record<string, string[]>> {
  return page.evaluate(
    (board) =>
      new Promise<Record<string, string[]>>((resolve, reject) => {
        const req = indexedDB.open('lobby-offline', 1)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const all = req.result.transaction('queues', 'readonly').objectStore('queues').getAll()
          all.onerror = () => reject(all.error)
          all.onsuccess = () => {
            const out: Record<string, string[]> = {}
            type Rec = {
              boardId: string
              entries: { element: { id: string }; groups: string[]; rev?: number }[]
            }
            // and the record's form: this web's (`q2:<board>`, offline-idb.ts queueBoard) or the rev-11 web's
            for (const r of all.result as Rec[])
              if (r.boardId === board || r.boardId === `q2:${board}`)
                for (const e of r.entries)
                  out[e.element.id] = [
                    ...e.groups,
                    `rev:${e.rev ?? 'none'}`,
                    `form:${r.boardId === board ? 'rev11' : 'q2'}`,
                  ]
            resolve(out)
          }
        }
      }),
    board,
  )
}

test('L-compat 1b (the offline queue across the deploy): a reorder the 437b4e7 tab queued offline, taken over by this web, keeps the minutes', async ({
  join,
  browser,
  board,
  users,
  stack,
  oldTabs,
}) => {
  // Wave L compat refix, round 1: the room keeps the minutes for a rev-11 SOCKET's write, but a queue the 437b4e7
  // page left in IndexedDB is taken over by this tree's web after a reload (or by its next tab of the board) and
  // sent on a socket that names rev 12, which the room writes whole. Before the fix the reorder erased them.
  test.setTimeout(180_000)
  const p = await pair(join, browser, board, users, oldTabs)
  const { a, old } = p
  await seed(a.page, {
    frames: [
      { id: 'cq-f1', x: 0, y: 0, w: 800, h: 450, name: 'Warm-up' },
      { id: 'cq-f2', x: 1000, y: 0, w: 800, h: 450, name: 'Ideas' },
      { id: 'cq-f3', x: 2000, y: 0, w: 800, h: 450, name: 'Wrap' },
    ],
  })
  await a.page.getByTestId('dock-tab-frames').click()
  await expect(a.page.getByTestId('frame-outline')).toBeVisible()
  for (const id of ['cq-f1', 'cq-f2', 'cq-f3']) await row(a.page, id).getByTestId('frame-mins-add').click()
  await row(a.page, 'cq-f2').getByTestId('frame-mins-up').click()
  await expect(row(a.page, 'cq-f2').getByTestId('frame-mins')).toContainText('6 min')
  await a.page.getByRole('button', { name: 'Move Warm-up down' }).click()
  await expectSaved(a.page)
  await expectOldTabHolds(stack, board, old, [a.page])
  const stored = async (id: string) => present((await storedElement(stack, board, id)) as CanvasElement)
  expect(await stored('cq-f1')).toEqual({ index: 1, mins: 5 })
  expect(await stored('cq-f3')).toEqual({ index: 2, mins: 5 })

  await test.step('bob is offline and reorders in his Frames panel: the 437b4e7 page queues each moved frame’s present whole', async () => {
    await old.page.getByTestId('dock-tab-frames').click()
    await expect(row(old.page, 'cq-f3')).toBeVisible()
    await old.cut()
    await expect.poll(async () => (await saveState(old.page)).state, { timeout: 15_000 }).toBe('offline')
    await old.page.getByRole('button', { name: 'Move Wrap up' }).click()
    // its queue, as 437b4e7 writes it: the moved frames' `c:present`, and no writer revision
    await expect
      .poll(async () => (await queuedGroups(old.page, board))['cq-f3'] ?? [], { timeout: 10_000 })
      .toEqual(['c:present', 'rev:none', 'form:rev11'])
    expect((await queuedGroups(old.page, board))['cq-f1']).toEqual(['c:present', 'rev:none', 'form:rev11'])
    expect(await stored('cq-f3')).toEqual({ index: 2, mins: 5 })
  })

  await test.step('bob closes it and opens the board again, now on this web: it takes the queue over and sends it on a rev-12 socket; the minutes stay', async () => {
    await old.page.close()
    // from here the context gets this tree's web (the preview server), on the same origin, IndexedDB and sign-in
    await old.context.unrouteAll({ behavior: 'ignoreErrors' })
    await old.restore()
    const next = await old.context.newPage()
    const urls: string[] = []
    next.on('websocket', (ws) => urls.push(ws.url()))
    await next.goto(`/b/${board}`)
    await waitForCanvas(next)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(new URL(u).searchParams.get('rev')).toBe('12')
    await expect.poll(async () => (await stored('cq-f3'))?.index, { timeout: 20_000 }).toBe(1)
    await expectSaved(next)
    expect((await saveState(next)).lastReject).toBeNull()
    expect(await stored('cq-f3')).toEqual({ index: 1, mins: 5 })
    expect(await stored('cq-f1')).toEqual({ index: 2, mins: 5 })
    expect(await stored('cq-f2')).toEqual({ index: 0, mins: 6 })
    // every tab holds the server's board, and alice's panel still plans them
    await expect
      .poll(async () => {
        const want = (await serverSnapshot(stack, board)).hash
        return [await hash(next), await hash(a.page)].filter((h) => h !== want).length
      })
      .toBe(0)
    await expect(row(a.page, 'cq-f3').getByTestId('frame-mins')).toContainText('5 min')
    expect(await queuedGroups(next, board)).toEqual({})
  })
})

/** A page of the previous build's context that gets this tree's web (the preview server), the context's routes passed by. */
async function thisWebPage(context: OldTab['context']): Promise<Page> {
  const page = await context.newPage()
  const origin = new URL(WEB_URL).origin
  // a page's route comes before the context's; `continue` sends the request to the network, not to that route
  await page.route(
    (url) => url.origin === origin && !/^\/(?:api|files|connect)(?:\/|$)/.test(url.pathname),
    (r) => r.continue(),
  )
  return page
}

test('L-compat 1c (the offline queue across the deploy, the other way): a removal of the minutes this web queued offline is not taken over by a 437b4e7 page; this web sends it', async ({
  join,
  browser,
  board,
  users,
  stack,
  oldTabs,
}) => {
  // Wave L compat refix, round 2: bob has a 437b4e7 tab and a tab of this web. The 437b4e7 store adopted every
  // free-lock queue of the board and user (whatever its revision) and sent it on a socket that names no revision,
  // so the room kept the stored minutes: his removal of them, queued offline in this web, was undone. This web's
  // queue records are now in a form that store never matches.
  test.setTimeout(180_000)
  const { a, old } = await pair(join, browser, board, users, oldTabs)
  await seed(a.page, {
    frames: [
      { id: 'cr-f1', x: 0, y: 0, w: 800, h: 450, name: 'Warm-up' },
      { id: 'cr-f2', x: 1000, y: 0, w: 800, h: 450, name: 'Ideas' },
    ],
  })
  await a.page.getByTestId('dock-tab-frames').click()
  await expect(a.page.getByTestId('frame-outline')).toBeVisible()
  await row(a.page, 'cr-f1').getByTestId('frame-mins-add').click()
  await a.page.getByRole('button', { name: 'Move Warm-up down' }).click()
  await expectSaved(a.page)
  await expectOldTabHolds(stack, board, old, [a.page])
  const stored = async (id: string) => present((await storedElement(stack, board, id)) as CanvasElement)
  expect(await stored('cr-f1')).toEqual({ index: 1, mins: 5 })

  await test.step('bob, in a tab of this web, is offline and lowers Warm-up to No time planned; he closes the tab', async () => {
    const t2 = await thisWebPage(old.context)
    const urls: string[] = []
    t2.on('websocket', (ws) => urls.push(ws.url()))
    await attachRelay(t2)
    await t2.goto(`/b/${board}`)
    await waitForCanvas(t2)
    await expectSaved(t2)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(new URL(u).searchParams.get('rev')).toBe('12')
    await t2.getByTestId('dock-tab-frames').click()
    await expect(row(t2, 'cr-f1').getByTestId('frame-mins')).toContainText('5 min')
    await cut(t2, { mode: 'hold' })
    await expect.poll(async () => (await saveState(t2)).state, { timeout: 15_000 }).toBe('offline')
    for (let i = 0; i < 10 && !(await row(t2, 'cr-f1').getByTestId('frame-mins-add').isVisible()); i++)
      await row(t2, 'cr-f1').getByTestId('frame-mins-down').click()
    await expect(row(t2, 'cr-f1').getByTestId('frame-mins-add')).toBeVisible()
    // queued with this web's revision, in this web's form
    await expect
      .poll(async () => (await queuedGroups(t2, board))['cr-f1'] ?? [], { timeout: 10_000 })
      .toEqual(['c:present', 'rev:12', 'form:q2'])
    await t2.close()
    expect(await stored('cr-f1')).toEqual({ index: 1, mins: 5 })
  })

  await test.step('he opens the board in a 437b4e7 tab: it takes nothing of that queue, which waits', async () => {
    const t1 = await old.context.newPage()
    const urls: string[] = []
    t1.on('websocket', (ws) => urls.push(ws.url()))
    await t1.goto(`/b/${board}`)
    await waitForCanvas(t1)
    await expect.poll(async () => (await canvasCall(t1, 'me'))?.uid).toBe(old.id)
    await expectSaved(t1)
    expect(urls.length).toBeGreaterThan(0)
    for (const u of urls) expect(new URL(u).searchParams.has('rev')).toBe(false)
    // before the fix it adopted the queue, sent {index: 1} on its rev-11 socket (the room kept the minutes) and
    // cleared the record: the removal was gone for good, with Saved showing
    await t1.waitForTimeout(1_000)
    expect(await queuedGroups(t1, board)).toEqual({ 'cr-f1': ['c:present', 'rev:12', 'form:q2'] })
    expect(await stored('cr-f1')).toEqual({ index: 1, mins: 5 })
    await t1.close()
  })

  await test.step('he opens the board on this web again: it takes its queue over and the minutes are cleared', async () => {
    const t3 = await thisWebPage(old.context)
    await t3.goto(`/b/${board}`)
    await waitForCanvas(t3)
    await expect.poll(async () => await stored('cr-f1'), { timeout: 20_000 }).toEqual({ index: 1 })
    await expectSaved(t3)
    expect((await saveState(t3)).lastReject).toBeNull()
    expect(await queuedGroups(t3, board)).toEqual({})
    await expect(row(a.page, 'cr-f1').getByTestId('frame-mins-add')).toBeVisible()
    await expectOldTabHolds(stack, board, old, [a.page, t3])
  })
})

/**
 * Runs `write` twice: with bob online (its frames reach him live), then with his board socket cut and its
 * reconnects held (they reach him in his catch-up once he is back). After each, bob holds the server's board and
 * his socket dropped no frame.
 */
async function liveThenCaughtUp(
  p: Pair,
  stack: Parameters<typeof serverSnapshot>[0],
  board: string,
  write: (round: 0 | 1) => Promise<void>,
): Promise<void> {
  await write(0)
  await expectOldTabHolds(stack, board, p.old, [p.a.page])
  await p.old.cut()
  await expect.poll(async () => (await saveState(p.old.page)).state, { timeout: 15_000 }).toBe('offline')
  await write(1)
  await p.old.restore()
  await expectOldTabHolds(stack, board, p.old, [p.a.page], 30_000)
}

// ---- 2. AI on the board (W2, W1; W4's diagram, W8's sort by a lens and 2x2) ------------------------------------

/** W2's privacy notice, when this person has not agreed yet, then W2's preview: Apply. */
async function continueThenApply(page: Page) {
  const notice = page.getByTestId('ai-notice-continue')
  const panel = page.getByTestId('ai-preview-panel')
  await expect(notice.or(panel).first()).toBeVisible({ timeout: 20_000 })
  if (await notice.isVisible()) await notice.click()
  await applyPreview(page)
}

/** AI › Action items on new notes with these words at y: the AI-made notes and heading, with the run id. */
async function actionItems(page: Page, words: readonly string[], y: number) {
  const ids: string[] = []
  for (const [i, text] of words.entries()) {
    ids.push(await createNote(page, { x: i * 260, y, text }))
    await expectSaved(page)
  }
  const before = new Set((await aiObjects(page)).map((o) => o.id))
  await showBounds(page, { x: -40, y: y - 40, w: 260 * words.length + 100, h: 300 })
  await select(page, ids)
  await openAiMenu(page)
  await aiMenu(page).getByTestId('ai-actions').click()
  await continueIfAsked(page)
  await expect(page.getByTestId('ai-done')).toContainText('action items', { timeout: 20_000 })
  await expectSaved(page)
  expect((await saveState(page)).lastReject).toBeNull()
  const made = (await aiObjects(page)).filter((o) => !before.has(o.id))
  expect(made.filter((o) => o.kind === 'action-item').length).toBeGreaterThan(0)
  for (const o of made) expect((lobbyOf(await item(page, o.id)).ai as { run?: string }).run).toMatch(RUN_ID)
}

/** Right-click on empty canvas at `at` → AI › Wrap up this session, then Add as Recap frame. */
async function recapFrame(page: Page, at: { x: number; y: number }): Promise<void> {
  expect(await hasShell(page, 'contextMenu')).toBe(true)
  const before = (await items(page)).filter(
    (e) => e.type === 'frame' && String(e.name).startsWith('Recap · '),
  )
  // nothing selected, and an empty part of the board in view: the canvas's own context menu
  await select(page, [])
  await setViewport(page, { ...at, zoom: 1 })
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
  await expect
    .poll(
      async () =>
        (await items(page)).filter((e) => e.type === 'frame' && String(e.name).startsWith('Recap · ')).length,
    )
    .toBe(before.length + 1)
  await page.getByTestId('recap-panel').getByRole('button', { name: 'Close recap' }).click()
}

/** Diagram from words from a new note at (0, y), with the fake's `n` nodes and their edges (over 20: a preview). */
async function diagramFromWords(page: Page, openai: FakeOpenAi, y: number, n: number) {
  const note = await createNote(page, { x: 0, y, text: 'Brief, concept, review, ship' })
  await expectSaved(page)
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
  const before = (await items(page)).filter((e) => kindOf(e) === 'ai-diagram-node').length
  await setViewport(page, { x: -300, y: y - 200, zoom: 1 })
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
  await expect
    .poll(
      async () => {
        if (await apply.isVisible().catch(() => false)) await apply.click().catch(() => {})
        return (await items(page)).filter((e) => kindOf(e) === 'ai-diagram-node').length
      },
      { timeout: 30_000 },
    )
    .toBe(before + n)
  await expectSaved(page)
  expect((await saveState(page)).lastReject).toBeNull()
}

/** Twelve notes in a frame at (x, 0), sorted by a lens (two headings with the run id), then placed on a new 2x2. */
async function lensAndPlace(page: Page, x: number) {
  await setViewport(page, { x: x - 100, y: -100, zoom: 0.5 })
  const frame = await makeFrame(page, x, 0, 2400, 1100, `Journey ${x}`)
  const ids = await makeNotes(page, twelve(x + 60, 120), frame)
  const heads = (await headings(page)).length
  await select(page, ids)
  const sorted = sortRun(page, 'sort.lens', { lens: 'journey stage' })
  await continueThenApply(page)
  expect(await sorted).toBe(true)
  await expect.poll(async () => (await headings(page)).length).toBe(heads + 2)
  for (const h of await headings(page)) expect((lobbyOf(h).ai as { run?: string }).run).toMatch(RUN_ID)
  await expectSaved(page)
  const matrices = (await items(page)).filter((e) => e.type === 'frame' && kindOf(e) === 'sort-matrix').length
  await select(page, ids)
  const placed = sortRun(page, 'sort.place', {
    axes: [
      { name: 'Effort', low: 'Low effort', high: 'High effort' },
      { name: 'Impact', low: 'Low impact', high: 'High impact' },
    ],
  })
  await continueThenApply(page)
  expect(await placed).toBe(true)
  await expect
    .poll(
      async () => (await items(page)).filter((e) => e.type === 'frame' && kindOf(e) === 'sort-matrix').length,
    )
    .toBe(matrices + 1)
  await expectSaved(page)
  expect((await saveState(page)).lastReject).toBeNull()
}

test('L-compat 2 (AI on the board): AI notes with run ids, the Recap frame, a diagram from words, sort by a lens and Place with AI reach the 437b4e7 tab, live and in its catch-up; its edits keep the provenance', async ({
  join,
  browser,
  board,
  users,
  stack,
  openai,
  oldTabs,
}) => {
  test.setTimeout(360_000)
  const p = await pair(join, browser, board, users, oldTabs)
  const { a, old } = p
  await waitForSort(a.page)

  await test.step('W2: AI › Action items (AI-made notes and a heading with the run id)', async () => {
    await liveThenCaughtUp(p, stack, board, (r) =>
      actionItems(
        a.page,
        r ? ['Pick the date', 'Order the props'] : ['Book the venue', 'Draft the brief', 'Call the studio'],
        r * 600,
      ),
    )
    expect((await aiObjects(old.page)).map((o) => o.id).sort()).toEqual(
      (await aiObjects(a.page)).map((o) => o.id).sort(),
    )
  })

  await test.step('W2: Wrap up, Add as Recap frame (the AI’s parts with provenance, the room’s table)', async () => {
    await liveThenCaughtUp(p, stack, board, (r) => recapFrame(a.page, { x: 30_000 + r * 5_000, y: 30_000 }))
  })

  await test.step('W4 with W1: Diagram from words (24 nodes past the preview, then 12)', async () => {
    await liveThenCaughtUp(p, stack, board, (r) =>
      diagramFromWords(a.page, openai, 2_600 + r * 3_000, r ? 12 : 24),
    )
  })

  await test.step('W8 with W1: sort by a lens (headings with the run id) and Place with AI on a new 2x2', async () => {
    await liveThenCaughtUp(p, stack, board, (r) => lensAndPlace(a.page, 6_000 + r * 4_000))
  })

  await test.step('bob moves, recolours and renames what AI made: every element keeps its provenance, run id and kind', async () => {
    const all = await items(old.page)
    const pick = (kind: string, pred: (e: CanvasElement) => boolean = () => true) => {
      const el = all.find((e) => kindOf(e) === kind && !(e.type === 'text' && e.containerId) && pred(e))
      if (!el) throw new Error(`no ${kind} on bob's board`)
      return el
    }
    const note = pick('ai-action-item')
    const node = pick('ai-diagram-node')
    const heading = pick('ai-sort-label')
    const matrix = pick('sort-matrix', (e) => e.type === 'frame')
    const recap = all.find((e) => e.type === 'frame' && String(e.name).startsWith('Recap · '))
    if (!recap) throw new Error('no Recap frame on bob’s board')
    await oldTabEdits(p, stack, board, [
      { id: note.id, patch: { x: note.x + 40, y: note.y + 30 } },
      { id: node.id, patch: { backgroundColor: '#ffc9c9' } },
      { id: heading.id, patch: { x: heading.x + 25 } },
      { id: matrix.id, patch: { name: 'Effort and impact' } },
      { id: recap.id, patch: { name: 'Recap (checked)' } },
    ])
    for (const id of [note.id, node.id, heading.id])
      expect((lobbyOf(await storedElement(stack, board, id)).ai as { run?: string }).run).toMatch(RUN_ID)
  })
})

// ---- 3. builders without AI (W4's Mermaid paste and next shape, W8's sort headings and pieces) -------------------

/** A small Mermaid flowchart: 8 nodes of mixed kinds, 8 links (three of them labelled). */
const CHART = [
  'flowchart TD',
  '  A[Brief] --> B{Approved?}',
  '  B -->|yes| C((Shoot))',
  '  B -->|no| D[/Rework/]',
  '  D --> A',
  '  C --> E[Edit]',
  '  E --> F[Grade]',
  '  F --> G[Mix]',
  '  G -->|final| H[Deliver]',
].join('\n')
const CHART_LINKS = 8

const arrowsFrom = async (page: Page, from: string) =>
  (await items(page)).filter(
    (e) =>
      e.type === 'arrow' && (e as { startBinding?: { elementId?: string } }).startBinding?.elementId === from,
  )
const pieceCount = async (page: Page) =>
  (await items(page)).filter((e) => (kindOf(e) ?? '').startsWith('piece-')).length

test('L-compat 3 (no AI): a pasted Mermaid chart, the flow’s next shape, sort headings and pieces reach the 437b4e7 tab, live and in its catch-up; its edits keep their kinds', async ({
  join,
  browser,
  board,
  users,
  stack,
  oldTabs,
}) => {
  test.setTimeout(300_000)
  const p = await pair(join, browser, board, users, oldTabs)
  const { a, old } = p
  await grantClipboard(a.context)
  await waitForSort(a.page)

  await test.step('W4: Mermaid paste as a diagram (shapes, elbow connectors, link labels; no AI)', async () => {
    await liveThenCaughtUp(p, stack, board, async (r) => {
      await setViewport(a.page, { x: -200 + r * 6_000, y: -200, zoom: 0.6 })
      const arrows = (await items(a.page)).filter((e) => e.type === 'arrow').length
      await writeClipboard(a.page, { 'text/plain': CHART })
      await focusBoard(a.page)
      await a.page.keyboard.press('ControlOrMeta+v')
      await expect(a.page.getByTestId('mermaid-paste-prompt')).toBeVisible()
      await a.page.getByTestId('mermaid-paste-diagram').click()
      await expect
        .poll(async () => (await items(a.page)).filter((e) => e.type === 'arrow').length)
        .toBe(arrows + CHART_LINKS)
      await expectSaved(a.page)
      expect((await saveState(a.page)).lastReject).toBeNull()
    })
  })

  await test.step('W4: Ctrl+Right makes the next connected shape (the connector’s ends the room’s)', async () => {
    await liveThenCaughtUp(p, stack, board, async (r) => {
      const y = 3_000 + r * 400
      const src = await createItem(a.page, 'rectangle', { x: 0, y, width: 160, height: 80 })
      await expectSaved(a.page)
      await setViewport(a.page, { x: -100, y: y - 200, zoom: 1 })
      await select(a.page, [src])
      await focusCanvas(a.page)
      await a.page.keyboard.press('ControlOrMeta+ArrowRight')
      await expect.poll(async () => (await arrowsFrom(a.page, src)).length).toBe(1)
      await a.page.keyboard.press('Escape')
      await expectSaved(a.page)
      expect((await saveState(a.page)).lastReject).toBeNull()
    })
  })

  await test.step('W8: sort by colour into labelled columns (headings, moves)', async () => {
    await liveThenCaughtUp(p, stack, board, async (r) => {
      const y = 5_000 + r * 1_200
      const frame = await makeFrame(a.page, 0, y, 2_000, 900, `Colours ${r}`)
      const ids = await makeNotes(
        a.page,
        [
          { x: 60, y: y + 120, text: 'one', fill: FILL.sky },
          { x: 300, y: y + 120, text: 'two', fill: FILL.butter },
          { x: 540, y: y + 120, text: 'three', fill: FILL.sky },
        ],
        frame,
      )
      const heads = (await headings(a.page)).length
      await select(a.page, ids)
      expect(await sortRun(a.page, 'sort.colour')).toBe(true)
      await expect.poll(async () => (await headings(a.page)).length).toBe(heads + 2)
      await expectSaved(a.page)
      expect((await saveState(a.page)).lastReject).toBeNull()
    })
  })

  await test.step('W8: pieces from the Pieces panel (Decision, a button, a persona; then a stage and a shot)', async () => {
    await a.page.getByTestId('dock-tab-pieces').click()
    await expect(a.page.getByTestId('pieces-panel')).toBeVisible()
    await liveThenCaughtUp(p, stack, board, async (r) => {
      await setViewport(a.page, { x: 3_000 + r * 3_000, y: 5_000, zoom: 1 })
      for (const word of r ? ['stage', 'shot'] : ['dec', 'button', 'persona']) {
        const count = await pieceCount(a.page)
        await a.page.getByTestId('piece-search').fill(word)
        await a.page.getByTestId('piece-search').press('Enter')
        await expect.poll(() => pieceCount(a.page)).toBeGreaterThan(count)
        await expectSaved(a.page)
      }
      expect((await saveState(a.page)).lastReject).toBeNull()
    })
  })

  await test.step('bob moves a piece, a sort heading, a pasted shape and a flow shape: every kind stays, the connectors are the room’s', async () => {
    const all = await items(old.page)
    const piece = all.find((e) => (kindOf(e) ?? '').startsWith('piece-') && e.type !== 'text')
    const heading = all.find((e) => kindOf(e) === 'sort-label')
    const pasted = all.find((e) => e.type === 'diamond' && !kindOf(e))
    const flow = all.find(
      (e) =>
        e.type === 'rectangle' &&
        !kindOf(e) &&
        all.some(
          (x) =>
            (x as { endBinding?: { elementId?: string } }).endBinding?.elementId === e.id &&
            x.type === 'arrow',
        ),
    )
    if (!piece || !heading || !pasted || !flow) throw new Error('bob is missing what he edits')
    await oldTabEdits(p, stack, board, [
      { id: piece.id, patch: { backgroundColor: '#d0bfff' } },
      { id: heading.id, patch: { x: heading.x + 30 } },
      { id: pasted.id, patch: { x: pasted.x + 60, y: pasted.y + 20 } },
      { id: flow.id, patch: { x: flow.x + 40 } },
    ])
  })
})

// ---- 4. W7's restore and W5's vote results to the board ------------------------------------------------------------

test('L-compat 4 (restore, vote results): a restore of a frame with minutes and the vote’s chart and winners reach the 437b4e7 tab, live and in its catch-up; its edits keep them', async ({
  join,
  browser,
  board,
  users,
  stack,
  oldTabs,
}) => {
  test.setTimeout(300_000)
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

  await test.step('W7: a checkpoint, the board changed (the minutes, a note deleted, one moved), Restore these', async () => {
    await liveThenCaughtUp(p, stack, board, async (r) => {
      const res = await api.fetch('POST', `/api/boards/${board}/snapshots`, {
        name: `Before the changes ${r}`,
      })
      expect(res.status(), await res.text()).toBe(201)
      await minutesAndMove(a.page, 'rx-f1', { index: 0, mins: 40 + r }, 'rx-n2', { x: 900, y: 900 })
      await a.page.evaluate(() => {
        type Tx = { delete(id: string): void }
        const b = (
          window as unknown as {
            __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } }
          }
        ).__lobbyBoard
        b.canvas.transact('e2e: delete', (tx) => tx.delete('rx-n1'))
      })
      await expectSaved(a.page)
      await openHistory(a.page)
      await a.page.getByTestId('history-time-travel').click()
      const d = a.page.getByTestId('checkpoint-preview-dialog')
      await expect(d).toBeVisible()
      await expect(d).toContainText(`Before the changes ${r}`)
      await d.getByTestId('history-select-changes').click()
      await d.getByTestId('history-restore-elements').click()
      await expect(a.page.getByTestId('history-restored-notice')).toContainText('for everyone')
      await expect(d).toHaveCount(0)
      await expect
        .poll(async () => present((await storedElement(stack, board, 'rx-f1')) as CanvasElement)?.mins)
        .toBe(15)
      await expectSaved(a.page)
    })
    expect(present(await item(old.page, 'rx-f1'))?.mins).toBe(15)
    expect(await item(old.page, 'rx-n1')).toBeTruthy()
    expect((await item(old.page, 'rx-n2'))?.x).toBe(320)
  })

  await test.step('W5: a vote cast by both and revealed, then Results to board and Gather the winners', async () => {
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
    await liveThenCaughtUp(p, stack, board, async () => {
      const charts = (await items(a.page)).filter(
        (e) => e.type === 'frame' && kindOf(e) === 'vote-chart',
      ).length
      const winners = (await items(a.page)).filter(
        (e) => e.type === 'frame' && kindOf(e) === 'vote-winners',
      ).length
      await a.page.getByTestId('vote-results-to-board').click()
      await expect
        .poll(
          async () =>
            (await items(a.page)).filter((e) => e.type === 'frame' && kindOf(e) === 'vote-chart').length,
          {
            timeout: 8_000,
          },
        )
        .toBe(charts + 1)
      await expectSaved(a.page)
      await a.page.getByTestId('vote-gather').click()
      await expect
        .poll(
          async () =>
            (await items(a.page)).filter((e) => e.type === 'frame' && kindOf(e) === 'vote-winners').length,
        )
        .toBe(winners + 1)
      await expectSaved(a.page)
      expect((await saveState(a.page)).lastReject).toBeNull()
    })
  })

  await test.step('bob moves the chart, renames the winners and the restored frame: kinds and minutes stay', async () => {
    const all = await items(old.page)
    const chart = all.find((e) => e.type === 'frame' && kindOf(e) === 'vote-chart')
    const winners = all.find((e) => e.type === 'frame' && kindOf(e) === 'vote-winners')
    if (!chart || !winners) throw new Error('no chart or winners frame at bob')
    await oldTabEdits(p, stack, board, [
      { id: chart.id, patch: { x: chart.x + 50 } },
      { id: winners.id, patch: { name: 'Top ideas (agreed)' } },
      { id: 'rx-f1', patch: { name: 'Kick-off (done)' } },
    ])
    expect(present((await storedElement(stack, board, 'rx-f1')) as CanvasElement)?.mins).toBe(15)
  })
})
