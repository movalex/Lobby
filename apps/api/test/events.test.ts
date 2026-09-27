import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EventHub } from '../src/events/hub.ts'
import { createBoard, createTestApi, ORIGIN, type TestApi } from './helpers.ts'

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
