// Wave M, W6 (PWR-4): instant warm open from this device's last copy of the board, on the real stack.
//
//  M6-2: the second open paints the cached copy before the board socket opens (measured), read-only, saying
//        "Showing your last copy · connecting"; the welcome replaces it; a peer's edit made while the page was
//        closed is there after the welcome; a revoked user's copy is never painted (the board answers 403) and is
//        purged, and so is the copy of someone removed while the board is open (a FORBIDDEN close).
//  M6-3: OFF since the wave M round 1 refix (RESUME_FROM_CACHE false: a disk-snapshot restore keeps the epoch, so a
//        resume could not prove its lineage). The warm open paints only: its hello says since 0, it gets the
//        snapshot frame and a reset welcome, and its map hashes equal to the stored board.
//  M6-4: offline (context.setOffline), a member sees their copy read-only with "Offline · showing your copy from
//        <time>"; a guest gets the screen they got before; a copy older than 7 days is not shown.
//  The W6 review: a Sign out in one tab stays a Sign out in the browser's other tabs (none of their writes puts the
//        copy back); a warm open that brought nothing new writes no copy; a hidden tab writes at most once a minute.
//
// Every request stays on Lobby's own origin (the e2e network assertion). The cache record is read here only for
// its metadata (clock, epoch, savedAt, hash, count): never its elements' content.
import type { Browser, BrowserContext, Page, WebSocketRoute } from '@playwright/test'
import { CONNECT_URL } from '../spike-b/support/relay.ts'
import { signInContext } from '../tests/support/api.ts'
import {
  canvasCall,
  createItem,
  expect,
  hash,
  item,
  items,
  pushedOps,
  test,
  updateItem,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { expectServerConverged, noAccessScreen } from '../tests/support/excalidraw.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import type { TestUser } from '../tests/support/users.ts'
import { settled } from './board-kit.ts'
import { createGuestLink, guestOn, tokenOf } from './guests-kit.ts'

// ---- helpers ------------------------------------------------------------------------------------------------------

interface CacheRecordView {
  readonly clock: number
  readonly epoch: string
  readonly savedAt: number
  readonly hash: string
  readonly exact: boolean
  readonly count: number
}

/** This page's record of `board` for `uid` (its metadata only), or null. */
const cacheRecord = (page: Page, board: string, uid: string): Promise<CacheRecordView | null> =>
  page.evaluate(
    ({ key }) =>
      new Promise<CacheRecordView | null>((resolve, reject) => {
        const req = indexedDB.open('lobby-board-cache', 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'key' })
          if (!db.objectStoreNames.contains('index')) db.createObjectStore('index', { keyPath: 'key' })
        }
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const get = db.transaction('boards', 'readonly').objectStore('boards').get(key)
          get.onsuccess = () => {
            const r = get.result as
              | {
                  clock: number
                  epoch: string
                  savedAt: number
                  hash: string
                  exact: boolean
                  count: number
                }
              | undefined
            db.close()
            resolve(
              r
                ? {
                    clock: r.clock,
                    epoch: r.epoch,
                    savedAt: r.savedAt,
                    hash: r.hash,
                    exact: r.exact,
                    count: r.count,
                  }
                : null,
            )
          }
          get.onerror = () => reject(get.error)
        }
      }),
    { key: `${board}|${uid}` },
  )

/** Moves this page's record of `board` back in time (the 7-day offline rule). */
const ageCacheRecord = (page: Page, board: string, uid: string, savedAt: number): Promise<void> =>
  page.evaluate(
    ({ key, savedAt }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('lobby-board-cache', 1)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const t = db.transaction('boards', 'readwrite')
          const s = t.objectStore('boards')
          const get = s.get(key)
          get.onsuccess = () => {
            if (get.result) s.put({ ...get.result, savedAt })
          }
          t.oncomplete = () => {
            db.close()
            resolve()
          }
          t.onerror = () => reject(t.error)
        }
      }),
    { key: `${board}|${uid}`, savedAt },
  )

