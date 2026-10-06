// RT-01 (realtime audit, wave J3), the api half: every way a session ends tells the sync server whose it
// was (auth/session-sync.ts: POST /internal/access-changed `{ userId }`), and GET /internal/access answers
// `signedInSince` (the start of the person's oldest live session, or null), which the sync's re-check uses
// to close the board sockets of a sign-in that has ended. The sync half: apps/sync/src/access*.test.ts and
// apps/sync/test/element-room/signed-out.test.ts; the whole path: e2e/excalidraw/realtime-security.spec.ts.

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SESSION_TTL_MS } from '../src/auth/session.ts'
import { createHttpSessionEndNotifier } from '../src/auth/session-sync.ts'
import { createBoard, createTestApi, DEV_STUDIO, INTERNAL_SECRET, type TestApi } from './helpers.ts'

let api: TestApi | undefined
let server: Server | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
  server?.closeAllConnections()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = undefined
})

const REVOKE_ALL = '/api/auth/sessions/revoke-all'

/** GET /internal/access as the sync server asks it. */
async function access(a: TestApi, boardId: string, userId: string) {
  const res = await a.app.inject({
    method: 'GET',
    url: `/internal/access?boardId=${boardId}&userId=${userId}`,
    headers: { 'x-draftroom-internal': INTERNAL_SECRET },
  })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as { role: string | null; signedInSince: number | null }
}

describe('ended sessions reach the sync server (RT-01)', () => {
  it('sign out everywhere: the sync is told, signedInSince is null, and a new sign-in starts a newer one', async () => {
    api = await createTestApi()
    const laptop = await api.login('alice')
    const phone = await api.login('alice')
    const bob = await api.login('bob')
    const board = await createBoard(laptop, DEV_STUDIO, 'Board')
    const before = await access(api, board, laptop.userId)
    expect(before.role).toBe('owner')
    expect(typeof before.signedInSince).toBe('number')
    api.sessionEnds.length = 0

    api.clock.advance(5_000)
    expect((await phone.req('POST', REVOKE_ALL)).statusCode).toBe(200)
    expect(api.sessionEnds).toEqual([laptop.userId]) // once, for the person (both devices)
    // still the owner by grant, but signed in nowhere: the sync closes the sockets NOT_AUTHENTICATED
    expect(await access(api, board, laptop.userId)).toEqual({ role: 'owner', signedInSince: null })
    expect((await access(api, board, bob.userId)).signedInSince).toEqual(expect.any(Number))

    api.clock.advance(5_000)
    const t0 = api.clock.now().getTime()
    const again = await api.login('alice')
    const after = await access(api, board, again.userId)
    // the new session's start: newer than every ticket of the ended sessions (all issued before the sign-out)
    expect(after.signedInSince).toBeGreaterThanOrEqual(t0)
    expect(after.signedInSince).toBeLessThanOrEqual(api.clock.now().getTime())
    expect(after.signedInSince).toBeGreaterThan((before.signedInSince ?? 0) + 9_000)
    // the new session's tickets are newer still: they pass the sync's rule
    const ticket = await again.req('POST', `/api/boards/${board}/ticket`)
    expect(ticket.statusCode).toBe(200)
    expect(after.signedInSince).toBeLessThanOrEqual(
      (ticket.json() as { expiresAt: number }).expiresAt - 60_000,
    )
  })

  it('logout of one device: the sync is told; signedInSince is the other device’s session', async () => {
    api = await createTestApi()
    const laptop = await api.login('alice')
    const board = await createBoard(laptop, DEV_STUDIO, 'Board')
    const laptopSince = (await access(api, board, laptop.userId)).signedInSince ?? 0
    api.clock.advance(10_000)
    const t0 = api.clock.now().getTime()
    const phone = await api.login('alice')
    const t1 = api.clock.now().getTime()
    expect((await access(api, board, phone.userId)).signedInSince).toBe(laptopSince) // the oldest
    api.sessionEnds.length = 0
    expect((await laptop.req('POST', '/api/auth/logout')).statusCode).toBe(204)
    expect(api.sessionEnds).toEqual([laptop.userId])
    // the phone's session is the oldest live one now: the laptop's older tickets fail the sync's rule
    const now = await access(api, board, phone.userId)
    expect(now.signedInSince).toBeGreaterThanOrEqual(t0)
    expect(now.signedInSince).toBeLessThanOrEqual(t1)
    // logging out again (a stale tab) ends nothing and tells nobody
    expect((await laptop.req('POST', '/api/auth/logout')).statusCode).toBe(204)
    expect(api.sessionEnds).toHaveLength(1)
  })

  it('a sign-in that replaces this browser’s session tells the sync about the previous person', async () => {
    api = await createTestApi()
    const alice = await api.login('alice')
    const bob = await api.login('bob')
    api.sessionEnds.length = 0
    // a dev user switch in alice's browser: her session there ends
    const res = await alice.req('POST', '/api/auth/dev/login', { handle: 'bob' })
    expect(res.statusCode).toBe(200)
    expect(api.sessionEnds).toEqual([alice.userId])
    expect(bob.userId).not.toBe(alice.userId)
  })

  it('an expired session needs no event: signedInSince turns null once the last one is past its end', async () => {
    api = await createTestApi()
    const alice = await api.login('alice')
    const board = await createBoard(alice, DEV_STUDIO, 'Board')
    expect((await access(api, board, alice.userId)).signedInSince).toEqual(expect.any(Number))
    api.clock.advance(SESSION_TTL_MS + 1_000)
    expect(await access(api, board, alice.userId)).toEqual({ role: 'owner', signedInSince: null })
    expect(api.sessionEnds).toEqual([])
  })

  it('unknown people have no session (and no role)', async () => {
    api = await createTestApi()
    const alice = await api.login('alice')
    const board = await createBoard(alice, DEV_STUDIO, 'Board')
    expect(await access(api, board, 'usr_00000000000000000000')).toEqual({ role: null, signedInSince: null })
  })
})

