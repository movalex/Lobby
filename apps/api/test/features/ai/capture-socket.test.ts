// Wave N (WS5, N5-1 review): a photo refused before its body is read (the day's cap, a viewer), over a real socket
// (app.inject() has none). The refusal is sent at once, and the rest of the upload the browser is still sending is
// read and dropped: bounded by its declared length (at most CAPTURE_PHOTO_MAX_BYTES) and by app.ts's arrival
// timeouts. So the browser finishes sending and then shows the refusal (a connection closed under an upload in
// flight can surface as a network error, or as a proxy's 502), and the connection stays usable. A body that could be
// endless (chunked, or declared past the limit) is not read: the answer says `connection: close` and the socket goes.

import { connect, type Socket } from 'node:net'
import { CAPTURE_ERROR_CODES, CAPTURE_PHOTO_MAX_BYTES } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { ORIGIN } from '../../helpers.ts'
import { listen } from '../../sse.ts'
import { type CaptureWorld, captureWorld, photoUrl } from './capture-support.ts'

let w: CaptureWorld | null = null
const sockets: Socket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await w?.close()
  w = null
})

interface Answer {
  status: number
  headers: Record<string, string>
  body: string
}

/** A raw HTTP/1.1 connection that reads its answers one after the other (Content-Length bodies only). */
function connection(port: number) {
  const sock = connect({ host: '127.0.0.1', port })
  sockets.push(sock)
  let buf = Buffer.alloc(0)
  let ended = false
  let error: Error | null = null
  const waiters: (() => void)[] = []
  const wake = () => {
    for (const f of waiters.splice(0)) f()
  }
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d])
    wake()
  })
  sock.on('close', () => {
    ended = true
    wake()
  })
  sock.on('error', (e) => {
    error = e
    wake()
  })
  const take = (): Answer | null => {
    const sep = buf.indexOf('\r\n\r\n')
    if (sep < 0) return null
    const lines = buf.subarray(0, sep).toString('latin1').split('\r\n')
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0] ?? '')?.[1])
    const headers: Record<string, string> = {}
    for (const l of lines.slice(1)) {
      const i = l.indexOf(':')
      headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim()
    }
    const len = Number(headers['content-length'] ?? 0)
    if (buf.length < sep + 4 + len) return null
    const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf8')
    buf = buf.subarray(sep + 4 + len)
    return { status, headers, body }
  }
  const settle = () =>
    new Promise<void>((r) => {
      waiters.push(r)
      setTimeout(r, 25)
    })
  return {
    sock,
    get ended() {
      return ended
    },
    get error() {
      return error
    },
    async answer(timeoutMs = 10_000): Promise<Answer> {
      const until = Date.now() + timeoutMs
      for (;;) {
        const a = take()
        if (a) return a
        if (ended) throw new Error('the connection ended before an answer')
        if (Date.now() > until) throw new Error('no answer in time')
        await settle()
      }
    },
    async closed(timeoutMs = 10_000): Promise<boolean> {
      const until = Date.now() + timeoutMs
      while (!ended && Date.now() < until) await settle()
      return ended
    },
    /** Writes `bytes` in pieces, a turn of the event loop apart (as a browser uploads); false if the socket went. */
    async send(bytes: Buffer, piece = 64 * 1024): Promise<boolean> {
      for (let i = 0; i < bytes.length; i += piece) {
        if (sock.destroyed || ended) return false
        if (!sock.write(bytes.subarray(i, i + piece)))
          await new Promise<void>((r) => {
            sock.once('drain', () => r())
            sock.once('close', () => r())
          })
        await new Promise((r) => setImmediate(r))
      }
      return !sock.destroyed && !ended
    },
  }
}

const photoHead = (board: string, cookie: string, length: number | 'chunked') =>
  [
    `POST ${photoUrl(board)} HTTP/1.1`,
    'Host: localhost',
    `Origin: ${ORIGIN}`,
    `Cookie: ${cookie}`,
    'Content-Type: image/jpeg',
    length === 'chunked' ? 'Transfer-Encoding: chunked' : `Content-Length: ${length}`,
    '',
    '',
  ].join('\r\n')

const HEALTH = 'GET /healthz HTTP/1.1\r\nHost: localhost\r\n\r\n'

describe('a photo refused before its body is read, over a real connection', () => {
  it('the refusal (the day’s cap, a viewer) comes at once; the upload still goes out whole, and the connection stays', async () => {
    w = await captureWorld({ env: { DRAFTROOM_AI_VISION_USER_DAILY: '0' } })
    const port = Number(new URL(await listen(w.api)).port)
    const body = Buffer.alloc(3 * 1024 * 1024, 7) // a 3 MiB photo, as the browser sends it
    for (const [who, status, code] of [
      [w.alice, 429, CAPTURE_ERROR_CODES.dailyCap],
      [w.dave, 403, 'FORBIDDEN'],
    ] as const) {
      const c = connection(port)
      c.sock.write(photoHead(w.board, who.cookie, body.length))
      const sending = c.send(body)
      const a = await c.answer()
      expect(a.status, a.body).toBe(status)
      expect((JSON.parse(a.body) as { error: { code: string } }).error.code).toBe(code)
      // not cut under the upload: the browser can finish sending, then show these words
      expect(a.headers.connection).not.toBe('close')
      expect(await sending).toBe(true)
      expect(c.error).toBeNull()
      // what was sent after the answer was read and dropped: the next request on the same connection is answered
      c.sock.write(HEALTH)
      const next = await c.answer()
      expect(next.status).toBe(200)
      expect(next.body).toBe('ok')
      expect(c.ended).toBe(false)
    }
    // nothing was sent to OpenAI, nothing reached the ledger
    expect(w.openai.requests).toEqual([])
  })

  it('a body that could be endless is not read: chunked, or declared past the limit, closes the connection', async () => {
    w = await captureWorld({ env: { DRAFTROOM_AI_VISION_USER_DAILY: '0' } })
    const port = Number(new URL(await listen(w.api)).port)
    for (const length of ['chunked', CAPTURE_PHOTO_MAX_BYTES + 1] as const) {
      const c = connection(port)
      // the head only: a client still sending into a closed connection gets a reset, which can drop the answer
      c.sock.write(photoHead(w.board, w.alice.cookie, length))
      const a = await c.answer()
      expect(a.status, String(length)).toBe(429)
      expect(a.headers.connection, String(length)).toBe('close')
      expect(await c.closed(), String(length)).toBe(true)
    }
  })

  it('past the limit for anyone allowed (413): the connection closes before the body is read', async () => {
    w = await captureWorld()
    const port = Number(new URL(await listen(w.api)).port)
    const c = connection(port)
    c.sock.write(photoHead(w.board, w.alice.cookie, CAPTURE_PHOTO_MAX_BYTES + 1))
    const a = await c.answer()
    expect(a.status).toBe(413)
    expect((JSON.parse(a.body) as { error: { code: string } }).error.code).toBe(
      CAPTURE_ERROR_CODES.imageTooLarge,
    )
    expect(a.headers.connection).toBe('close')
    expect(await c.closed()).toBe(true)
  })
})
