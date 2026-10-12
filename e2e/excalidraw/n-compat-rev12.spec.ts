// Wave N (CONTRACTS_REV 13, proof (3) of N2-6; docs/EXCALIDRAW-CONTRACTS.md §0b): a tab of the web deployed on
// staging since hotfix H2 (3c83611, CONTRACTS_REV 12, a build of it with dev auth, served on this run's web origin by
// l-compat-kit.ts serveOldWeb) and a tab of this tree's web, on one board, through this tree's sync with reactions
// on, with permessage-deflate off and on. The old tab's board socket is NOT relayed (its browser talks to the sync
// through the preview proxy itself, so deflate is negotiated as in production); CDP hands over every frame it gets,
// parsed with that build's own frozen schemas (packages/canvas-schema/test/fixtures/rev12-3c83611). While this tree's
// tab reacts (`react:<code>:<uid>`), the old tab:
//  - receives every reaction and every edit (no frame its socket would drop; no `p` op naming a reaction key, they
//    reach it as the `c` op of the stored note), and pushes nothing while it only receives;
//  - keeps working: edits both ways, cursors, the laser, follow, a vote (a reaction lands during it), a spotlight and
//    a restore from "Recently deleted";
//  - writes as rev 12: its edit of a reacted note's words commits and keeps the reactions, its Ctrl+D of it makes a
//    copy without them (the original keeps them), and its delete and Ctrl+Z bring the note back with them;
//  - never gets a CLOSING notice (so no INVALID_MESSAGE close), never reconnects, throws nothing, and ends on the
//    server's board (convergence hashes), this tree's tab too.
// Run (the old build is made outside the repo, as l-compat-kit.ts describes), once per deflate mode:
//   cd e2e && E2E_OLD_WEB_DIST=<the 3c83611 dist> E2E_OLD_WEB_COMMIT=3c83611 E2E_WS_DEFLATE=off|on \
//     E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n-compat-rev12.spec.ts --project=chromium --workers=1
// Without E2E_OLD_WEB_DIST it is skipped, saying so.
import type { Page } from '@playwright/test'
import { CONTRACTS_REV } from '../../packages/canvas-schema/src/protocol.ts'
import { reactionKey } from '../../packages/canvas-schema/src/reactions.ts'
import {
  type CanvasElement,
  createNote,
  deleteItem,
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
  viewport,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { serverSnapshot, storedElement } from '../tests/support/excalidraw.ts'
import { withCanvas } from './canvas-ux-kit.ts'
import {
  OLD_WEB_COMMIT,
  OLD_WEB_DIST,
  OLD_WEB_LAUNCH,
  OLD_WEB_SKIP_REASON,
  type OldSocketWatch,
  REV12_SCHEMAS,
  serveOldWeb,
  watchOldSocket,
} from './l-compat-kit.ts'
import { follow, laserStroke, openTab, pickLaser, sidOf, watchLaser } from './l6-kit.ts'
import { clickElement } from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 }, launchOptions: OLD_WEB_LAUNCH })

type Lobby = Record<string, unknown>
const lobbyOf = (el: CanvasElement | null | undefined): Lobby => (el?.customData?.lobby ?? {}) as Lobby
const reactionsIn = (el: CanvasElement | null | undefined) =>
  Object.keys(lobbyOf(el))
    .filter((k) => k.startsWith('react:'))
    .sort()
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

/**
 * The sync's permessage-deflate for this run (E2E_WS_DEFLATE=on|off, default off: the wave M hold). A worker option, so
 * one mode per run (Playwright starts one stack per worker): the gate runs this file twice, once with each.
 */
const deflate: 'on' | 'off' = process.env.E2E_WS_DEFLATE === 'on' ? 'on' : 'off'
test.use({ syncEnv: { DRAFTROOM_REACTIONS: 'on', DRAFTROOM_WS_DEFLATE: deflate } })

