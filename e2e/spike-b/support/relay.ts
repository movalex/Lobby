// The board-socket relay of a spike B browser page (docs/EXCALIDRAW-MIGRATION.md §8.6.2 TestHooks): a
// Playwright `routeWebSocket` on the page's `/connect/:board` socket that forwards every frame between the
// page and the real sync server, and on demand
//
//  - delays every frame by ms/2 each way, order kept (`withLatency`, U9; L6/L10 commit orders);
//  - cuts the socket (`cutSocket`, D5, D6, L7): the live socket is closed on both sides (the page sees
//    code 1012, a server restart, so it reconnects as after a network drop), and the page's reconnects
//    are HELD: the route accepts them without connecting to the server, never answers, and records what
//    the page sends on them (D5's "the old page pushed nothing after the cut"). `mode: 'refuse'` closes
//    each reconnect at once instead;
//  - restores it (`restoreSocket`): new sockets go through again. By default the held sockets are closed
//    too, so the page reconnects now (L7); `release: false` leaves them held until the page unloads
//    (D5: "the route holds the old page's reconnect until the page unloads", so a reload must restore
//    the queue from IndexedDB).
//
// Offline is socket-only: apps/web has no service worker and a page cannot load with the whole network
// off, so `context.setOffline` is never used (§8.3 D5). Routes apply to sockets opened after the route,
// so the harness attaches the relay before the page opens the board (launchBrowser; `attachRelay` for an
// extra tab). Forge sockets (sessionId `forge-*`, forge.ts) are passed straight through: never delayed,
// never cut. Timing-gated measurements (B9's visibility, §8.4) launch without the relay.
import type { Page, WebSocketRoute } from '@playwright/test'

/** A board socket's URL: `/connect/:boardId?sessionId=…&ticket=…` (the ticket never leaves this module). */
export const CONNECT_URL = /\/connect\/[^/?#]+(?:[?#]|$)/
export const FORGE_SESSION_PREFIX = 'forge-'

export type CutMode = 'hold' | 'refuse'

/** A frame the page sent on a held socket (only the message type is kept; bodies may carry board text). */
export interface HeldFrame {
  readonly at: number
  readonly type: string
  readonly bytes: number
}

export interface RelayStats {
  readonly connects: number
  readonly heldConnects: number
  readonly refusedConnects: number
  readonly cuts: number
  readonly latencyMs: number
  readonly cut: CutMode | null
  readonly live: number
  readonly held: number
  /** what the page sent on held sockets since the last cut */
  readonly framesWhileCut: readonly HeldFrame[]
}

interface Queue {
  items: { at: number; run: () => void }[]
  timer: ReturnType<typeof setTimeout> | null
}

interface Conn {
  readonly page: WebSocketRoute
  readonly server: WebSocketRoute | null
  readonly held: boolean
  open: boolean
  readonly up: Queue
  readonly down: Queue
  lastUp: number
  lastDown: number
}

interface RelayState {
  latencyMs: number
  cut: CutMode | null
  conns: Set<Conn>
  framesWhileCut: HeldFrame[]
  connects: number
  heldConnects: number
  refusedConnects: number
  cuts: number
}

const states = new WeakMap<Page, RelayState>()

const newQueue = (): Queue => ({ items: [], timer: null })

function pump(q: Queue): void {
  if (q.timer) return
  const step = () => {
    q.timer = null
    const now = Date.now()
    while (q.items.length > 0 && (q.items[0]?.at ?? 0) <= now) q.items.shift()?.run()
    const head = q.items[0]
    if (head) q.timer = setTimeout(step, Math.max(0, head.at - Date.now()))
  }
  step()
}

/** Schedules `run` ms/2 after now, never before an earlier frame of the same direction (order kept). */
function schedule(st: RelayState, conn: Conn, dir: 'up' | 'down', run: () => void): void {
  const now = Date.now()
  const last = dir === 'up' ? conn.lastUp : conn.lastDown
  const at = Math.max(now + st.latencyMs / 2, last)
  if (dir === 'up') conn.lastUp = at
  else conn.lastDown = at
  const q = dir === 'up' ? conn.up : conn.down
  q.items.push({ at, run })
  pump(q)
}

/** A close code a route may send to the page or the server (1005, 1006 and 1015 are never sent). */
function sendableCode(code: number | undefined): number | undefined {
  if (code === undefined) return undefined
  if (code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014)) return code
  if (code >= 3000 && code <= 4999) return code
  return undefined
}

function closeSide(side: WebSocketRoute | null, code: number | undefined, reason: string | undefined): void {
  if (!side) return
  const c = sendableCode(code)
  try {
    side.close(c === undefined ? undefined : { code: c, reason: (reason ?? '').slice(0, 120) })
  } catch {
    // already closed
  }
}

const frameType = (m: string | Buffer): string => {
  if (typeof m !== 'string') return 'binary'
  const t = /"type"\s*:\s*"([a-z.]{1,32})"/.exec(m.slice(0, 200))
  return t?.[1] ?? 'unknown'
}
const frameBytes = (m: string | Buffer) => (typeof m === 'string' ? Buffer.byteLength(m) : m.byteLength)