describe('createHttpSessionEndNotifier', () => {
  async function sync(handler: (req: IncomingMessage, body: string) => number): Promise<string> {
    server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (d) => {
        body += d
      })
      req.on('end', () => res.writeHead(handler(req, body)).end())
    })
    await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('POSTs { userId } to /internal/access-changed with the internal secret, once per person', async () => {
    const seen: { url: string | undefined; secret: unknown; type: unknown; body: string }[] = []
    const base = await sync((req, body) => {
      seen.push({
        url: req.url,
        secret: req.headers['x-draftroom-internal'],
        type: req.headers['content-type'],
        body,
      })
      return 204
    })
    const warns: unknown[] = []
    const n = createHttpSessionEndNotifier({
      baseUrl: base,
      secret: INTERNAL_SECRET,
      log: { warn: (o) => void warns.push(o) },
    })
    n.ended(['usr_a', 'usr_a', 'usr_b', ''])
    await n.drain()
    expect(seen.map((s) => JSON.parse(s.body))).toEqual([{ userId: 'usr_a' }, { userId: 'usr_b' }])
    expect(seen.every((s) => s.url === '/internal/access-changed' && s.secret === INTERNAL_SECRET)).toBe(true)
    expect(seen[0]?.type).toBe('application/json')
    expect(warns).toEqual([])
  })

  it('never throws: a refusal (a sync from before J3: 400) or an outage is logged once a minute, without ids', async () => {
    const base = await sync(() => 400)
    const warns: { obj: object; msg: string }[] = []
    let t = 0
    const n = createHttpSessionEndNotifier({
      baseUrl: base,
      secret: INTERNAL_SECRET,
      log: { warn: (obj, msg) => void warns.push({ obj, msg }) },
      now: () => t,
    })
    n.ended(['usr_a'])
    await n.drain()
    n.ended(['usr_b'])
    await n.drain()
    expect(warns).toEqual([{ obj: { status: 400 }, msg: 'sync session-end refused' }])
    t = 61_000
    const down = createHttpSessionEndNotifier({
      baseUrl: 'http://127.0.0.1:9',
      secret: INTERNAL_SECRET,
      log: { warn: (obj, msg) => void warns.push({ obj, msg }) },
    })
    expect(() => down.ended(['usr_c'])).not.toThrow()
    await down.drain()
    expect(warns.at(-1)).toEqual({ obj: { reason: 'unreachable' }, msg: 'sync session-end not delivered' })
    expect(JSON.stringify(warns)).not.toContain('usr_')
  })

  it('does not follow a redirect (the secret stays put)', async () => {
    let redirected = 0
    const base = await sync((req) => {
      if (req.url === '/elsewhere') {
        redirected++
        return 204
      }
      return 307
    })
    const warns: unknown[] = []
    const n = createHttpSessionEndNotifier({
      baseUrl: base,
      secret: INTERNAL_SECRET,
      log: { warn: (o) => void warns.push(o) },
    })
    n.ended(['usr_a'])
    await n.drain()
    expect(redirected).toBe(0)
    expect(warns).toHaveLength(1)
  })
})
