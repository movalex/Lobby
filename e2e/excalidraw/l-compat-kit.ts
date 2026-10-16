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
//
// Wave N (CONTRACTS_REV 13): the deployed web is 3c83611 (rev 12; frozen in
// packages/canvas-schema/test/fixtures/rev12-3c83611). Its tabs are opened with `{ schemas: REV12_SCHEMAS }`
// (n-compat-rev12.spec.ts), or left unrelayed and watched with `watchOldSocket` (CDP: the browser's own socket, so
// permessage-deflate is negotiated with the sync itself, and every frame is still parsed with the old schemas):
//
//   git archive 3c83611 | tar -x -C <dir> && cd <dir> && pnpm install --frozen-lockfile --offline --ignore-scripts
//   VITE_DRAFTROOM_DEV_AUTH=1 GIT_COMMIT=3c83611e5c2b pnpm --filter @draftroom/web exec vite build --outDir <dist>
//   cd <this tree>/e2e && E2E_OLD_WEB_DIST=<dist> E2E_OLD_WEB_COMMIT=3c83611 E2E_PORT_BASE=<base> \
//     pnpm exec playwright test excalidraw/n-compat-rev12.spec.ts --project=chromium --workers=1
//
// Wave T (CONTRACTS_REV 14): the deployed web is 6769e07 (rev 13, wave S; frozen in
// packages/canvas-schema/test/fixtures/rev13-6769e07, whose canvas-schema is the deployed sync ba1704c's too). Its
// tabs are opened with `{ schemas: REV13_SCHEMAS }` or watched with `watchOldSocket(page, REV13_SCHEMAS)`
// (WS1's t-compat-rev13.spec.ts; the run's sync needs DRAFTROOM_PLANNING=on through syncEnv for the room to say 14):
//
//   git archive 6769e07 | tar -x -C <dir> && cd <dir> && pnpm install --frozen-lockfile --offline --ignore-scripts
//   VITE_DRAFTROOM_DEV_AUTH=1 GIT_COMMIT=6769e07220a6 pnpm --filter @draftroom/web exec vite build --outDir <dist>
//   cd <this tree>/e2e && E2E_OLD_WEB_DIST=<dist> E2E_OLD_WEB_COMMIT=6769e07 E2E_PORT_BASE=<base> //     pnpm exec playwright test excalidraw/t-compat-rev13.spec.ts --project=chromium --workers=1
//
// The other stale pairs of the bump: the new web against the DEPLOYED sync (E2E_SYNC_ENTRY: the ba1704c tree's
// apps/sync/src/server.ts, e2e/tests/support/stack.ts), and, at the protocol level, the sync's stale-reader and
// rollback tests with DRAFTROOM_OLD_WEB_SRC (the 6769e07 sources with node_modules) and DRAFTROOM_OLD_SYNC_SRC (the
// ba1704c sources).

import { existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { type Browser, type BrowserContext, expect, type Page, type WebSocketRoute } from '@playwright/test'
import * as Rev11 from '../../packages/canvas-schema/test/fixtures/rev11-437b4e7/protocol.ts'
import * as Rev12 from '../../packages/canvas-schema/test/fixtures/rev12-3c83611/protocol.ts'
import * as Rev13 from '../../packages/canvas-schema/test/fixtures/rev13-6769e07/protocol.ts'
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

/** How a previous build parses the room's frames: its own frozen `ServerMessage` and snapshot decoder. */
export interface OldFrameSchemas {
  readonly ServerMessage: {
    safeParse(v: unknown): {
      success: boolean
      error?: { issues: { message: string; path: PropertyKey[] }[] }
    }
  }
  readonly decodeSnapshotFrame: (bytes: Uint8Array) => Promise<unknown>
}
/** The rev-11 web (437b4e7): l-compat-rev11.spec.ts. */
export const REV11_SCHEMAS: OldFrameSchemas = Rev11 as unknown as OldFrameSchemas
/** The rev-12 web deployed since hotfix H2 (3c83611): n-compat-rev12.spec.ts. */
export const REV12_SCHEMAS: OldFrameSchemas = Rev12 as unknown as OldFrameSchemas
/** The rev-13 web deployed since wave S (6769e07): WS1's t-compat-rev13.spec.ts (wave T, CONTRACTS_REV 14). */
export const REV13_SCHEMAS: OldFrameSchemas = Rev13 as unknown as OldFrameSchemas

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
export async function droppedBy(
  m: string | Buffer,
  schemas: OldFrameSchemas = REV11_SCHEMAS,
): Promise<string | null> {
  if (typeof m !== 'string') {
    try {
      await schemas.decodeSnapshotFrame(new Uint8Array(m.buffer, m.byteOffset, m.byteLength))
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
  const r = schemas.ServerMessage.safeParse(json)
  if (r.success) return null
  const i = r.error?.issues[0]
  return `${i?.message ?? 'invalid'} at ${(i?.path ?? []).join('.')}`
}

/**
 * Opens `board` as `user` in the previous build (see the header); waits for its canvas and its welcome. Its frames
 * are parsed with `o.schemas` (default: the rev-11 web's).
 */
export async function openOldTab(
  browser: Browser,
  board: string,
  user: TestUser,
  o: { schemas?: OldFrameSchemas } = {},
): Promise<OldTab> {
  const schemas = o.schemas ?? REV11_SCHEMAS
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
      void droppedBy(m, schemas).then((issue) => {
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

// ---- an unrelayed previous build's tab, watched through CDP (wave N) -----------------------------------------------

/** What the browser's own board socket of a previous build's tab did (CDP), every frame parsed with its schemas. */
export interface OldSocketWatch {
  /** the connect URL of every board socket the page opened (a reconnect is a second one) */
  readonly connectUrls: string[]
  /** Sec-WebSocket-Extensions of every board socket handshake */
  readonly extensions: string[]
  /** server frames its schemas refuse (its socket drops each one whole) */
  readonly dropped: DroppedFrame[]
  /** every server text frame, in order */
  readonly frames: string[]
  /** the type of every frame the page SENT (`push`, `presence`, `hello`, …) */
  readonly sent: string[]
  /** CLOSING notices the page received (the room sends one before every terminal close, INVALID_MESSAGE included) */
  readonly closing: string[]
  /** resolves once every frame received so far has been parsed */
  settled(): Promise<void>
}

/**
 * Watches a page's board sockets through CDP (call before it opens the board). Not a relay: the browser talks to
 * the sync itself, so permessage-deflate is negotiated as in production, and CDP hands over each frame as the page
 * gets it (inflated); text frames are parsed with `schemas`, the binary snapshot decoded with them.
 */
export async function watchOldSocket(page: Page, schemas: OldFrameSchemas): Promise<OldSocketWatch> {
  const pending: Promise<void>[] = []
  const w: OldSocketWatch = {
    connectUrls: [],
    extensions: [],
    dropped: [],
    frames: [],
    sent: [],
    closing: [],
    settled: async () => {
      await Promise.all(pending)
    },
  }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const boardSockets = new Set<string>()
  cdp.on('Network.webSocketCreated', (e) => {
    if (!/\/connect\//.test(e.url)) return
    boardSockets.add(e.requestId)
    w.connectUrls.push(e.url)
  })
  cdp.on('Network.webSocketHandshakeResponseReceived', (e) => {
    if (!boardSockets.has(e.requestId)) return
    const h = e.response.headers as Record<string, string>
    w.extensions.push(
      Object.entries(h).find(([k]) => k.toLowerCase() === 'sec-websocket-extensions')?.[1] ?? '',
    )
  })
  cdp.on('Network.webSocketFrameReceived', (e) => {
    if (!boardSockets.has(e.requestId)) return
    const { opcode, payloadData } = e.response
    const m = opcode === 2 ? Buffer.from(payloadData, 'base64') : payloadData
    const type = typeof m === 'string' ? typeOf(m) : 'snapshot'
    if (typeof m === 'string') {
      w.frames.push(m)
      if (m.startsWith('{"type":"notice"') && m.includes('"CLOSING"')) w.closing.push(m.slice(0, 200))
    }
    const bytes = typeof m === 'string' ? Buffer.byteLength(m) : m.byteLength
    pending.push(
      droppedBy(m, schemas).then((issue) => {
        if (issue) w.dropped.push({ type, issue, bytes })
      }),
    )
  })
  cdp.on('Network.webSocketFrameSent', (e) => {
    if (!boardSockets.has(e.requestId)) return
    w.sent.push(typeOf(e.response.payloadData))
  })
  return w
}
