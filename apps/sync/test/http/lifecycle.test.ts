import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { listFiles, rawExchange, startServer, waitFor } from './helpers.ts'

const portIsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })

describe('createSyncServer lifecycle', () => {
  it('close() drops live WebSockets and in-flight uploads, removes partial files and frees the port', async () => {
    const t = await startServer()
    const ws = new WebSocket(`ws://127.0.0.1:${t.port}/connect/board-life?sessionId=tab1&devUser=alice`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws failed'))
    })
    const wsClosed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve()
    })
    expect(t.server.registry.has('board-life')).toBe(true)

    const upload = rawExchange(t.port, (s) => {
      s.write(
        'POST /dev-api/boards/board-life/assets?devUser=alice HTTP/1.1\r\nHost: x\r\nContent-Type: image/png\r\n' +
          'X-File-Name: a.png\r\nContent-Length: 100000\r\n\r\n',
      )
      s.write(Buffer.alloc(1000))
    })
    await waitFor(() => listFiles(t.layout.assets).some((f) => f.includes('.upload-')))

    await t.server.close()
    await wsClosed
    await upload // the server hung up on the half-sent upload
    expect(t.server.registry.has('board-life')).toBe(false)
    expect(listFiles(t.layout.assets)).toEqual([]) // close() waited for the cleanup
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
          'GET /connect/board-life?sessionId=tab1&devUser=alice HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n' +
            'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
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

  it('an unauthenticated WebSocket is upgraded then closed 4099 NOT_AUTHENTICATED; a bad board id is a 400', async () => {
    const t = await startServer()
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${t.port}/connect/board-life?sessionId=tab1`)
      const ev = await new Promise<CloseEvent>((resolve) => {
        ws.onclose = resolve
      })
      expect([ev.code, ev.reason]).toEqual([4099, 'NOT_AUTHENTICATED'])

      const raw = await rawExchange(t.port, (s) =>
        s.write(
          'GET /connect/Board-Life?sessionId=tab1&devUser=alice HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\n' +
            'Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
        ),
      )
      expect(raw).toMatch(/^HTTP\/1\.1 400 Bad Request/)
      expect(t.server.registry.has('Board-Life')).toBe(false)
    } finally {
      await t.stop()
    }
  })
})
