import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { mintTicket, TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { listFiles, rawExchange, startServer, waitFor } from './helpers.ts'

const portIsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })

const upgradeRequest = (path: string) =>
  `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'

describe('createSyncServer lifecycle', () => {
  it('close() drops live WebSockets and in-flight requests, seeds nothing and frees the port', async () => {
    const t = await startServer()
    const ticket = mintTicket('board-life', 'alice')
    const ws = new WebSocket(`${t.wsUrl}/connect/board-life?sessionId=tab1&ticket=${ticket}`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws failed'))
    })
    const wsClosed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve()
    })
    expect(t.server.registry.has('board-life')).toBe(true)

    // A seed whose body never finishes arriving is still being read when close() runs.
    const seed = rawExchange(t.port, (s) => {
      s.write(
        `POST /internal/boards/board-half/seed HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n` +
          `x-draftroom-internal: ${TEST_INTERNAL_SECRET}\r\nContent-Length: 100000\r\n\r\n`,
      )
      s.write('{"snapshot":')
    })
    await new Promise((r) => setTimeout(r, 200))

    await t.server.close()
    await wsClosed
    await seed // the server hung up on the half-sent body
    expect(t.server.registry.has('board-life')).toBe(false)
    expect(listFiles(t.roomsDir).filter((f) => f.includes('board-half'))).toEqual([])
    expect(await portIsFree(t.port)).toBe(true)
    await t.stop() // idempotent
  })

  it('close() does not wait for a WebSocket peer that never answers the close handshake', async () => {
    const t = await startServer()
    let upgraded = false
    const peer = rawExchange(
      t.port,
      (s) => {
        s.on('data', (d) => {
          if (d.toString('latin1').startsWith('HTTP/1.1 101')) upgraded = true
        })
        s.write(
          upgradeRequest(`/connect/board-life?sessionId=tab1&ticket=${mintTicket('board-life', 'alice')}`),
        )
        // ...and then never reads/answers a frame: ws would wait 30 s for our close frame
      },
      20_000,
    )
    await waitFor(() => upgraded && t.server.registry.has('board-life'))
    const started = Date.now()
    await t.server.close()
    expect(Date.now() - started).toBeLessThan(3_000)
    await peer
    await t.stop()
  })

  it('a WebSocket without a ticket is upgraded then closed 4099 NOT_AUTHENTICATED (no room opened); a bad board id is a 400', async () => {
    const t = await startServer()
    try {
      const ws = new WebSocket(`${t.wsUrl}/connect/board-life?sessionId=tab1`)
      const ev = await new Promise<CloseEvent>((resolve) => {
        ws.onclose = resolve
      })
      expect([ev.code, ev.reason]).toEqual([4099, 'NOT_AUTHENTICATED'])
      expect(t.server.registry.has('board-life')).toBe(false)
      expect(listFiles(t.roomsDir)).toEqual([])

      const raw = await rawExchange(t.port, (s) =>
        s.write(
          upgradeRequest(`/connect/Board-Life?sessionId=tab1&ticket=${mintTicket('Board-Life', 'alice')}`),
        ),
      )
      expect(raw).toMatch(/^HTTP\/1\.1 400 Bad Request/)
      expect(t.server.registry.has('Board-Life')).toBe(false)
    } finally {
      await t.stop()
    }
  })
})