function isForge(url: string): boolean {
  try {
    return new URL(url).searchParams.get('sessionId')?.startsWith(FORGE_SESSION_PREFIX) === true
  } catch {
    return false
  }
}

function hold(st: RelayState, ws: WebSocketRoute): void {
  st.heldConnects++
  const conn: Conn = {
    page: ws,
    server: null,
    held: true,
    open: true,
    up: newQueue(),
    down: newQueue(),
    lastUp: 0,
    lastDown: 0,
  }
  st.conns.add(conn)
  ws.onMessage((m) => {
    st.framesWhileCut.push({ at: Date.now(), type: frameType(m), bytes: frameBytes(m) })
  })
  ws.onClose(() => {
    conn.open = false
    st.conns.delete(conn)
  })
}

function relay(st: RelayState, ws: WebSocketRoute): void {
  st.connects++
  const server = ws.connectToServer()
  const conn: Conn = {
    page: ws,
    server,
    held: false,
    open: true,
    up: newQueue(),
    down: newQueue(),
    lastUp: 0,
    lastDown: 0,
  }
  st.conns.add(conn)
  ws.onMessage((m) =>
    schedule(st, conn, 'up', () => {
      if (conn.open) server.send(m)
    }),
  )
  server.onMessage((m) =>
    schedule(st, conn, 'down', () => {
      if (conn.open) ws.send(m)
    }),
  )
  ws.onClose((code, reason) =>
    schedule(st, conn, 'up', () => {
      if (!conn.open) return
      conn.open = false
      st.conns.delete(conn)
      closeSide(server, code, reason)
    }),
  )
  server.onClose((code, reason) =>
    schedule(st, conn, 'down', () => {
      if (!conn.open) return
      conn.open = false
      st.conns.delete(conn)
      closeSide(ws, code, reason)
    }),
  )
}

/** Routes the page's board sockets through the relay (idempotent). Call before the page opens the board. */
export async function attachRelay(page: Page): Promise<void> {
  if (states.has(page)) return
  const st: RelayState = {
    latencyMs: 0,
    cut: null,
    conns: new Set(),
    framesWhileCut: [],
    connects: 0,
    heldConnects: 0,
    refusedConnects: 0,
    cuts: 0,
  }
  states.set(page, st)
  await page.routeWebSocket(CONNECT_URL, (ws) => {
    if (isForge(ws.url())) {
      ws.connectToServer() // no handlers: Playwright forwards both ways
      return
    }
    if (st.cut === 'hold') return hold(st, ws)
    if (st.cut === 'refuse') {
      st.refusedConnects++
      closeSide(ws, 1012, 'spike-b cut')
      return
    }
    relay(st, ws)
  })
}

function stateOf(page: Page): RelayState {
  const st = states.get(page)
  if (!st)
    throw new Error(
      'this page has no socket relay: launch it with the relay (the default) or call attachRelay(page) before it opens the board',
    )
  return st
}

export function hasRelay(page: Page): boolean {
  return states.has(page)
}

/** Delays every frame by ms/2 each way from now on (open sockets included); returns the removal. */
export function setLatency(page: Page, ms: number): () => Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('latency must be a non-negative number of ms')
  const st = stateOf(page)
  st.latencyMs = ms
  return async () => {
    if (st.latencyMs === ms) st.latencyMs = 0
  }
}

/** Cuts the page's board socket; its reconnects are held (default) or refused until `restore`. */
export async function cut(page: Page, opts: { mode?: CutMode } = {}): Promise<void> {
  const st = stateOf(page)
  st.cut = opts.mode ?? 'hold'
  st.cuts++
  st.framesWhileCut = []
  for (const conn of [...st.conns]) {
    if (conn.held) continue
    conn.open = false
    st.conns.delete(conn)
    closeSide(conn.server, 1000, 'spike-b cut')
    closeSide(conn.page, 1012, 'spike-b cut')
  }
}

/** Lets new sockets through again; closes the held ones unless `release: false` (D5). */
export async function restore(page: Page, opts: { release?: boolean } = {}): Promise<void> {
  const st = stateOf(page)
  st.cut = null
  if (opts.release === false) return
  for (const conn of [...st.conns]) {
    if (!conn.held) continue
    conn.open = false
    st.conns.delete(conn)
    closeSide(conn.page, 1012, 'spike-b restore')
  }
}

export function relayStats(page: Page): RelayStats {
  const st = stateOf(page)
  const conns = [...st.conns]
  return {
    connects: st.connects,
    heldConnects: st.heldConnects,
    refusedConnects: st.refusedConnects,
    cuts: st.cuts,
    latencyMs: st.latencyMs,
    cut: st.cut,
    live: conns.filter((c) => !c.held).length,
    held: conns.filter((c) => c.held).length,
    framesWhileCut: [...st.framesWhileCut],
  }
}