/** Writes this board's cache now (the session's debug handle, dev-auth builds); whether it was kept. */
const flushBoardCache = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const b = (window as unknown as { __lobbyBoard?: { session: { flushBoardCache(): Promise<boolean> } } })
      .__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard')
    return b.session.flushBoardCache()
  })

/** What the open did with the cache, and the board snapshot's flags (the debug handle). */
const cacheState = (page: Page) =>
  page.evaluate(() => {
    const b = (
      window as unknown as {
        __lobbyBoard?: {
          session: {
            cacheInfo: { painted: boolean; resume: boolean; writes: number; lastWriteMs: number | null }
            snapshot: {
              readonly: boolean
              role: string
              welcomed: boolean
              cached: { savedAt: number } | null
            }
          }
          core: { resumeOutcome: string | null; showingCachedCopy: boolean }
        }
      }
    ).__lobbyBoard
    if (!b) return null
    const s = b.session.snapshot
    return {
      ...b.session.cacheInfo,
      readonly: s.readonly,
      role: s.role,
      welcomed: s.welcomed,
      cached: s.cached !== null,
      resumeOutcome: b.core.resumeOutcome,
      showingCachedCopy: b.core.showingCachedCopy,
    }
  })

/**
 * Before the page loads: when every board socket opened, whether the cached-copy layer ever appeared. The paint's
 * own time is the page's `lobby.cachedPaint` mark.
 */
async function watchOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __m6: { opens: number[]; layerSeen: boolean }
      WebSocket: typeof WebSocket
    }
    w.__m6 = { opens: [], layerSeen: false }
    const Native = w.WebSocket
    class Watched extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (String(url).includes('/connect/'))
          this.addEventListener('open', () => w.__m6.opens.push(performance.now()))
      }
    }
    w.WebSocket = Watched
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="cached-copy"]')) w.__m6.layerSeen = true
    }).observe(document, { childList: true, subtree: true })
  })
}

const openTimes = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __m6?: { opens: number[]; layerSeen: boolean } }
    const mark = performance.getEntriesByName('lobby.cachedPaint')[0]
    return {
      opens: w.__m6?.opens ?? [],
      layerSeen: w.__m6?.layerSeen ?? false,
      paintAt: mark ? mark.startTime : null,
    }
  })

interface BoardSockets {
  /** per relayed socket: its binary (snapshot) frames, its text frame types, its welcome's flags */
  readonly sockets: { binary: number; types: string[]; welcome: Record<string, unknown> | null }[]
  held(): number
  /** the held sockets close (1012) and the page reconnects through to the room */
  release(): void
}

/** `page`'s board sockets: held (accepted, never answered) while `hold` is on, else relayed and counted. */
async function routeBoardSockets(page: Page, o: { hold: boolean }): Promise<BoardSockets> {
  let hold = o.hold
  const held: WebSocketRoute[] = []
  const sockets: BoardSockets['sockets'] = []
  await page.routeWebSocket(CONNECT_URL, (ws) => {
    if (hold) {
      held.push(ws)
      ws.onMessage(() => {})
      return
    }
    const entry: BoardSockets['sockets'][number] = { binary: 0, types: [], welcome: null }
    sockets.push(entry)
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      if (typeof m === 'string') {
        let type = 'unknown'
        try {
          const parsed = JSON.parse(m) as Record<string, unknown>
          type = String(parsed.type)
          // only the flags read here (a welcome's doc and roster are board content)
          if (type === 'welcome')
            entry.welcome = {
              reset: parsed.reset,
              clock: parsed.clock,
              epoch: parsed.epoch,
              catchUp: Array.isArray(parsed.catchUp) ? parsed.catchUp.length : null,
            }
        } catch {}
        entry.types.push(type)
      } else entry.binary++
      ws.send(m)
    })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
  })
  return {
    sockets,
    held: () => held.length,
    release() {
      hold = false
      for (const ws of held.splice(0)) ws.close({ code: 1012, reason: 'release' })
    },
  }
}