test(`n-compat (deflate ${deflate}): the 3c83611 web beside reactions: every frame, edits both ways, cursors, laser, follow, vote, spotlight, restore, a reacted note`, async ({
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
      sock = await watchOldSocket(page, REV12_SCHEMAS)
    },
  })
  const s = sock as unknown as OldSocketWatch
  const alice = await users.api('alice')
  const k = (code: Parameters<typeof reactionKey>[0]) => reactionKey(code, a.id)
  try {
    await test.step('bob is the deployed 3c83611 build (rev 12 in its connect URL), the room says 13, deflate as set', async () => {
      test
        .info()
        .annotations.push({ type: 'previous web', description: `${OLD_WEB_COMMIT} (${OLD_WEB_DIST})` })
      expect(served.some((p) => p.startsWith('/assets/'))).toBe(true)
      await expect.poll(() => s.extensions.length).toBeGreaterThan(0)
      for (const u of s.connectUrls) expect(new URL(u).searchParams.get('rev')).toBe('12')
      if (deflate === 'on') expect(s.extensions[0]).toMatch(/permessage-deflate/)
      else expect(s.extensions[0]).not.toMatch(/permessage-deflate/)
      expect(CONTRACTS_REV).toBe(13)
      await expect.poll(() => roomRev(a.page)).toBe(13)
      // the deployed web reads 13 as "12 or later"
      await expect.poll(() => roomRev(b.page)).toBe(13)
    })
    const bsid = (await sidOf(b.page)) as string
    const asid = (await sidOf(a.page)) as string

    let n = ''
    await test.step('alice reacts (alone, with a move in one commit, a removal): bob gets each one as the c op of the note, and pushes nothing', async () => {
      n = await createNote(a.page, { x: 100, y: 100, text: 'react to me' })
      await expect.poll(() => item(b.page, n).then((e) => e?.id ?? null)).toBe(n)
      await expectSaved(b.page)
      const before = pushes(s)
      await updateItem(a.page, n, { customData: { lobby: { [k('up')]: true } } })
      await expectSaved(a.page)
      await withCanvas(
        a.page,
        (c, x) =>
          c.transact('e2e: a reaction and a move', (tx) => {
            tx.update(x.id, { customData: { lobby: { [x.key]: true } } })
            tx.update(x.id, { x: 160, y: 120 })
          }),
        { id: n, key: k('heart') },
      )
      await expectSaved(a.page)
      await updateItem(a.page, n, { customData: { lobby: { [k('up')]: null } } })
      await expectSaved(a.page)
      expect((await saveState(a.page)).lastReject).toBeNull()
      await expect.poll(async () => reactionsIn(await item(b.page, n))).toEqual([k('heart')])
      expect((await item(b.page, n))?.x).toBe(160)
      await s.settled()
      expect(s.dropped, 'frames the deployed web’s socket would drop').toEqual([])
      const ops = opsOf(s.frames)
      expect(
        ops.filter((o) => o.k === 'p' && Object.keys(o.c ?? {}).some((x) => x.startsWith('react:'))),
        'p ops naming a reaction key sent to the rev-12 tab',
      ).toEqual([])
      expect(ops.some((o) => o.k === 'c' && reactionsIn(o.el).length > 0)).toBe(true)
      expect(pushes(s), 'bob only received').toBe(before)
    })

    await test.step('edits both ways', async () => {
      const fromAlice = await createNote(a.page, { x: 100, y: 500, text: 'from alice' })
      await expect.poll(() => item(b.page, fromAlice).then((e) => e?.id ?? null)).toBe(fromAlice)
      const fromBob = await createNote(b.page, { x: 420, y: 500, text: 'from bob' })
      await expect.poll(() => item(a.page, fromBob).then((e) => e?.id ?? null)).toBe(fromBob)
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
    })

    await test.step('cursors: alice’s pointer reaches bob, bob’s reaches alice', async () => {
      for (const [from, to, uid] of [
        [a, b, a.id],
        [b, a, b.id],
      ] as const) {
        const box = await from.page.locator('.excalidraw canvas').last().boundingBox()
        if (!box) throw new Error('no canvas')
        for (let i = 0; i < 6; i++) await from.page.mouse.move(box.x + 300 + i * 20, box.y + 300 + i * 10)
        await expect(to.page.locator(`[data-testid="cursor"][data-uid="${uid}"]`)).toBeVisible()
      }
    })

    await test.step('laser: alice’s sweep reaches bob’s page as a path', async () => {
      await pickLaser(a.page)
      const watch = await watchLaser(b.page, a.id, 2)
      await laserStroke(a.page)
      await expect.poll(async () => (await watch.read()).maxPoints).toBeGreaterThanOrEqual(2)
      await watch.stop()
      await a.page.keyboard.press('Escape')
    })

    await test.step('follow: bob follows alice’s view', async () => {
      await setViewport(a.page, { x: 1500, y: 700, zoom: 1 })
      await follow(b.page, asid)
      const off = async () => {
        const [av, bv] = await Promise.all([viewport(a.page), viewport(b.page)])
        return Math.round(
          Math.max(
            Math.abs(av.x + av.width / 2 - (bv.x + bv.width / 2)),
            Math.abs(av.y + av.height / 2 - (bv.y + bv.height / 2)),
          ),
        )
      }
      await expect.poll(off, { message: 'bob follows alice' }).toBeLessThanOrEqual(3)
      await b.page.keyboard.press('Escape')
    })

    let voteNote = ''
    await test.step('vote: alice starts one, bob casts a dot; a reaction lands during it (never VOTE_OPEN)', async () => {
      voteNote = await createNote(a.page, { x: 800, y: 100, text: 'vote for me' })
      await expect.poll(() => item(b.page, voteNote).then((e) => e?.id ?? null)).toBe(voteNote)
      await zoomToFit(b.page)
      const res = await alice.fetch('POST', `/api/boards/${board}/votes`, {
        title: 'Pick one',
        votesPerPerson: 3,
        onePerObject: false,
        scope: 'board',
      })
      expect(res.status()).toBeLessThan(300)
      const vid = ((await res.json()) as { session: { id: string } }).session.id
      const prompt = b.page.getByTestId('vote-join-prompt')
      await expect(prompt).toBeVisible()
      await prompt.getByTestId('vote-join').click()
      await expect(b.page.getByTestId('vote-remaining')).toHaveText('3 of 3 left')
      await clickElement(b.page, voteNote) // in a vote, a click on an object casts a dot
      await expect(b.page.getByTestId('vote-remaining')).toHaveText('2 of 3 left')
      await updateItem(a.page, voteNote, { customData: { lobby: { [k('party')]: true } } })
      await expectSaved(a.page)
      expect((await saveState(a.page)).lastReject).toBeNull()
      await expect.poll(async () => reactionsIn(await item(b.page, voteNote))).toEqual([k('party')])
      // the vote over (a click selects again, a double click edits)
      expect((await alice.fetch('POST', `/api/votes/${vid}/close`)).status()).toBe(200)
      await expect(b.page.getByTestId('vote-remaining')).toHaveCount(0)
    })

    await test.step('spotlight: alice spotlights a note, bob sees the bar; it ends for him when she ends it', async () => {
      const res = await alice.fetch('POST', `/api/boards/${board}/spotlight`, {
        refs: [`shape:${voteNote}`],
      })
      expect(res.status()).toBeLessThan(300)
      await expect(b.page.getByTestId('spotlight-bar')).toBeVisible()
      await a.page.getByTestId('spotlight-end').click()
      await expect(b.page.getByTestId('spotlight-bar')).toHaveCount(0)
    })

    await test.step('restore: a reacted note alice deleted comes back from Recently deleted, with its reaction, for bob too', async () => {
      const gone = await createNote(a.page, { x: 1100, y: 100, text: 'deleted then restored' })
      await updateItem(a.page, gone, { customData: { lobby: { [k('clap')]: true } } })
      await expectSaved(a.page)
      await expect.poll(async () => reactionsIn(await item(b.page, gone))).toEqual([k('clap')])
      await deleteItem(a.page, gone)
      await expect.poll(() => item(b.page, gone).then((e) => e?.isDeleted ?? true)).toBe(true)
      const res = await alice.fetch('POST', `/api/boards/${board}/deleted/restore`, {
        ids: [`shape:${gone}`],
      })
      expect(res.status(), await res.text()).toBeLessThan(300)
      await expect.poll(() => item(b.page, gone).then((e) => (e && !e.isDeleted ? e.id : null))).toBe(gone)
      expect(reactionsIn(await item(b.page, gone))).toEqual([k('clap')])
    })

    await test.step('bob edits the words of the reacted note: it commits and keeps the reaction', async () => {
      await setViewport(b.page, { x: 0, y: 0, zoom: 1 })
      await startTextEditing(b.page, n)
      await b.page.keyboard.press('End')
      await typeText(b.page, ' and more')
      await stopTextEditing(b.page)
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
      await expect.poll(() => itemText(a.page, n)).toBe('react to me and more')
      expect(reactionsIn(await storedElement(stack, board, n))).toEqual([k('heart')])
    })

    await test.step('bob duplicates the reacted note (Ctrl+D): the copy has no reaction, the original keeps it', async () => {
      const known = (await items(b.page)).filter((e) => e.type === 'stickynote').map((e) => e.id)
      await select(b.page, [n])
      await b.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
      await b.page.keyboard.press('ControlOrMeta+d')
      const copyOf = async () =>
        (await items(b.page)).find((e) => e.type === 'stickynote' && !known.includes(e.id))?.id ?? null
      await expect.poll(copyOf).not.toBeNull()
      const copy = (await copyOf()) as string
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
      await expect.poll(() => item(a.page, copy).then((e) => e?.id ?? null)).toBe(copy)
      expect(reactionsIn(await storedElement(stack, board, copy))).toEqual([])
      expect(reactionsIn(await item(a.page, copy))).toEqual([])
      expect(reactionsIn(await storedElement(stack, board, n))).toEqual([k('heart')])
    })

    await test.step('bob deletes the reacted note and undoes it (Ctrl+Z): it is back with its reaction', async () => {
      await select(b.page, [n])
      await b.page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
      await b.page.keyboard.press('Delete')
      await expect.poll(async () => (await storedElement(stack, board, n))?.isDeleted).toBe(true)
      await b.page.keyboard.press('ControlOrMeta+z')
      await expect.poll(async () => (await storedElement(stack, board, n))?.isDeleted).toBe(false)
      await expectSaved(b.page)
      expect((await saveState(b.page)).lastReject).toBeNull()
      expect(reactionsIn(await storedElement(stack, board, n))).toEqual([k('heart')])
      await expect.poll(async () => reactionsIn(await item(a.page, n))).toEqual([k('heart')])
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
