// A6 / SECURITY-REVIEW-2026-10-02 M3-3: how long a request may take to ARRIVE. Fastify's requestTimeout
// was 0, so a client could hold a socket by sending a JSON body, or an upload, a byte at a time. Now a
// request with a small (or chunked, or no) body must arrive whole within `smallMs`; one that declares a
// large body (an upload) is cut only when no byte arrives for `stallMs`; and Node's own requestTimeout is
// the ceiling for all of them. These run over real sockets (app.inject() has none to time), with the
// limits lowered to a few hundred milliseconds.

import { type AddressInfo, connect, type Socket } from 'node:net'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_REQUEST_TIMEOUTS, registerRequestTimeouts } from '../src/app.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from './helpers.ts'
import { listen } from './sse.ts'

const SMALL_MS = 400
const STALL_MS = 400
const LARGE_BYTES = 64 * 1024

let api: TestApi
let port: number
let alice: Client
const sockets: Socket[] = []

beforeEach(async () => {
  api = await createTestApi({
    deps: { timeouts: { smallMs: SMALL_MS, stallMs: STALL_MS, largeBodyBytes: LARGE_BYTES } },
  })
  alice = await api.login('alice')
  port = Number(new URL(await listen(api)).port)
})
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  await api.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A raw HTTP/1.1 client: what the server sent so far, and when the connection ended. */
function raw() {
  const sock = connect({ host: '127.0.0.1', port })
  sockets.push(sock)
  sock.setEncoding('utf8')
  let data = ''
  sock.on('data', (d: string) => {
    data += d
  })
  const closed = new Promise<void>((resolve) => {
    sock.on('close', () => resolve())
    sock.on('error', () => {}) // a reset after the 408 is fine
  })
  return {
    sock,
    closed,
    get data() {
      return data
    },
    /** The status code of the first response, or null when none came. */
    get status() {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(data)
      return m ? Number(m[1]) : null
    },
  }
}

const head = (lines: string[]) => `${lines.join('\r\n')}\r\n\r\n`
const jsonPost = (path: string, length: number | 'chunked') =>
  head([
    `POST ${path} HTTP/1.1`,
    'Host: localhost',
    `Origin: ${ORIGIN}`,
    'Content-Type: application/json',
    length === 'chunked' ? 'Transfer-Encoding: chunked' : `Content-Length: ${length}`,
  ])

describe('a request with a small body must arrive whole within smallMs', () => {
  it('a JSON request that sends its headers and then goes quiet is cut with a 408 and its handler never runs', async () => {
    const c = raw()
    const startedAt = Date.now()
    c.sock.write(jsonPost(`/api/workspaces/${DEV_STUDIO}/members/${alice.userId}`, 100))
    c.sock.write('{"role":') // 8 of the 100 bytes it declared
    await c.closed
    const took = Date.now() - startedAt
    expect(c.status, c.data).toBe(408)
    expect(c.data).toContain('"code":"REQUEST_TIMEOUT"')
    expect(c.data.toLowerCase()).toContain('connection: close')
    expect(took).toBeGreaterThanOrEqual(SMALL_MS - 50)
    expect(took).toBeLessThan(SMALL_MS + 2_500)
  })

  it('a steady trickle does not buy more time: a small request is cut at smallMs however often bytes arrive', async () => {
    const c = raw()
    const startedAt = Date.now()
    c.sock.write(jsonPost('/api/auth/logout', 1_000))
    const feeder = setInterval(() => {
      if (!c.sock.destroyed) c.sock.write('x')
    }, 50)
    await c.closed
    clearInterval(feeder)
    const took = Date.now() - startedAt
    expect(c.status, c.data).toBe(408)
    expect(took).toBeLessThan(SMALL_MS + 2_500) // not the 20 s the whole body would take
  })

  it('a chunked request that never ends is cut too (its size is not known up front)', async () => {
    const c = raw()
    c.sock.write(jsonPost('/api/auth/logout', 'chunked'))
    c.sock.write('3\r\nabc\r\n') // a chunk, and no end
    await c.closed
    expect(c.status, c.data).toBe(408)
  })

  it('a request that arrives in time is untouched, with a body or without one', async () => {
    const base = `http://127.0.0.1:${port}`
    const login = await fetch(`${base}/api/auth/dev/login`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'zed' }),
    })
    expect(login.status).toBe(200)
    await login.arrayBuffer()
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    // a body that takes most of smallMs to arrive still makes it
    const c = raw()
    const body = JSON.stringify({ handle: 'yan' })
    c.sock.write(
      jsonPost('/api/auth/dev/login', body.length).replace(/\r\n\r\n$/, '\r\nConnection: close\r\n\r\n'),
    )
    c.sock.write(body.slice(0, 5))
    await sleep(SMALL_MS / 2)
    c.sock.write(body.slice(5))
    await c.closed
    expect(c.status, c.data).toBe(200)
  })

  it('the limit is the same for a request with a body over a connection that was already used (keep-alive)', async () => {
    const c = raw()
    c.sock.write(head(['GET /healthz HTTP/1.1', 'Host: localhost']))
    while (c.status === null) await sleep(10)
    expect(c.status).toBe(200)
    c.sock.write(jsonPost('/api/auth/logout', 50))
    c.sock.write('{')
    await c.closed
    expect(c.data).toContain('HTTP/1.1 408')
  })
})

