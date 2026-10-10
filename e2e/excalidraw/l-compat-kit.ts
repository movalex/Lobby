// The stale-client pair with a REAL previous build (wave L, the integration's stale pair (c) and its follow-up 1;
// docs/EXCALIDRAW-CONTRACTS.md §0b, the per-reader downgrade rule). A tab of the web deployed before the bump (the
// 437b4e7 build, CONTRACTS_REV 11, built with dev auth so it has the facade) runs beside this tree's web on ONE web
// origin, so the api's and the sync's Origin checks hold for both:
//  - its browser context serves every page and asset request from that build's dist folder (Playwright routes);
//    `/api`, `/files` and the board socket go to this run's real api and sync, as for any other tab;
//  - its board socket is relayed, and EVERY frame the room sends it is parsed with that build's own frozen schemas
//    (packages/canvas-schema/test/fixtures/rev11-437b4e7: what its socket transport runs), so a frame its socket
//    would have dropped is named; the relay can also cut the socket and hold its reconnects (an offline window);
//  - its connect URLs are kept (an older build names no contracts revision: no `rev`).
//
// Build the previous web once (outside the repo; nothing of it is committed), then name its dist folder:
//
//   git archive 437b4e7 | tar -x -C <dir>                         # the deployed web's sources
//   cd <dir> && pnpm install --frozen-lockfile --offline           # the same lockfile: the local store has it
//   VITE_DRAFTROOM_DEV_AUTH=1 GIT_COMMIT=437b4e7f66b5 pnpm --filter @draftroom/web exec vite build --outDir <dist>
//   cd <this tree>/e2e && E2E_OLD_WEB_DIST=<dist> E2E_PORT_BASE=<base> \
//     pnpm exec playwright test excalidraw/l-compat-rev11.spec.ts --project=chromium --workers=1
//
// Without E2E_OLD_WEB_DIST the specs that need it are skipped (they say so). For the next bump, freeze the build
// that is deployed then (its canvas-schema as a new fixture) and point E2E_OLD_WEB_DIST at its web.

