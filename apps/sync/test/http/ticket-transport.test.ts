// Security audit L7: the board socket's ticket travels in the handshake's Sec-WebSocket-Protocol header
// (a second offered subprotocol `lobby.ticket.<ticket>` next to `lobby.board.v1`), not in the URL, which
// platform logs keep (apps/sync/src/app.ts `upgradeTicket`, apps/web/src/board/ticket.ts
// `ticketInProtocol`). The server answers with exactly `lobby.board.v1` (a browser fails a handshake whose
// answer names a protocol it did not offer) and keeps accepting the old `?ticket=` for at least one
// release (stale tabs, cached bundles). The ticket is checked before the upgrade either way and never
// appears in a log line.

import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import {
  ticketInProtocol,
  BOARD_SOCKET_PROTOCOL as WEB_BOARD_PROTOCOL,
  TICKET_PROTOCOL_PREFIX as WEB_TICKET_PREFIX,
} from '../../../web/src/board/ticket-protocol.ts'
import { createLobbyHeadlessClient } from '../../../web/src/canvas/sync/headless/index.ts'
import { BOARD_SOCKET_PROTOCOL, TICKET_PROTOCOL_PREFIX } from '../../src/app.ts'
import { ticketFor } from '../element-room/support/client.ts'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { seed } from '../room-internal/support.ts'
import { startServer, type TestServer } from './helpers.ts'

type Outcome =
  | { kind: 'open'; protocol: string; answered: string | null }
  | { kind: 'closed'; code: number; reason: string }
  | { kind: 'failed'; error: string }

/** Opens a board socket and reports what the server did (the answered subprotocol header included). */
function attempt(url: string, protocols?: string[]): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
    let answered: string | null = null
    let settled = false
    const done = (o: Outcome) => {
      if (settled) return
      settled = true
      resolve(o)
      ws.terminate()
    }
    ws.on('upgrade', (res) => {
      const h = res.headers['sec-websocket-protocol']
      answered = typeof h === 'string' ? h : null
    })
    // open for a moment without being closed: admitted (the room waits for the client's hello)
    ws.on('open', () => setTimeout(() => done({ kind: 'open', protocol: ws.protocol, answered }), 150))
    ws.on('close', (code, reason) => done({ kind: 'closed', code, reason: reason.toString() }))
    ws.on('error', (e) => done({ kind: 'failed', error: e.message }))
  })
}

let t: TestServer | null = null
afterEach(async () => {
  await t?.stop()
  t = null
})

const ticketProtocol = (ticket: string) => `${TICKET_PROTOCOL_PREFIX}${ticket}`

describe('the board ticket in the handshake, not the URL (L7)', () => {
  it('the web and the server name the same two subprotocols', () => {
    expect(BOARD_SOCKET_PROTOCOL).toBe('lobby.board.v1')
    expect(TICKET_PROTOCOL_PREFIX).toBe('lobby.ticket.')
    expect(WEB_BOARD_PROTOCOL).toBe(BOARD_SOCKET_PROTOCOL)
    expect(WEB_TICKET_PREFIX).toBe(TICKET_PROTOCOL_PREFIX)
  })

  it('admits a ticket offered as a subprotocol and answers exactly lobby.board.v1; the old ?ticket= still connects', async () => {
    t = await startServer()
    const ticket = ticketFor('board-l7', 'alice')
    const url = `${t.wsUrl}/connect/board-l7?sessionId=tab1`
    expect(await attempt(url, [BOARD_SOCKET_PROTOCOL, ticketProtocol(ticket)])).toEqual({
      kind: 'open',
      protocol: BOARD_SOCKET_PROTOCOL,
      answered: BOARD_SOCKET_PROTOCOL,
    })
    // the order the client offers them in does not matter: the answer is never the ticket's
    expect(await attempt(`${url}2`, [ticketProtocol(ticket), BOARD_SOCKET_PROTOCOL])).toMatchObject({
      kind: 'open',
      answered: BOARD_SOCKET_PROTOCOL,
    })
    // an old tab (or a cached bundle): the ticket in the URL, no subprotocol, no answer header
    const old = ticketFor('board-l7', 'bob')
    expect(await attempt(`${url}3&ticket=${encodeURIComponent(old)}`)).toEqual({
      kind: 'open',
      protocol: '',
      answered: null,
    })
    for (const line of t.logs) {
      expect(line).not.toContain(ticket)
      expect(line).not.toContain(old)
    }
  })

  it('refuses a missing, bad or other board’s ticket in the subprotocol, terminally and before any room opens, logging no ticket', async () => {
    t = await startServer()
    const url = (b: string) => `${t?.wsUrl}/connect/${b}?sessionId=tab1`
    const other = ticketFor('board-other', 'alice')
    const forged = `${ticketFor('board-x', 'alice').slice(0, -4)}AAAA`
    // a board subprotocol but no ticket anywhere
    expect(await attempt(url('board-x'), [BOARD_SOCKET_PROTOCOL])).toEqual({
      kind: 'closed',
      code: 4099,
      reason: 'NOT_AUTHENTICATED',
    })
    expect(await attempt(url('board-x'), [BOARD_SOCKET_PROTOCOL, ticketProtocol(forged)])).toEqual({
      kind: 'closed',
      code: 4099,
      reason: 'NOT_AUTHENTICATED',
    })
    expect(await attempt(url('board-x'), [BOARD_SOCKET_PROTOCOL, ticketProtocol(other)])).toEqual({
      kind: 'closed',
      code: 4099,
      reason: 'FORBIDDEN',
    })
    // the handshake's ticket is the one checked: a good one in the URL does not rescue a bad one there
    const good = ticketFor('board-x', 'alice')
    expect(
      await attempt(`${url('board-x')}&ticket=${encodeURIComponent(good)}`, [
        BOARD_SOCKET_PROTOCOL,
        ticketProtocol(forged),
      ]),
    ).toMatchObject({ kind: 'closed', code: 4099, reason: 'NOT_AUTHENTICATED' })
    expect(t.server.elementRooms.openBoards()).not.toContain('board-x')
    expect(t.logs).toContainEqual(
      expect.stringMatching(/\[connect\] refused on board board-x: bad_signature/),
    )
    expect(t.logs).toContainEqual(expect.stringMatching(/\[connect\] refused on board board-x: wrong_board/))
    for (const line of t.logs) {
      for (const tk of [other, forged, good]) expect(line).not.toContain(tk)
      expect(line).not.toContain(TICKET_PROTOCOL_PREFIX)
    }
  })
})

