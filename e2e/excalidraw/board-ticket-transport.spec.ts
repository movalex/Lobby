// Security audit L7 in a real browser: the board socket's ticket travels in the WebSocket handshake's
// Sec-WebSocket-Protocol header (`lobby.board.v1` and `lobby.ticket.<ticket>`), never in the socket URL,
// which platform logs keep (apps/web/src/board/ticket.ts `ticketInProtocol`, apps/sync/src/app.ts
// `upgradeTicket`). The sync server answers with exactly `lobby.board.v1` (Chromium fails a handshake
// whose answer names a protocol it did not offer, or none at all). A tab still on the old transport
// (`?ticket=`, a cached bundle) keeps connecting for at least one release. The handshakes are read through
// the page's own DevTools protocol session (Network.webSocket* events): URL, request and response headers.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/board-ticket-transport.spec.ts --workers=1
import type { CDPSession, Page } from '@playwright/test'
import { expect, expectSaved, test, waitForCanvas } from '../tests/support/canvas.ts'
import { forgeSession } from '../tests/support/excalidraw.ts'
import { putNote } from './history-kit.ts'

interface Handshake {
  url: string
  /** the request's Sec-WebSocket-Protocol, as sent */
  offered: string | null
  /** the response's Sec-WebSocket-Protocol, as answered (null: none) */
  answered: string | null
  status: number | null
}

const header = (headers: Record<string, string> | undefined, name: string): string | null => {
  for (const [k, v] of Object.entries(headers ?? {})) if (k.toLowerCase() === name) return v
  return null
}

/** Records every WebSocket handshake of `page` from now on. */
async function tapHandshakes(page: Page): Promise<{ cdp: CDPSession; list: Map<string, Handshake> }> {
  const cdp = await page.context().newCDPSession(page)
  const list = new Map<string, Handshake>()
  cdp.on('Network.webSocketCreated', (e: { requestId: string; url: string }) => {
    list.set(e.requestId, { url: e.url, offered: null, answered: null, status: null })
  })
  cdp.on(
    'Network.webSocketWillSendHandshakeRequest',
    (e: { requestId: string; request: { headers: Record<string, string> } }) => {
      const h = list.get(e.requestId)
      if (h) h.offered = header(e.request.headers, 'sec-websocket-protocol')
    },
  )
  cdp.on(
    'Network.webSocketHandshakeResponseReceived',
    (e: { requestId: string; response: { status: number; headers: Record<string, string> } }) => {
      const h = list.get(e.requestId)
      if (!h) return
      h.answered = header(e.response.headers, 'sec-websocket-protocol')
      h.status = e.response.status
    },
  )
  await cdp.send('Network.enable')
  return { cdp, list }
}

const boardSockets = (list: Map<string, Handshake>) =>
  [...list.values()].filter((h) => new URL(h.url).pathname.startsWith('/connect/'))

test('the board socket carries its ticket in the handshake, never in the URL, on open, reload and after a sync restart; an old ?ticket= socket still connects', async ({
  canvasSession,
  board,
  stack,
}) => {
  const a = await canvasSession('alice')
  const tap = await tapHandshakes(a.page)

  await test.step('a reload opens the board socket with the ticket as a subprotocol, answered lobby.board.v1', async () => {
    await a.page.reload()
    await waitForCanvas(a.page)
    await expect(a.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
    await putNote(a.page, 'l7-note', 'Ticket off the URL')
    await expectSaved(a.page)
    await expect.poll(() => boardSockets(tap.list).filter((h) => h.status === 101).length).toBeGreaterThan(0)
    for (const h of boardSockets(tap.list)) {
      const u = new URL(h.url)
      expect(u.pathname).toBe(`/connect/${board}`)
      expect(u.searchParams.has('ticket'), h.url.replace(/ticket=[^&]+/, 'ticket=REDACTED')).toBe(false)
      expect(u.searchParams.get('sessionId')).toBeTruthy()
      const offered = (h.offered ?? '').split(',').map((p) => p.trim())
      expect(offered[0]).toBe('lobby.board.v1')
      expect(offered[1]).toMatch(/^lobby\.ticket\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
      expect(h.answered).toBe('lobby.board.v1')
    }
  })

  await test.step('after a sync crash and restart the page reconnects the same way, with a fresh ticket', async () => {
    const before = boardSockets(tap.list).length
    await stack.sync.kill()
    await expect(a.page.getByTestId('conn-status')).toHaveAttribute(
      'data-state',
      /offline|connecting|error/,
      {
        timeout: 30_000,
      },
    )
    await stack.sync.start()
    await expect(a.page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', {
      timeout: 30_000,
    })
    const opened = boardSockets(tap.list).filter((h) => h.status === 101)
    expect(boardSockets(tap.list).length).toBeGreaterThan(before)
    const tickets = new Set(opened.map((h) => (h.offered ?? '').split(',')[1]?.trim()))
    expect(tickets.size).toBe(opened.length) // a fresh ticket per connection
    for (const h of boardSockets(tap.list)) expect(new URL(h.url).searchParams.has('ticket')).toBe(false)
    await expectSaved(a.page)
  })

  await test.step('a tab still on the old transport (?ticket=, no subprotocol) connects and is welcomed', async () => {
    const { socket, welcome } = await forgeSession(a.page, board, { ticketIn: 'url' })
    expect(welcome.type).toBe('welcome')
    const old = boardSockets(tap.list).find(
      (h) => new URL(h.url).searchParams.get('sessionId') === socket.tab,
    )
    expect(old?.status).toBe(101)
    expect(old?.offered).toBeNull()
    expect(old?.answered).toBeNull()
    await socket.close()
  })
  await tap.cdp.detach()
})