/**
 * Requests that leave Lobby's own origins (the e2e network assertion): the web's, and the api's, which serves the board
 * event stream itself under E2E_DIRECT_EVENTS=1 (as ai-kit.ts foreignRequests counts them).
 */
function foreignRequests(page: Page): string[] {
  const foreign: string[] = []
  const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.protocol === 'data:' || u.protocol === 'blob:') return
    if (!own.has(u.origin)) foreign.push(u.origin)
  })
  return foreign
}

/** In-app navigation (the router's own, no page load), as a link click does. */
async function goInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    history.pushState(null, '', to)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

/** The live scene's ids, positions and versions (for "nothing moved"), through a page handle. */
const scenePositions = (page: Page, handle: '__lobbyBoard' | '__lobbyOfflineCopy') =>
  page.evaluate((h) => {
    const api = (
      window as unknown as Record<
        string,
        { api: { getSceneElements(): { id: string; x: number; y: number; version: number }[] } } | undefined
      >
    )[h]?.api
    if (!api) return null
    return api
      .getSceneElements()
      .map((e) => ({ id: e.id, x: e.x, y: e.y, version: e.version }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
  }, handle)

/** A drag across the middle of the canvas (on a read-only canvas: a pan at most, never a move). */
async function dragAcrossCanvas(page: Page): Promise<void> {
  const box = await page.locator('[data-lobby-board-canvas]').first().boundingBox()
  if (!box) throw new Error('no board canvas')
  // the elements sit near the scene origin, at the canvas's top left
  await page.mouse.move(box.x + 160, box.y + 140)
  await page.mouse.down()
  await page.mouse.move(box.x + 260, box.y + 240, { steps: 6 })
  await page.mouse.up()
}

/** A signed-in context whose page is on the dashboard: boards are then opened in-app (no page load). */
async function onDashboard(
  browser: Browser,
  user: TestUser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  await signInContext(context, user.handle, user.name)
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 30_000 })
  return { context, page }
}

/** A small board: three rectangles near the scene origin, every write acknowledged. */
async function seedBoard(page: Page): Promise<string[]> {
  const ids: string[] = []
  for (const [i, color] of ['#a5d8ff', '#b2f2bb', '#ffec99'].entries())
    ids.push(
      await settled(
        page,
        createItem(page, 'rectangle', {
          x: 100 + i * 150,
          y: 100,
          width: 120,
          height: 80,
          backgroundColor: color,
          fillStyle: 'solid',
        }),
      ),
    )
  return ids
}

// ---- M6-2 / M6-3 ----------------------------------------------------------------------------------------------------

test('M6-2: the second open paints the cached copy before the board socket opens, then the welcome takes over', async ({
  canvasSession,
  board,
}, testInfo) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const ids = await seedBoard(a.page)
  expect(await flushBoardCache(a.page)).toBe(true)
  const record = await cacheRecord(a.page, board, a.id)
  expect(record).toMatchObject({ exact: true })
  expect(record?.count).toBeGreaterThanOrEqual(3)

  await watchOpen(a.page)
  await a.page.reload()
  await waitForCanvas(a.page)
  const t = await openTimes(a.page)
  expect(t.paintAt, 'the cached copy was painted').not.toBeNull()
  expect(t.opens.length).toBeGreaterThanOrEqual(1)
  const first = t.opens[0] as number
  testInfo.annotations.push({
    type: 'cached paint before the socket',
    description: `painted at ${Math.round(t.paintAt as number)} ms, socket open at ${Math.round(first)} ms`,
  })
  expect(t.paintAt as number).toBeLessThan(first)
  expect(t.layerSeen).toBe(true)
  // after the welcome: the layer is gone, the role is the owner's, and the copy was replaced by the room's state
  await expect(a.page.getByTestId('cached-copy')).toHaveCount(0)
  const s = await cacheState(a.page)
  expect(s).toMatchObject({
    painted: true,
    welcomed: true,
    cached: false,
    readonly: false,
    showingCachedCopy: false,
  })
  for (const id of ids) expect(await item(a.page, id)).not.toBeNull()
  expect(await pushedOps(a.page)).toEqual([])
  expect(foreign).toEqual([])
})