describe('the web’s board socket against the real server process (L7)', () => {
  const h = useElementHarness()

  it('connects with the ticket in the handshake, reconnects after a sync restart with a fresh one; an old-style client connects too; no ticket in any log', async () => {
    const st = await h.stack()
    const b = newBoardId()
    expect((await seed(st, b, [rect('r1', { x: 0, y: 0 })])).status).toBe(201)
    const issued: string[] = []
    const fresh = () => {
      const tk = ticketFor(b, 'alice')
      issued.push(tk)
      return tk
    }
    // the browser's constructor, wrapped as the board session wraps it, spied on
    const opened: { url: string; protocols: unknown }[] = []
    const Native = globalThis.WebSocket
    class Spy extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        opened.push({ url: String(url), protocols })
        super(url, protocols)
      }
    }
    const client = createLobbyHeadlessClient({
      syncUrl: st.server.wsUrl,
      boardId: b,
      tab: 'l7-tab',
      ticket: fresh(),
      refreshTicket: async () => fresh(),
      WebSocketImpl: ticketInProtocol(Spy) as never,
    })
    let welcomes = 0
    client.core.on((e) => {
      if (e.kind === 'welcome') welcomes++
    })
    try {
      await client.connect()
      expect(client.scene.has('r1')).toBe(true)
      // a stale tab: the old transport, as the headless client builds it, unwrapped
      const old = createLobbyHeadlessClient({
        syncUrl: st.server.wsUrl,
        boardId: b,
        tab: 'l7-old',
        ticket: fresh(),
      })
      await old.connect()
      await old.close()

      // the sync server crashes and comes back on the same port: the page's socket reconnects by itself
      await st.server.kill('SIGKILL')
      await st.server.restart()
      const deadline = Date.now() + 30_000
      while (welcomes < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      expect(welcomes).toBeGreaterThanOrEqual(2)
      expect(client.transport.state).toBe('open')
    } finally {
      await client.close()
    }
    // every socket the wrapped constructor opened: no ticket in the URL, the ticket in the protocols
    expect(opened.length).toBeGreaterThanOrEqual(2)
    for (const o of opened) {
      const u = new URL(o.url)
      expect(u.searchParams.has('ticket')).toBe(false)
      expect(u.searchParams.get('sessionId')).toBe('l7-tab')
      const [board, carried] = o.protocols as string[]
      expect(board).toBe(BOARD_SOCKET_PROTOCOL)
      expect(issued).toContain(carried?.slice(TICKET_PROTOCOL_PREFIX.length))
    }
    // the reconnect used a fresh ticket
    expect(new Set(opened.map((o) => (o.protocols as string[])[1])).size).toBe(opened.length)
    const logs = st.server.logs()
    for (const tk of issued) expect(logs).not.toContain(tk)
    expect(logs).not.toContain(TICKET_PROTOCOL_PREFIX)
  })
})