describe('a request that declares a large body (an upload) is cut only when it stalls', () => {
  const upload = (boardId: string, cookie: string, bytes: number) =>
    head([
      `POST /api/boards/${boardId}/assets HTTP/1.1`,
      'Host: localhost',
      `Origin: ${ORIGIN}`,
      `Cookie: ${cookie}`,
      'Content-Type: application/octet-stream',
      'X-File-Name: notes.bin',
      `Content-Length: ${bytes}`,
      'Connection: close',
    ])
  const count = async () =>
    (await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')).n

  it('keeps receiving for longer than smallMs as long as bytes keep coming, and the file is stored', async () => {
    const boardId = await createBoard(alice, DEV_STUDIO, 'Uploads')
    const total = 3 * LARGE_BYTES
    const c = raw()
    const startedAt = Date.now()
    c.sock.write(upload(boardId, alice.cookie, total))
    const chunk = Buffer.alloc(total / 12, 7)
    for (let i = 0; i < 12; i++) {
      c.sock.write(chunk)
      await sleep(80) // 12 x 80 ms is well over smallMs, and every pause is well under stallMs
    }
    await c.closed
    expect(Date.now() - startedAt).toBeGreaterThan(SMALL_MS + 200)
    expect(c.status, c.data).toBe(201)
    expect(await count()).toBe(1)
  })

  it('is cut with a 408 once no byte has arrived for stallMs, and nothing of it is kept', async () => {
    const boardId = await createBoard(alice, DEV_STUDIO, 'Uploads')
    const total = 3 * LARGE_BYTES
    const c = raw()
    const startedAt = Date.now()
    c.sock.write(upload(boardId, alice.cookie, total))
    c.sock.write(Buffer.alloc(LARGE_BYTES, 1)) // a third of it, then silence
    await c.closed
    const took = Date.now() - startedAt
    expect(c.status, c.data).toBe(408)
    expect(took).toBeGreaterThanOrEqual(STALL_MS - 50)
    expect(took).toBeLessThan(STALL_MS + 2_500)
    await sleep(100) // the handler's cleanup runs as the connection ends
    expect(await count()).toBe(0)
    // and the server is fine: the same upload, sent whole, works
    const again = raw()
    again.sock.write(upload(boardId, alice.cookie, 10))
    again.sock.write(Buffer.alloc(10, 2))
    await again.closed
    expect(again.status, again.data).toBe(201)
  })

  it('a large declared length does not excuse a JSON route: the body limit still refuses it at once', async () => {
    const c = raw()
    c.sock.write(jsonPost('/api/auth/dev/login', 5 * 1024 * 1024))
    c.sock.write('{')
    while (c.status === null) await sleep(10)
    expect(c.status).toBe(413)
  })
})

describe('the ceiling', () => {
  it('Node’s own requestTimeout is set (it was 0), long enough for the slowest legitimate upload', () => {
    expect(DEFAULT_REQUEST_TIMEOUTS.ceilingMs).toBe(60 * 60_000)
    expect(DEFAULT_REQUEST_TIMEOUTS.ceilingMs).toBeGreaterThan(DEFAULT_REQUEST_TIMEOUTS.stallMs)
    expect(DEFAULT_REQUEST_TIMEOUTS.smallMs).toBeGreaterThanOrEqual(30_000)
    expect(api.app.server.requestTimeout).toBe(DEFAULT_REQUEST_TIMEOUTS.ceilingMs)
  })

  it('app.inject() requests, which have no socket, are not timed', async () => {
    const res = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/projects`, { name: 'Roadmap' })
    expect(res.statusCode, res.body).toBe(201)
  })
})

describe('time the server spends not reading is not held against the client', () => {
  it('an upload whose handler is slow to start reading is not cut as stalled (the bytes are waiting here, not on the client)', async () => {
    const app = Fastify()
    registerRequestTimeouts(app, {
      ...DEFAULT_REQUEST_TIMEOUTS,
      stallMs: STALL_MS,
      largeBodyBytes: LARGE_BYTES,
    })
    app.addContentTypeParser('*', (_req, _payload, done) => done(null)) // the handler reads the stream
    app.post('/slow-reader', async (req) => {
      await sleep(STALL_MS * 3) // does not read for three stall periods (a store write, a database call)
      let received = 0
      for await (const chunk of req.raw) received += (chunk as Buffer).length
      return { received }
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    try {
      const body = Buffer.alloc(600 * 1024, 3)
      const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/slow-reader`
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ received: body.length })
    } finally {
      await app.close()
    }
  })
})
