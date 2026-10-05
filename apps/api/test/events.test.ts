import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventHub } from '../src/events/hub.ts'
import { HEARTBEAT_MS, STREAM_PADDING } from '../src/events/routes.ts'
import { createBoard, createTestApi, ORIGIN, type TestApi } from './helpers.ts'
import { openSse } from './sse.ts'

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

/** Opens the SSE stream over a real socket and yields parsed `data:` payloads. */
async function openStream(base: string, boardId: string, cookie: string) {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/boards/${boardId}/events`, {
    headers: { cookie, origin: ORIGIN },
    signal: controller.signal,
  })
  const events: { type: string; data: unknown }[] = []
  const pump = (async () => {
    if (!res.body) return
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        buf += dec.decode(value, { stream: true })
        let i = buf.indexOf('\n\n')
        while (i >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (line) events.push(JSON.parse(line.slice(6)))
          i = buf.indexOf('\n\n')
        }
      }
    } catch {}
  })()
  const waitFor = async (type: string) => {
    for (let i = 0; i < 100; i++) {
      const e = events.find((x) => x.type === type)
      if (e) return e
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`no ${type} event; got ${JSON.stringify(events)}`)
  }
  const close = () => {
    controller.abort()
    return pump
  }
  /** Resolves when the server ended the stream (the reader finished without our abort). */
  return { res, events, waitFor, close, ended: pump }
}

describe('board event stream', () => {
  it('says hello with server time and role, then delivers events published for that board only', async () => {
    const events = new EventHub()
    api = await createTestApi({ deps: { events } })
    const alice = await api.login('alice')
    const boardId = await createBoard(alice, alice.personalWorkspaceId)
    const other = await createBoard(alice, alice.personalWorkspaceId, 'Other')
    await api.app.listen({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`

    const s = await openStream(base, boardId, alice.cookie)
    expect(s.res.status).toBe(200)
    expect(s.res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    const hello = await s.waitFor('hello')
    expect(hello.data).toMatchObject({ role: 'owner' })
    expect(Date.parse((hello.data as { serverNow: string }).serverNow)).not.toBeNaN()

    events.publish(other, { type: 'test.other', data: 1 })
    events.publish(boardId, { type: 'test.mine', data: { n: 2 } })
    expect((await s.waitFor('test.mine')).data).toEqual({ n: 2 })
    expect(s.events.some((e) => e.type === 'test.other')).toBe(false)

    await s.close()
    for (let i = 0; i < 50 && events.subscriberCount(boardId) > 0; i++)
      await new Promise((r) => setTimeout(r, 20))
    expect(events.subscriberCount(boardId)).toBe(0)
  })

  it('sends a data ping every heartbeat, which a page can see (an SSE comment never reaches its JS)', async () => {
    api = await createTestApi()
    const alice = await api.login('alice')
    const boardId = await createBoard(alice, alice.personalWorkspaceId)
    await api.app.listen({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`
    // Only the intervals are fake: the heartbeat's is set when the stream opens below.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const s = await openStream(base, boardId, alice.cookie)
      await s.waitFor('hello')
      expect(s.events.some((e) => e.type === 'ping')).toBe(false)
      vi.advanceTimersByTime(HEARTBEAT_MS)
      expect(await s.waitFor('ping')).toMatchObject({ type: 'ping', data: null })
      await s.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an intermediary from buffering or compressing the stream: no-transform, flushed headers, no content-encoding', async () => {
    api = await createTestApi()
    const alice = await api.login('alice')
    const boardId = await createBoard(alice, alice.personalWorkspaceId)
    await api.app.listen({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`

    const s = await openStream(base, boardId, alice.cookie)
    // fetch() resolves once the status line and headers are in; the hello is only checked afterwards.
    expect(s.res.status).toBe(200)
    expect(s.res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
    // Directive by directive: no-transform forbids compressing/rewriting, no-cache forbids reuse.
    const cacheControl = (s.res.headers.get('cache-control') ?? '').split(',').map((d) => d.trim())
    expect(cacheControl).toEqual(['no-cache', 'no-transform'])
    expect(s.res.headers.get('x-accel-buffering')).toBe('no')
    expect(s.res.headers.get('x-content-type-options')).toBe('nosniff')
    // The api compresses nothing itself, even when the client offers every encoding.
    expect(s.res.headers.get('content-encoding')).toBeNull()
    await s.waitFor('hello')
    await s.close()

    const offered = await fetch(`${base}/api/boards/${boardId}/events`, {
      headers: { cookie: alice.cookie, origin: ORIGIN, 'accept-encoding': 'gzip, deflate, br, zstd' },
    })
    expect(offered.status).toBe(200)
    expect(offered.headers.get('content-encoding')).toBeNull()
    expect(offered.headers.get('cache-control')).toBe('no-cache, no-transform')
    await offered.body?.cancel()
  })

  it('starts with the SSE comment padding, then the hello; a client parser sees only the hello', async () => {
    api = await createTestApi()
    const alice = await api.login('alice')
    const boardId = await createBoard(alice, alice.personalWorkspaceId)
    await api.app.listen({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`

    // The raw bytes, not parsed events: read until the hello frame is complete.
    const controller = new AbortController()
    const res = await fetch(`${base}/api/boards/${boardId}/events`, {
      headers: { cookie: alice.cookie, origin: ORIGIN },
      signal: controller.signal,
    })
    const reader = res.body?.getReader()
    if (!reader) throw new Error('no body')
    const dec = new TextDecoder()
    let raw = ''
    while (!raw.includes('"type":"hello"') || !raw.endsWith('\n\n')) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`the stream ended before the hello: ${JSON.stringify(raw.slice(0, 80))}`)
      raw += dec.decode(value, { stream: true })
    }
    controller.abort()

    // About 2 KB of comment first (a ':' line and the blank line), nothing before it.
    expect(STREAM_PADDING.length).toBeGreaterThanOrEqual(2048)
    expect(STREAM_PADDING.startsWith(':')).toBe(true)
    expect(STREAM_PADDING.endsWith('\n\n')).toBe(true)
    expect(STREAM_PADDING.slice(1, -2).trim()).toBe('') // padding is spaces only: no data, no field
    expect(raw.startsWith(STREAM_PADDING)).toBe(true)
    // Then the hello, as the only data frame.
    const rest = raw.slice(STREAM_PADDING.length)
    expect(rest.startsWith('data: {"type":"hello"')).toBe(true)
    expect(rest.match(/^data: /gm)).toHaveLength(1)

    // The parser the other tests use (data:/retry: lines only, like a browser) yields the hello alone.
    const parsed = await openSse(base, boardId, alice.cookie)
    expect((await parsed.waitFor('hello')).data).toMatchObject({ role: 'owner' })
    expect(parsed.events.map((e) => e.type)).toEqual(['hello'])
    expect(parsed.retries).toEqual([])
    await parsed.close()
  })

  it('ends open streams when the app closes, so a deploy does not wait on connected clients', async () => {
    api = await createTestApi()
    const alice = await api.login('alice')
    const boardId = await createBoard(alice, alice.personalWorkspaceId)
    await api.app.listen({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`
    const s = await openStream(base, boardId, alice.cookie)
    await s.waitFor('hello')

    // Without the preClose hook, close() waits for the stream forever (Fastify only drops idle sockets).
    const closed = api.app.close().then(() => 'closed')
    const timeout = new Promise((r) => setTimeout(() => r('timeout'), 3_000))
    expect(await Promise.race([closed, timeout])).toBe('closed')
    // The server ended the stream: the reader finished without the client aborting it.
    expect(await Promise.race([s.ended.then(() => 'ended'), timeout])).toBe('ended')
    await s.close()
  })

  it('refuses people who cannot view the board, without revealing that it exists', async () => {
    api = await createTestApi()
    const alice = await api.login('alice')
    const erin = await api.login('erin')
    const boardId = await createBoard(alice, alice.personalWorkspaceId)
    await api.app.listen({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`

    const forbidden = await fetch(`${base}/api/boards/${boardId}/events`, {
      headers: { cookie: erin.cookie },
    })
    expect(forbidden.status).toBe(404)
    const missing = await fetch(`${base}/api/boards/b-doesnotexist/events`, {
      headers: { cookie: erin.cookie },
    })
    expect(missing.status).toBe(404)
    const anon = await fetch(`${base}/api/boards/${boardId}/events`)
    expect(anon.status).toBe(401)
  })

  it('exposes an unauthenticated liveness probe', async () => {
    api = await createTestApi()
    const res = await api.anon('GET', '/healthz')
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('ok')
  })
})