test('M6-2: read-only until the welcome; a peer edit made while closed appears after it; paint only (the snapshot, no resume); the hash is the stored board', async ({
  canvasSession,
  stack,
  board,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const foreign = foreignRequests(a.page)
  const ids = await seedBoard(a.page)
  const [r1, r2] = ids as [string, string]
  await expectServerConverged(stack, board, [a.page, b.page])
  expect(await flushBoardCache(a.page)).toBe(true)
  const record = await cacheRecord(a.page, board, a.id)
  expect(record).not.toBeNull()

  // alice's page goes; bob edits while it is closed
  await a.page.goto('/')
  await updateItem(b.page, r1, { x: 777, backgroundColor: '#ffc9c9' })
  await expectServerConverged(stack, board, [b.page])

  // she opens the board again with her board socket held: only the cached copy is there
  const sockets = await routeBoardSockets(a.page, { hold: true })
  await a.page.goto(`/b/${board}`)
  await expect(a.page.getByTestId('cached-copy')).toBeVisible({ timeout: 30_000 })
  await expect(a.page.getByTestId('cached-copy-label')).toHaveText('Showing your last copy · connecting')
  await expect(a.page.getByTestId('save-status')).toHaveAttribute('data-state', 'cached')
  await expect(a.page.getByTestId('save-status')).toHaveText('Showing your last copy · connecting')
  await expect(a.page.getByTestId('sync-loading')).toHaveCount(0)
  await expect.poll(() => sockets.held()).toBeGreaterThanOrEqual(1)
  const before = await cacheState(a.page)
  expect(before).toMatchObject({
    painted: true,
    welcomed: false,
    cached: true,
    readonly: true,
    role: 'viewer',
  })
  // the copy is the one she had: bob's edit is not there yet
  expect((await item(a.page, r1))?.x).toBe(100)
  expect((await items(a.page)).length).toBe(record?.count)
  // read-only: a drag and Delete change nothing
  const positions = await scenePositions(a.page, '__lobbyBoard')
  await dragAcrossCanvas(a.page)
  await canvasCall(a.page, 'select', [r2])
  await a.page.keyboard.press('Delete')
  expect(await scenePositions(a.page, '__lobbyBoard')).toEqual(positions)

  // the room answers: its snapshot (paint only: M6-3 is off), bob's edit, the stored board's hash
  sockets.release()
  await waitForCanvas(a.page)
  await expect(a.page.getByTestId('cached-copy')).toHaveCount(0)
  await expect.poll(async () => (await item(a.page, r1))?.x).toBe(777)
  await expectServerConverged(stack, board, [a.page, b.page])
  const resumed = sockets.sockets[0]
  expect(resumed?.welcome).toMatchObject({ reset: true })
  expect(resumed?.binary, 'the snapshot frame (no resume from the cache)').toBeGreaterThanOrEqual(1)
  const after = await cacheState(a.page)
  expect(after).toMatchObject({ resume: false, resumeOutcome: null, readonly: false })
  expect(await pushedOps(a.page), 'nothing pushed by the warm open').toEqual([])
  expect(await a.page.getByTestId('save-status').getAttribute('data-state')).not.toBe('cached')
  expect(foreign).toEqual([])

  // a cold open (a fresh context: no copy) gets the snapshot, as before
  const c = await canvasSession('carol')
  expect(await cacheState(c.page)).toMatchObject({ painted: false })
  expect(await hash(c.page)).toBe(await hash(a.page))
})

test("M6-2: a revoked user's cached copy is never painted (the board answers 403) and is purged; removed while open, it is purged too", async ({
  board,
  users,
  canvasSession,
}) => {
  const alice = await users.api('alice')
  const bob = await users.get('bob')
  const carol = await users.get('carol')
  await canvasSession('alice')
  const b = await canvasSession('bob')
  await seedBoard(b.page)
  expect(await flushBoardCache(b.page)).toBe(true)
  expect(await cacheRecord(b.page, board, bob.id)).not.toBeNull()
  // bob's board page goes; alice removes him
  await b.page.goto('/')
  const res = await alice.fetch('DELETE', `/api/boards/${board}/members/${bob.id}`)
  expect(res.status()).toBeLessThan(300)
  await watchOpen(b.page)
  await b.page.goto(`/b/${board}`)
  await expect(b.page.getByText(/^You don't have access to this board\.?$/)).toBeVisible({ timeout: 30_000 })
  const t = await openTimes(b.page)
  expect(t.layerSeen, 'the cached copy was never shown').toBe(false)
  expect(t.paintAt).toBeNull()
  expect(await b.page.evaluate(() => window.lobbyCanvas === undefined)).toBe(true)
  await expect.poll(() => cacheRecord(b.page, board, bob.id)).toBeNull()

  // removed while the board is open: the FORBIDDEN close (and the event stream's access-lost) purge it
  await users.grant(board, 'carol', 'editor')
  const c = await canvasSession('carol', { role: null })
  expect(await flushBoardCache(c.page)).toBe(true)
  expect(await cacheRecord(c.page, board, carol.id)).not.toBeNull()
  const res2 = await alice.fetch('DELETE', `/api/boards/${board}/members/${carol.id}`)
  expect(res2.status()).toBeLessThan(300)
  await expect(noAccessScreen(c.page)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => cacheRecord(c.page, board, carol.id)).toBeNull()
})

test("M6-1: the export policy turning off for a viewer, and a trashed board, purge that person's copy", async ({
  board,
  users,
  canvasSession,
}) => {
  const alice = await users.api('alice')
  const bob = await users.get('bob')
  const carol = await users.get('carol')
  const a = await canvasSession('alice')
  await seedBoard(a.page)
  const b = await canvasSession('bob')
  const c = await canvasSession('carol', { role: 'viewer' })
  // a viewer's copy is kept once the policy (here 'everyone') is known to let them export
  await expect.poll(() => flushBoardCache(c.page), { timeout: 20_000 }).toBe(true)
  expect(await cacheRecord(c.page, board, carol.id)).not.toBeNull()
  expect(await flushBoardCache(b.page)).toBe(true)
  expect(await cacheRecord(b.page, board, bob.id)).not.toBeNull()

  // the owner turns exporting off for viewers: carol's copy goes, and none is written again
  const put = await alice.fetch('PUT', `/api/boards/${board}/export-policy`, { exportPolicy: 'editors' })
  expect(put.status(), await put.text()).toBe(200)
  await expect.poll(() => cacheRecord(c.page, board, carol.id), { timeout: 20_000 }).toBeNull()
  expect(await flushBoardCache(c.page)).toBe(false)
  // an editor's copy stays
  expect(await cacheRecord(b.page, board, bob.id)).not.toBeNull()

  // the board is trashed while bob has it open: his copy goes with it
  const trash = await alice.fetch('POST', `/api/boards/${board}/trash`)
  expect(trash.status(), await trash.text()).toBe(200)
  await expect(noAccessScreen(b.page)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => cacheRecord(b.page, board, bob.id)).toBeNull()
})

// ---- the W6 review: Sign out across tabs, and the cost of writes ---------------------------------------------------

/** The account menu's Sign out (on these stacks the development sign-in's badge), as sign-out-purge.spec.ts. */
async function signOut(page: Page): Promise<void> {
  await page.getByTestId('dev-identity-badge').click({ timeout: 15_000 })
  await page.getByTestId('sign-out').click({ timeout: 15_000 })
  await expect(page).toHaveURL(/\/signin/)
}

/** The page is hidden (a tab switch, a phone switching apps), as the browser reports it; `false` shows it again. */
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((h) => {
    if (h) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    else delete (document as unknown as { visibilityState?: string }).visibilityState
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)

const cacheWrites = async (page: Page): Promise<number> => (await cacheState(page))?.writes ?? -1

test("the W6 review: a Sign out in one tab stays a Sign out in the browser's other tabs (no write puts the copy back)", async ({
  canvasSession,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await seedBoard(a.page)
  // tab B: the same person, the same browser, the same board, with an acknowledged edit not yet written to the cache
  const b = await a.context.newPage()
  const foreignB = foreignRequests(b)
  await b.goto(`/b/${board}`)
  await waitForCanvas(b)
  expect(await flushBoardCache(b)).toBe(true)
  await settled(b, createItem(b, 'rectangle', { x: 100, y: 300, width: 120, height: 80 }))
  expect(await cacheRecord(b, board, alice.id)).not.toBeNull()

  // tab A: her own Sign out deletes her copy
  await signOut(a.page)
  await expect.poll(() => cacheRecord(a.page, board, alice.id), { timeout: 10_000 }).toBeNull()
  // tab B is hidden, then leaves (its hidden-page and pagehide writes): the copy stays gone
  await setHidden(b, true)
  await b.goto('/signin')
  await new Promise((r) => setTimeout(r, 3_000))
  expect(await cacheRecord(a.page, board, alice.id)).toBeNull()
  expect(await cacheRecord(b, board, alice.id)).toBeNull()

  // she signs in again: a session started after the Sign out keeps her copy as usual
  await signInContext(a.context, alice.handle, alice.name)
  await a.page.goto(`/b/${board}`)
  await waitForCanvas(a.page)
  expect(await flushBoardCache(a.page)).toBe(true)
  expect(await cacheRecord(a.page, board, alice.id)).not.toBeNull()
  expect(foreign).toEqual([])
  expect(foreignB).toEqual([])
})

test('the W6 review: a warm open that brought nothing new writes no copy; a hidden tab writes at most once a minute, the page going at once', async ({
  canvasSession,
  board,
}) => {
  const a = await canvasSession('alice')
  await seedBoard(a.page)
  expect(await flushBoardCache(a.page)).toBe(true)
  const record = await cacheRecord(a.page, board, a.id)
  expect(record).not.toBeNull()

  // nothing changed while the page was away: the warm open's welcome is the stored copy's point, so no write
  await a.page.reload()
  await waitForCanvas(a.page)
  expect(await cacheState(a.page)).toMatchObject({ painted: true, resumeOutcome: null, welcomed: true })
  // (an idle write would have run by now: its idle callback's timeout is 5 s)
  await new Promise((r) => setTimeout(r, 6_000))
  expect(await cacheWrites(a.page)).toBe(0)
  expect((await cacheRecord(a.page, board, a.id))?.savedAt).toBe(record?.savedAt)

  // an edit, right after a write: hiding the tab writes nothing (the minute is not up), the page going writes it
  expect(await flushBoardCache(a.page)).toBe(true)
  const flushed = await cacheWrites(a.page)
  await settled(a.page, createItem(a.page, 'rectangle', { x: 100, y: 300, width: 120, height: 80 }))
  await setHidden(a.page, true)
  expect(await cacheWrites(a.page)).toBe(flushed)
  await setHidden(a.page, false)
  await a.page.evaluate(() => dispatchEvent(new Event('pagehide')))
  expect(await cacheWrites(a.page)).toBe(flushed + 1)
  await expect
    .poll(async () => (await cacheRecord(a.page, board, a.id))?.count)
    .toBe((record?.count ?? 0) + 1)
})

// ---- M6-4 -----------------------------------------------------------------------------------------------------------

test('M6-4: offline, a member sees their copy read-only with the banner; a copy older than 7 days is not shown', async ({
  browser,
  board,
  users,
}, testInfo) => {
  const alice = await users.get('alice')
  const { context, page } = await onDashboard(browser, alice)
  try {
    const foreign = foreignRequests(page)
    await goInApp(page, `/b/${board}`)
    await waitForCanvas(page)
    const ids = await seedBoard(page)
    expect(await flushBoardCache(page)).toBe(true)
    await goInApp(page, '/')
    await expect(page.getByTestId('lobby-board')).toHaveCount(0)

    await context.setOffline(true)
    await goInApp(page, `/b/${board}`)
    await expect(page.getByTestId('offline-copy')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('offline-copy-banner')).toContainText('Offline · showing your copy from')
    await expect(page.getByTestId('cached-copy-label')).toContainText('Offline · showing your copy from')
    await expect.poll(async () => (await scenePositions(page, '__lobbyOfflineCopy'))?.length).toBe(ids.length)
    // read-only: a drag and Delete change nothing
    const positions = await scenePositions(page, '__lobbyOfflineCopy')
    await dragAcrossCanvas(page)
    await page.keyboard.press('Delete')
    expect(await scenePositions(page, '__lobbyOfflineCopy')).toEqual(positions)
    await expect(page.getByTestId('lobby-board')).toHaveCount(0)

    // a copy older than 7 days is not shown: the screen this case showed before
    await goInApp(page, '/')
    await ageCacheRecord(page, board, alice.id, Date.now() - 8 * 24 * 60 * 60 * 1000)
    await goInApp(page, `/b/${board}`)
    await expect(page.getByTestId('board-load-error')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('offline-copy')).toHaveCount(0)

    // back online: the board opens as usual, by itself (the online event; a few more tries a moment after a failed
    // one; the ticket that went out offline asked again), with no Try again (the W6 review: under load, a click
    // racing that reload once left the page on the error screen)
    await context.setOffline(false)
    const back = Date.now()
    await waitForCanvas(page)
    testInfo.annotations.push({
      type: 'back online',
      description: `the board opened by itself after ${Date.now() - back} ms`,
    })

    // and with Try again clicked while that reload is under way (the review's flake under load: the board's answer
    // is held 1 s here, so the click lands in the race; no cache: ?nocache=1 shows the error screen)
    await goInApp(page, '/')
    await expect(page.getByTestId('lobby-board')).toHaveCount(0)
    await context.setOffline(true)
    await goInApp(page, `/b/${board}?nocache=1`)
    await expect(page.getByTestId('board-load-error')).toBeVisible({ timeout: 30_000 })
    const boardGet = (url: URL) => url.pathname === `/api/boards/${board}`
    await page.route(boardGet, async (route) => {
      await new Promise((r) => setTimeout(r, 1_000))
      await route.continue().catch(() => {})
    })
    await context.setOffline(false)
    await page
      .getByTestId('board-load-error')
      .getByRole('button', { name: 'Try again' })
      .click({ timeout: 5_000 })
    await waitForCanvas(page)
    await page.unroute(boardGet)
    expect(foreign).toEqual([])
  } finally {
    await context.close()
  }
})

test("M6-4: a name-only guest keeps no copy, and offline gets today's screen", async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const ac = await browser.newContext()
  const gc = await browser.newContext()
  try {
    await signInContext(ac, alice.handle, alice.name)
    const alicePage = await ac.newPage()
    const link = await createGuestLink(alicePage, board, 'review')
    const guest = await guestOn(gc, tokenOf(link), 'Gina')
    // a guest's session writes nothing (the welcome says guest)
    expect(await flushBoardCache(guest.page)).toBe(false)
    expect(await cacheRecord(guest.page, board, guest.id)).toBeNull()
    await goInApp(guest.page, '/')
    await expect(guest.page.getByTestId('lobby-board')).toHaveCount(0)
    await gc.setOffline(true)
    await goInApp(guest.page, `/b/${board}`)
    await expect(guest.page.getByTestId('board-load-error')).toBeVisible({ timeout: 30_000 })
    await expect(guest.page.getByTestId('offline-copy')).toHaveCount(0)
    expect(await cacheRecord(guest.page, board, guest.id)).toBeNull()
  } finally {
    await gc.close()
    await ac.close()
  }
})
