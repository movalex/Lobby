// A passive tap on a page's board sockets (CDP's WebSocket events through Playwright's `page.on('websocket')`),
// for diagnostics: which frames a page sent and received, when, of which protocol type, with which clock,
// push seq and reject codes, and whether a frame names a given element id. It adds no hop and changes no
// timing (unlike the relay), so timing-gated specs can keep it on.
//
// Privacy (AGENTS.md, §8.6.7): the socket URL is kept without its query (the ticket), and nothing of a
// frame's content leaves this module except its type, size, clock, seq, reject codes and "mentions id".
// It also turns on the spike board session's own log (`window.__lobbyBoardLog`: the engine core's and the
// transport's events, ids and counts only), which `boardLog` reads.
import type { Page, WebSocket } from '@playwright/test'

export interface WireFrame {
  readonly at: number
  readonly dir: 'in' | 'out'
  /** the protocol message type, `binary` for the snapshot frame, `?` when it is not JSON */
  readonly type: string
  readonly bytes: number
  readonly clock?: number
  readonly seq?: number
  /** reject codes in an ack (per op, and the doc write's) */
  readonly codes?: readonly string[]
  /** the socket (index into `sockets()`) */
  readonly socket: number
}

export interface WireSocket {
  /** the path of the socket URL (no query: the ticket is never kept) */
  readonly path: string
  readonly openedAt: number
  closedAt: number | null
}

export interface WireTap {
  frames(filter?: { after?: number; type?: string; dir?: 'in' | 'out'; mentions?: string }): WireFrame[]
  sockets(): readonly WireSocket[]
  /** the board session's log since the page loaded (ids and counts only), empty before the board page */
  boardLog(): Promise<{ event: string; detail: unknown; at: number }[]>
  stop(): void
}

const TEXT_CAP = 256 * 1024

interface Kept extends WireFrame {
  readonly text: string | null
}

function describe(payload: string | Buffer): {
  type: string
  clock?: number
  seq?: number
  codes?: string[]
  text: string | null
} {
  if (typeof payload !== 'string') return { type: 'binary', text: null }
  try {
    const m = JSON.parse(payload) as {
      type?: string
      clock?: number
      seq?: number
      r?: { code?: string; ok?: boolean }[]
      docDenied?: { code?: string }
    }
    const codes = [
      ...(m.r ?? []).flatMap((r) => (r && typeof r.code === 'string' ? [r.code] : [])),
      ...(m.docDenied?.code ? [m.docDenied.code] : []),
    ]
    return {
      type: typeof m.type === 'string' ? m.type : '?',
      clock: typeof m.clock === 'number' ? m.clock : undefined,
      seq: typeof m.seq === 'number' ? m.seq : undefined,
      codes: codes.length ? codes : undefined,
      text: payload.length <= TEXT_CAP ? payload : null,
    }
  } catch {
    return { type: '?', text: null }
  }
}

/** Starts tapping `page`'s board sockets (`/connect/`); install before the page opens the board. */
export async function wiretap(page: Page, opts: { cap?: number } = {}): Promise<WireTap> {
  const cap = opts.cap ?? 50_000
  const kept: Kept[] = []
  const sockets: WireSocket[] = []
  let on = true
  const push = (f: Kept) => {
    if (!on) return
    kept.push(f)
    if (kept.length > cap) kept.splice(0, kept.length - cap)
  }
  const onSocket = (ws: WebSocket) => {
    const url = new URL(ws.url())
    if (!url.pathname.includes('/connect/')) return
    const socket = sockets.length
    const entry: WireSocket = { path: url.pathname, openedAt: Date.now(), closedAt: null }
    sockets.push(entry)
    ws.on('framereceived', (f) => {
      const d = describe(f.payload)
      push({ at: Date.now(), dir: 'in', bytes: f.payload.length, socket, ...d })
    })
    ws.on('framesent', (f) => {
      const d = describe(f.payload)
      push({ at: Date.now(), dir: 'out', bytes: f.payload.length, socket, ...d })
    })
    ws.on('close', () => {
      entry.closedAt = Date.now()
    })
  }
  page.on('websocket', onSocket)
  await page.addInitScript(() => {
    ;(window as unknown as { __lobbyBoardLog?: unknown[] }).__lobbyBoardLog = []
  })
  return {
    frames(filter = {}) {
      return kept
        .filter(
          (f) =>
            (filter.after === undefined || f.at >= filter.after) &&
            (filter.type === undefined || f.type === filter.type) &&
            (filter.dir === undefined || f.dir === filter.dir) &&
            (filter.mentions === undefined || f.text?.includes(`"${filter.mentions}"`) === true),
        )
        .map(({ text: _text, ...f }) => f)
    },
    sockets: () => sockets.map((s) => ({ ...s })),
    async boardLog() {
      return page
        .evaluate(
          () =>
            ((window as unknown as { __lobbyBoardLog?: { event: string; detail: unknown; at: number }[] })
              .__lobbyBoardLog ?? []) as { event: string; detail: unknown; at: number }[],
        )
        .catch(() => [])
    },
    stop() {
      on = false
      page.off('websocket', onSocket)
    },
  }
}

/** Counts of `frames` by direction and type (for evidence). */
export function frameCounts(frames: readonly WireFrame[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of frames) out[`${f.dir}:${f.type}`] = (out[`${f.dir}:${f.type}`] ?? 0) + 1
  return out
}
