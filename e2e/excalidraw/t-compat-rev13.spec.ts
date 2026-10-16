// Wave T (CONTRACTS_REV 14, WS1's stale pair (a); docs/WAVE-T-CONTRACTS.md §3.6, EXCALIDRAW-CONTRACTS.md §0b): a tab of
// the web deployed since wave S (6769e07, CONTRACTS_REV 13, a build of it with dev auth, served on this run's web
// origin by l-compat-kit.ts serveOldWeb) and a tab of this tree's web, on one board, through this tree's sync with
// DRAFTROOM_PLANNING on (the room says 14). The old tab's board socket is NOT relayed: CDP hands over every frame it
// gets, parsed with that build's own frozen schemas (packages/canvas-schema/test/fixtures/rev13-6769e07). While this
// tree's tab makes and edits cards (status, assignee, dates), a storyboard (a head, panels, a reorder, durations), a
// Kanban and a timeline, the old tab:
//  - receives every change (no frame its socket would drop; no `p` op naming a planning key: they reach it as the
//    `c` op of the stored element), and pushes nothing while it only receives;
//  - writes as rev 13: its move of a card and of a panel, and its edit of a card's words, commit and keep the keys;
//    its Ctrl+D of a card makes a plain note (the original keeps its keys); its delete and Ctrl+Z bring the card back
//    with them;
//  - never gets a CLOSING notice, never reconnects, throws nothing, and ends on the server's board (convergence
//    hashes), this tree's tab too.
// Run (the old build is made outside the repo, as l-compat-kit.ts describes):
//   cd e2e && E2E_OLD_WEB_DIST=<the 6769e07 dist> E2E_OLD_WEB_COMMIT=6769e07 E2E_PORT_BASE=<base> \
//     pnpm exec playwright test excalidraw/t-compat-rev13.spec.ts --project=chromium --workers=1
// Without E2E_OLD_WEB_DIST it is skipped, saying so.
import type { Page } from '@playwright/test'
import { isPlanningKey } from '../../packages/canvas-schema/src/planning-keys.ts'
import { CONTRACTS_REV } from '../../packages/canvas-schema/src/protocol.ts'
import {
  type CanvasElement,
  createItem,
  createNote,
  expect,
  expectSaved,
  hash,
  item,
  items,
  itemText,
  saveState,
  select,
  setViewport,
  startTextEditing,
  stopTextEditing,
  test,
  typeText,
  updateItem,
} from '../tests/support/canvas.ts'
import { serverSnapshot, storedElement } from '../tests/support/excalidraw.ts'
import { withCanvas } from './canvas-ux-kit.ts'
import {
  OLD_WEB_COMMIT,
  OLD_WEB_DIST,
  OLD_WEB_LAUNCH,
  OLD_WEB_SKIP_REASON,
  type OldSocketWatch,
  REV13_SCHEMAS,
  serveOldWeb,
  watchOldSocket,
} from './l-compat-kit.ts'
import { openTab, sidOf } from './l6-kit.ts'

test.use({ viewport: { width: 1440, height: 900 }, launchOptions: OLD_WEB_LAUNCH })
test.use({ syncEnv: { DRAFTROOM_PLANNING: 'on' } })

type Lobby = Record<string, unknown>
const lobbyOf = (el: CanvasElement | null | undefined): Lobby => (el?.customData?.lobby ?? {}) as Lobby
const planningOf = (el: CanvasElement | null | undefined): Lobby =>
  Object.fromEntries(Object.entries(lobbyOf(el)).filter(([k]) => isPlanningKey(k)))
type WireOp = { k: string; el?: CanvasElement; c?: Record<string, unknown> }
const opsOf = (frames: readonly string[]): WireOp[] =>
  frames
    .filter((f) => f.startsWith('{"type":"changes"') || f.startsWith('{"type":"welcome"'))
    .flatMap((f) => {
      const m = JSON.parse(f) as { ops?: WireOp[]; catchUp?: WireOp[] }
      return [...(m.ops ?? []), ...(m.catchUp ?? [])]
    })
const pushes = (s: OldSocketWatch) => s.sent.filter((t) => t === 'push').length
const roomRev = (page: Page) => withCanvas(page, (c) => c.room.contractsRev(), null)
/** Writes these `customData.lobby` keys (null removes) on `id` from `page`, and waits for Saved. */
async function plan(page: Page, id: string, keys: Lobby): Promise<void> {
  await updateItem(page, id, { customData: { lobby: keys } })
  await expectSaved(page)
  expect((await saveState(page)).lastReject).toBeNull()
}

