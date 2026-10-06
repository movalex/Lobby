// The spike B verifier V1's probe helpers (part-3 round), adopted with its regressions: A WebSocket proxy that can drop server->client
// frames (a lost ack) and cut the connection; headless clients on the real engine core.
import type { AddressInfo } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import {
  createLobbyHeadlessClient,
  type LobbyHeadlessClient,
} from '../../../web/src/canvas/sync/headless/index.ts'
import { ticketFor } from '../element-room/support/client.ts'
import { TicketWebSocket } from '../harness/tickets.ts'

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface Proxy {
  readonly url: string
  /** drop every server->client frame while true */
  dropDown: boolean
  /** drop every client->server frame while true */
  dropUp: boolean
  /** delays every client->server frame by this many ms (order kept) */
  delayUpMs: number
  /** frames dropped so far (server->client) */
  dropped: string[]
  /** terminates every proxied connection (the client sees 1006 and reconnects) */
  cutAll(): void
  close(): Promise<void>
}

export async function startProxy(upstreamWs: string): Promise<Proxy> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((r) => wss.once('listening', () => r()))
  const conns: { client: WebSocket; up: WebSocket }[] = []
  const p: Proxy = {
    url: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    dropDown: false,
    dropUp: false,
    delayUpMs: 0,
    dropped: [],
    cutAll() {
      for (const c of conns.splice(0)) {
        try {
          c.client.terminate()
        } catch {}
        try {
          c.up.terminate()
        } catch {}
      }
    },
    async close() {
      p.cutAll()
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }
  wss.on('connection', (client, req) => {
    // the offered subprotocols go upstream as the client offered them (L7: the ticket travels in one)
    const offered = req.headers['sec-websocket-protocol']
    const protocols =
      typeof offered === 'string'
        ? offered
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean)
        : []
    const up = protocols.length
      ? new WebSocket(upstreamWs + (req.url ?? ''), protocols)
      : new WebSocket(upstreamWs + (req.url ?? ''))
    const pending: [WebSocket.RawData, boolean][] = []
    conns.push({ client, up })
    up.on('open', () => {
      for (const [d, b] of pending.splice(0)) up.send(d, { binary: b })
    })
    client.on('message', (d, isBinary) => {
      if (p.dropUp) return
      if (p.delayUpMs > 0) {
        const wait = p.delayUpMs
        setTimeout(() => {
          if (up.readyState === WebSocket.OPEN) up.send(d, { binary: isBinary })
        }, wait)
        return
      }
      if (up.readyState === WebSocket.OPEN) up.send(d, { binary: isBinary })
      else pending.push([d, isBinary])
    })
    up.on('message', (d, isBinary) => {
      if (p.dropDown) {
        if (!isBinary) p.dropped.push(d.toString())
        return
      }
      if (client.readyState === WebSocket.OPEN) client.send(d, { binary: isBinary })
    })
    client.on('close', () => up.close())
    client.on('error', () => {})
    up.on('error', () => {})
    up.on('close', (code, reason) => {
      try {
        client.close(code === 1005 || code === 1006 ? 1000 : code, reason)
      } catch {}
    })
  })
  return p
}

export function headless(
  syncUrl: string,
  boardId: string,
  user: string,
  tab = `tab-${user}`,
): LobbyHeadlessClient {
  return createLobbyHeadlessClient({
    syncUrl,
    boardId,
    tab,
    ticket: ticketFor(boardId, user),
    refreshTicket: async () => ticketFor(boardId, user),
    // L7-tail: the ticket in the offered subprotocol, as the browsers send it
    WebSocketImpl: TicketWebSocket,
  })
}

/** Waits until `test` holds, polling. */
export async function until(test: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${what}`)
    await sleep(5)
  }
}

import { appendFileSync } from 'node:fs'

const LOG_FILE = process.env.V1_LOG
/** Logs to the console and appends to the V1 results file (vitest hides a passing test's stdout). */
export function vlog(...a: unknown[]): void {
  const line = `[V1 ${new Date().toISOString()}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`
  console.log(line)
  if (LOG_FILE) appendFileSync(LOG_FILE, `${line}\n`)
}
