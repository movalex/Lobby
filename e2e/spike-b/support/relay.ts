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
//  - drops every frame from the server to the page while armed (`dropDown`, RCPT-2): the page's pushes still
//    reach the room, their acks and the room's `changes` never reach the page (a lost ack);
//  - holds every frame from the server to the page, in order, from the moment the page sends a frame a
//    predicate picks (`holdDown`, hotfix H2): that frame's answers (the room's `changes` echo and its `ack`)
//    and everything behind them arrive late, as over a slow network, while the page's own frames still go
//    up at once; released by the test or after a time limit. `watchUp` reports each frame the page sends;
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

/**
 * A board socket's URL: `/connect/:boardId?sessionId=…` (the board page and the forge sockets send the ticket in
 * the offered subprotocol since L7; an old-style `&ticket=…` would match too, and never leaves this module).
 */
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
  /** server frames dropped by `dropDown` (their types; bodies may carry board text) */
  readonly droppedDown: readonly string[]
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
  /** drop every server frame to the page while true (RCPT-2) */
  dropDown: boolean
  droppedDown: string[]
  /** H2: the armed or running down-hold (holdDown), or null */
  downHold: DownHoldState | null
  /** H2: every frame the page sends on a relayed socket, in order (watchUp) */
  upWatchers: Set<(frame: string | Buffer) => void>
}

interface DownHoldState {
  /** picks the page frame that starts the hold (the hold is armed until then) */
  readonly when: (frame: string | Buffer) => boolean
  /** the page sent the frame: server frames are held from here on */
  running: boolean
  /** the held deliveries, in order */
  readonly queue: (() => void)[]
  readonly types: string[]
  timer: ReturnType<typeof setTimeout> | null
  readonly start: () => void
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
  ws.onMessage((m) => {
    for (const w of [...st.upWatchers]) w(m)
    // H2: the hold starts before the frame goes up, so every answer to it is held
    const h = st.downHold
    if (h && !h.running && h.when(m)) h.start()
    schedule(st, conn, 'up', () => {
      if (conn.open) server.send(m)
    })
  })
  server.onMessage((m) =>
    schedule(st, conn, 'down', () => {
      if (!conn.open) return
      if (st.dropDown) {
        st.droppedDown.push(frameType(m))
        return
      }
      const h = st.downHold
      if (h?.running) {
        h.types.push(frameType(m))
        h.queue.push(() => {
          if (conn.open) ws.send(m)
        })
        return
      }
      ws.send(m)
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
    dropDown: false,
    droppedDown: [],
    downHold: null,
    upWatchers: new Set(),
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

/**
 * RCPT-2: while `on`, every frame the server sends this page's board socket is dropped (the page's own frames
 * still go up): a push lands and its ack is lost. Returns the types dropped so far.
 */
export function dropDown(page: Page, on: boolean): readonly string[] {
  const st = stateOf(page)
  st.dropDown = on
  if (on) st.droppedDown = []
  return [...st.droppedDown]
}

/** A hold of a page's server frames (holdDown). */
export interface DownHold {
  /** resolves when the page sent the frame that started the hold (held from then on) */
  readonly started: Promise<void>
  /** the types of the server frames held so far (bodies may carry board text) */
  held(): readonly string[]
  /** lets every held frame through now, in order, and ends the hold (the time limit does the same) */
  release(): void
}

/**
 * H2 (the lost words): from the moment this page sends a frame `when` picks (default: at once), every frame
 * the server sends its board socket is held, in order, until `release()` or `ms` later (default 300 ms):
 * the room's answers to that frame (its `changes` echo, its `ack`) and all frames behind them reach the page
 * late, as over a slow network; the page's own frames still go up at once. One hold per page at a time.
 */
export function holdDown(
  page: Page,
  opts: { when?: (frame: string | Buffer) => boolean; ms?: number } = {},
): DownHold {
  const st = stateOf(page)
  if (st.downHold) throw new Error('this page already has a down-hold: release it first')
  const ms = opts.ms ?? 300
  if (!Number.isFinite(ms) || ms <= 0) throw new Error('a hold needs a positive time limit (ms)')
  let resolveStarted: () => void = () => {}
  const started = new Promise<void>((r) => {
    resolveStarted = r
  })
  const end = () => {
    if (st.downHold !== h) return
    st.downHold = null
    if (h.timer) clearTimeout(h.timer)
    h.timer = null
    for (const run of h.queue.splice(0)) run()
  }
  const h: DownHoldState = {
    when: opts.when ?? (() => true),
    running: false,
    queue: [],
    types: [],
    timer: null,
    start: () => {
      h.running = true
      h.timer = setTimeout(end, ms)
      resolveStarted()
    },
  }
  st.downHold = h
  if (!opts.when) h.start()
  return { started, held: () => [...h.types], release: end }
}

/** Calls `fn` with every frame this page sends on a relayed board socket, in order; returns the removal. */
export function watchUp(page: Page, fn: (frame: string | Buffer) => void): () => void {
  const st = stateOf(page)
  st.upWatchers.add(fn)
  return () => {
    st.upWatchers.delete(fn)
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
    droppedDown: [...st.droppedDown],
  }
}