import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { type Browser, type BrowserContext, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { hashElements } from '../../packages/canvas-schema/src/hash.ts'
import * as Old from '../../packages/canvas-schema/test/fixtures/rev11-437b4e7/protocol.ts'
import { CONNECT_URL } from '../spike-b/support/relay.ts'
import { signInContext } from '../tests/support/api.ts'
import { type CanvasSession, canvasCall, hash, waitForCanvas } from '../tests/support/canvas.ts'
import { serverSnapshot } from '../tests/support/excalidraw.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import type { Stack } from '../tests/support/stack.ts'
import type { TestUser } from '../tests/support/users.ts'

/** The previous web's built dist folder (E2E_OLD_WEB_DIST), or null when this run has none. */
export const OLD_WEB_DIST: string | null = process.env.E2E_OLD_WEB_DIST
  ? resolve(process.env.E2E_OLD_WEB_DIST)
  : null
/**
 * The browser these specs need: a page that a route fulfilled has no IP address space for Chromium's Local Network
 * Access checks (it reads as public), so its socket to the run's loopback origin is blocked
 * (net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS) while the same socket from this tree's page, served by the
 * preview server, is not. The check is off for these specs' browser (test.use({ launchOptions })).
 */
export const OLD_WEB_LAUNCH = { args: ['--disable-features=LocalNetworkAccessChecks'] }
/** Which build that is (for the annotations; the fixture's commit). */
export const OLD_WEB_COMMIT = process.env.E2E_OLD_WEB_COMMIT ?? '437b4e7'
export const OLD_WEB_SKIP_REASON =
  'needs a build of the previous web: set E2E_OLD_WEB_DIST (how to build it: e2e/excalidraw/l-compat-kit.ts)'

const SERVED_BY_THE_STACK = /^\/(?:api|files|connect)(?:\/|$)/

/** Serves every page and asset request of `context` on the run's web origin from `dist` (an SPA: index.html). */
export async function serveOldWeb(context: BrowserContext, dist: string, served: string[]): Promise<void> {
  const origin = new URL(WEB_URL).origin
  const root = normalize(dist)
  await context.route(
    (url) => url.origin === origin && !SERVED_BY_THE_STACK.test(url.pathname),
    async (route) => {
      const path = decodeURIComponent(new URL(route.request().url()).pathname)
      const file = normalize(join(root, path))
      const inside = file === root || file.startsWith(root + sep)
      if (inside && existsSync(file) && statSync(file).isFile()) {
        served.push(path)
        return route.fulfill({ path: file })
      }
      // a missing asset is a 404 (as the static site answers under /excalidraw-assets/), a page is the app
      if (extname(path) || path.startsWith('/assets/') || path.startsWith('/excalidraw-assets/'))
        return route.fulfill({ status: 404, body: '' })
      served.push(`${path} -> /index.html`)
      return route.fulfill({ path: join(root, 'index.html') })
    },
  )
}

/** A frame the previous build's socket would have dropped: its type and the first schema issue. */
export interface DroppedFrame {
  readonly type: string
  readonly issue: string
  readonly bytes: number
}

/** What the relay saw of the previous build's board socket. */
export interface OldSocketLog {
  /** server frames the previous build's schemas refuse (its socket drops each one whole) */
  readonly dropped: DroppedFrame[]
  /** server frames relayed, by type (`snapshot` for the binary one) */
  readonly types: Map<string, number>
  /** every server text frame relayed, in order (for the reader's checks: never board text in a report) */
  readonly frames: string[]
  /** the connect URL of every socket the page opened */
  readonly connectUrls: string[]
}

interface RelayConn {
  readonly page: WebSocketRoute
  readonly server: WebSocketRoute | null
  open: boolean
}

/** One tab of the previous build, on the run's web origin, its board socket relayed and checked. */
export interface OldTab extends CanvasSession {
  readonly socket: OldSocketLog
  /** page errors (uncaught exceptions) in the previous build's page */
  readonly pageErrors: string[]
  /** request paths served from the previous build's dist (proof the page is that build) */
  readonly served: string[]
  /** a network drop for its board socket: closed, and its reconnects held until `restore` */
  cut(): Promise<void>
  /** the network is back: held reconnects are closed, so the page reconnects now */
  restore(): Promise<void>
}

const typeOf = (text: string): string => /"type"\s*:\s*"([a-z.]{1,32})"/.exec(text.slice(0, 200))?.[1] ?? '?'

/** Parses one server frame as the previous build's socket does; returns why it would drop it, or null. */
async function droppedBy(m: string | Buffer): Promise<string | null> {
  if (typeof m !== 'string') {
    try {
      await Old.decodeSnapshotFrame(new Uint8Array(m.buffer, m.byteOffset, m.byteLength))
      return null
    } catch (e) {
      return `snapshot: ${String(e).slice(0, 200)}`
    }
  }
  let json: unknown
  try {
    json = JSON.parse(m)
  } catch {
    return 'not JSON'
  }
  const r = Old.ServerMessage.safeParse(json)
  if (r.success) return null
  const i = r.error.issues[0]
  return `${i?.message ?? 'invalid'} at ${(i?.path ?? []).join('.')}`
}

/** Opens `board` as `user` in the previous build (see the header); waits for its canvas and its welcome. */
export async function openOldTab(browser: Browser, board: string, user: TestUser): Promise<OldTab> {
  if (!OLD_WEB_DIST) throw new Error(OLD_WEB_SKIP_REASON)
  const context = await browser.newContext()
  const served: string[] = []
  await serveOldWeb(context, OLD_WEB_DIST, served)
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
  const socket: OldSocketLog = { dropped: [], types: new Map(), frames: [], connectUrls: [] }
  const conns = new Set<RelayConn>()
  let holding = false
  await page.routeWebSocket(CONNECT_URL, (ws) => {
    socket.connectUrls.push(ws.url())
    if (holding) {
      // a reconnect while the network is down: accepted, never connected, never answered
      const conn: RelayConn = { page: ws, server: null, open: true }
      conns.add(conn)
      ws.onMessage(() => {})
      ws.onClose(() => {
        conn.open = false
        conns.delete(conn)
      })
      return
    }
    const server = ws.connectToServer()
    const conn: RelayConn = { page: ws, server, open: true }
    conns.add(conn)
    ws.onMessage((m) => {
      if (conn.open) server.send(m)
    })
    server.onMessage((m) => {
      if (!conn.open) return
      const type = typeof m === 'string' ? typeOf(m) : 'snapshot'
      socket.types.set(type, (socket.types.get(type) ?? 0) + 1)
      if (typeof m === 'string') socket.frames.push(m)
      const bytes = typeof m === 'string' ? Buffer.byteLength(m) : m.byteLength
      void droppedBy(m).then((issue) => {
        if (issue) socket.dropped.push({ type, issue, bytes })
      })
      ws.send(m)
    })
    ws.onClose((code, reason) => {
      if (!conn.open) return
      conn.open = false
      conns.delete(conn)
      server.close({ code: closable(code), reason })
    })
    server.onClose((code, reason) => {
      if (!conn.open) return
      conn.open = false
      conns.delete(conn)
      ws.close({ code: closable(code), reason })
    })
  })
  await signInContext(context, user.handle, user.name)
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  await expect
    .poll(async () => (await canvasCall(page, 'me'))?.uid, { message: 'the welcome names this user' })
    .toBe(user.id)
  return {
    user: user.handle,
    name: user.name,
    id: user.id,
    context,
    page,
    socket,
    pageErrors,
    served,
    async cut() {
      holding = true
      for (const c of [...conns]) {
        if (!c.server) continue
        c.open = false
        conns.delete(c)
        try {
          c.server.close({ code: 1000, reason: 'e2e cut' })
        } catch {}
        try {
          c.page.close({ code: 1012, reason: 'e2e cut' })
        } catch {}
      }
    },
    async restore() {
      holding = false
      for (const c of [...conns]) {
        if (c.server) continue
        c.open = false
        conns.delete(c)
        try {
          c.page.close({ code: 1012, reason: 'e2e restore' })
        } catch {}
      }
    },
  }
}

/** A close code a route may send (1005, 1006 and 1015 are never sent on the wire). */
const closable = (code: number | undefined): number | undefined =>
  code === undefined || code === 1005 || code === 1006 || code === 1015 || code < 1000 ? undefined : code

/**
 * The previous build's tab holds exactly the server's board (the convergence hash, tombstones included), every
 * `others` tab too, and its socket dropped no frame; polled until the hashes agree.
 */
export async function expectOldTabHolds(
  stack: Stack,
  board: string,
  old: OldTab,
  others: readonly Page[],
  timeout = 20_000,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const want = (await serverSnapshot(stack, board)).hash
        const got = await Promise.all([hash(old.page), ...others.map((p) => hash(p))])
        return got.filter((h) => h !== want).length
      },
      { timeout, message: 'every tab (the previous build included) holds the server’s board' },
    )
    .toBe(0)
  expect(old.socket.dropped, 'frames the previous build’s socket would drop').toEqual([])
  expect(old.pageErrors, 'page errors in the previous build').toEqual([])
}

/** The convergence hash of the server's live elements and tombstones (hash.ts), for messages. */
export const hashOf = (els: readonly unknown[]) => hashElements(els as never)