test('t-compat: the 6769e07 web beside cards, a storyboard, a Kanban and a timeline: every frame, its moves, words, Ctrl+D and undo', async ({
  browser,
  board,
  users,
  canvasSession,
  stack,
}) => {
  test.skip(!OLD_WEB_DIST, OLD_WEB_SKIP_REASON)
  test.setTimeout(300_000)
  const a = await canvasSession('alice')
  const served: string[] = []
  const pageErrors: string[] = []
  let sock: OldSocketWatch | null = null
  const b = await openTab(browser, board, users, 'bob', {
    role: 'editor',
    beforeOpen: async (page) => {
      await serveOldWeb(page.context(), OLD_WEB_DIST as string, served)
      page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
      sock = await watchOldSocket(page, REV13_SCHEMAS)
    },
  })
  const s = sock as unknown as OldSocketWatch
  const card = {
    'card:status': 'todo',
    'card:who': a.id,
    'card:start': '2026-10-01',
    'card:due': '2026-10-30',
  }
  const ids = { n: '', r: '', head: '', p1: '', p2: '', k: '', t: '' }
  try {
    await test.step('bob is the deployed 6769e07 build (rev 13 in its connect URL), the room says 14', async () => {
      test
        .info()
        .annotations.push({ type: 'previous web', description: `${OLD_WEB_COMMIT} (${OLD_WEB_DIST})` })
      expect(served.some((p) => p.startsWith('/assets/'))).toBe(true)
      await expect.poll(() => s.connectUrls.length).toBeGreaterThan(0)
      for (const u of s.connectUrls) expect(new URL(u).searchParams.get('rev')).toBe('13')
      expect(CONTRACTS_REV).toBe(14)
      await expect.poll(() => roomRev(a.page)).toBe(14)
      // the deployed web reads 14 as "13 or later"
      await expect.poll(() => roomRev(b.page)).toBe(14)
    })
    const bsid = (await sidOf(b.page)) as string

    await test.step('alice makes cards, a storyboard, a Kanban and a timeline and edits them: bob gets each as the c op of the element, and pushes nothing', async () => {
      ids.n = await createNote(a.page, { x: 100, y: 100, text: 'Write the brief' })
      ids.r = await createItem(a.page, 'rectangle', { x: 400, y: 100, width: 200, height: 120 })
      ids.head = await createItem(a.page, 'text', { x: 100, y: 450, text: 'Spot 30s' })
      ids.p1 = await createItem(a.page, 'frame', { x: 100, y: 520, width: 320, height: 180, name: 'Panel' })
      ids.p2 = await createItem(a.page, 'frame', { x: 460, y: 520, width: 320, height: 180, name: 'Panel' })
      ids.k = await createItem(a.page, 'frame', { x: 100, y: 800, width: 900, height: 400, name: 'Board' })
      ids.t = await createItem(a.page, 'frame', { x: 1100, y: 800, width: 900, height: 400, name: 'Plan' })
      await expectSaved(a.page)
      for (const id of Object.values(ids))
        await expect.poll(() => item(b.page, id).then((e) => e?.id ?? null)).toBe(id)
      await expectSaved(b.page)
      const before = pushes(s)
      await plan(a.page, ids.n, card)
      await plan(a.page, ids.r, { 'card:status': 'doing' })
      await plan(a.page, ids.head, { 'sb:head': { aspect: '16:9', fps: 24 } })
      await plan(a.page, ids.p1, { 'sb:of': ids.head, 'sb:pos': 'a0', 'sb:dur': 2000 })
      await plan(a.page, ids.p2, { 'sb:of': ids.head, 'sb:pos': 'a1', 'sb:dur': 2000 })
      await plan(a.page, ids.k, { kanban: { labels: { doing: 'Now' }, wip: { doing: 2 } } })
      await plan(a.page, ids.t, {
        timeline: { start: '2026-10-01', end: '2026-12-31', scale: 'week', lanes: 'status' },
      })
      // edits: a status, a reorder with a duration and a move in one step, an unmade card
      await plan(a.page, ids.n, { 'card:status': 'review' })
      await withCanvas(
        a.page,
        (c, x) =>
          c.transact('e2e: a reorder, a duration and a move', (tx) => {
            tx.update(x.id, { customData: { lobby: { 'sb:pos': 'Zz', 'sb:dur': 3500 } } })
            tx.update(x.id, { x: 480 })
          }),
        { id: ids.p2 },
      )
      await expectSaved(a.page)
      await plan(a.page, ids.r, { 'card:status': null })
      await expect
        .poll(async () => planningOf(await item(b.page, ids.p2)))
        .toEqual({ 'sb:of': ids.head, 'sb:pos': 'Zz', 'sb:dur': 3500 })
      await expect
        .poll(async () => planningOf(await item(b.page, ids.n)))
        .toEqual({ ...card, 'card:status': 'review' })
      await expect.poll(async () => planningOf(await item(b.page, ids.r))).toEqual({})
      expect(planningOf(await storedElement(stack, board, ids.n))).toEqual({
        ...card,
        'card:status': 'review',
      })
      await s.settled()
      expect(s.dropped, 'frames the deployed web’s socket would drop').toEqual([])
      const ops = opsOf(s.frames)
      expect(
        ops.filter((o) => o.k === 'p' && Object.keys(o.c ?? {}).some(isPlanningKey)),
        'p ops naming a planning key sent to the rev-13 tab',
      ).toEqual([])
      expect(ops.some((o) => o.k === 'c' && Object.keys(planningOf(o.el)).length > 0)).toBe(true)
      expect(pushes(s), 'bob only received').toBe(before)
    })

    await test.step('bob moves the card and a panel: they commit and keep their keys', async () => {
      await updateItem(b.page, ids.n, { x: 140, y: 120 })
      await updateItem(b.page, ids.p1, { x: 120, y: 540 })
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
      await expect.poll(async () => (await storedElement(stack, board, ids.n))?.x).toBe(140)
      expect(planningOf(await storedElement(stack, board, ids.n))).toEqual({
        ...card,
        'card:status': 'review',
      })
      expect(planningOf(await storedElement(stack, board, ids.p1))).toEqual({
        'sb:of': ids.head,
        'sb:pos': 'a0',
        'sb:dur': 2000,
      })
    })

    await test.step('bob edits the words of the card: it commits and keeps the keys', async () => {
      await setViewport(b.page, { x: 0, y: 0, zoom: 1 })
      await startTextEditing(b.page, ids.n)
      await b.page.keyboard.press('End')
      await typeText(b.page, ' today')
      await stopTextEditing(b.page)
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
      await expect.poll(() => itemText(a.page, ids.n)).toBe('Write the brief today')
      expect(planningOf(await storedElement(stack, board, ids.n))).toEqual({
        ...card,
        'card:status': 'review',
      })
    })

    await test.step('bob duplicates the card (Ctrl+D): the copy is a plain note, the original keeps its keys', async () => {
      const known = (await items(b.page)).filter((e) => e.type === 'stickynote').map((e) => e.id)
      await select(b.page, [ids.n])
      await b.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
      await b.page.keyboard.press('ControlOrMeta+d')
      const copyOf = async () =>
        (await items(b.page)).find((e) => e.type === 'stickynote' && !known.includes(e.id))?.id ?? null
      await expect.poll(copyOf).not.toBeNull()
      const copy = (await copyOf()) as string
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
      await expect.poll(() => item(a.page, copy).then((e) => e?.id ?? null)).toBe(copy)
      expect(planningOf(await storedElement(stack, board, copy))).toEqual({})
      expect(planningOf(await item(a.page, copy))).toEqual({})
      expect(planningOf(await storedElement(stack, board, ids.n))).toEqual({
        ...card,
        'card:status': 'review',
      })
    })

    await test.step('bob deletes the card and undoes it (Ctrl+Z): it is back with its keys', async () => {
      await select(b.page, [ids.n])
      await b.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
      await b.page.keyboard.press('Delete')
      await expect.poll(async () => (await storedElement(stack, board, ids.n))?.isDeleted).toBe(true)
      await b.page.keyboard.press('ControlOrMeta+z')
      await expect.poll(async () => (await storedElement(stack, board, ids.n))?.isDeleted).toBe(false)
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
      expect(planningOf(await storedElement(stack, board, ids.n))).toEqual({
        ...card,
        'card:status': 'review',
      })
      await expect
        .poll(async () => planningOf(await item(a.page, ids.n)))
        .toEqual({ ...card, 'card:status': 'review' })
    })

    await test.step('every tab holds the server’s board; bob’s socket dropped nothing, was never closed by the room, never reconnected; his page threw nothing', async () => {
      const server = await serverSnapshot(stack, board)
      await expect.poll(() => hash(a.page)).toBe(server.hash)
      await expect.poll(() => hash(b.page)).toBe(server.hash)
      await s.settled()
      expect(s.dropped).toEqual([])
      expect(s.closing).toEqual([])
      expect(s.extensions, 'one board socket handshake: no reconnect').toHaveLength(1)
      expect(await sidOf(b.page)).toBe(bsid)
      expect(pageErrors).toEqual([])
      await expect(b.page.getByTestId('conn-status')).not.toHaveAttribute('data-state', /offline|error/)
    })
  } finally {
    await b.context.close()
  }
})
