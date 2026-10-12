// Wave N.1 (wave N follow-up 5, "one clock"): the sync stamps every element it stores (`updated`, the creation stamp),
// and "Since your last visit" compares those stamps with the person's visit time, which the api stores. The api now
// stores that time on THIS clock: GET /internal/clock (the internal secret, like every /internal route) answers the
// sync's time, and the api measures its offset to it (apps/api/src/sync-clock.ts). Nothing else is in the answer.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { afterEach, describe, expect, it } from 'vitest'
import { createRequestHandler } from '../../src/http/router.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { req } from './helpers.ts'

let server: Server | null = null
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  server = null
})

async function router(): Promise<number> {
  const handle = createRequestHandler({
    internalSecret: TEST_INTERNAL_SECRET,
    monitor: {} as never,
    isClosing: () => false,
    log: () => {},
  })
  server = createServer((q, s) => void handle(q, s))
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r))
  return (server.address() as AddressInfo).port
}

const SECRET = { [INTERNAL_SECRET_HEADER]: TEST_INTERNAL_SECRET }

describe('GET /internal/clock', () => {
  it('answers the sync’s time in ms (and nothing else), not cached', async () => {
    const port = await router()
    const before = Date.now()
    const res = await req(port, { path: '/internal/clock', headers: SECRET })
    const after = Date.now()
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(res.body.toString()) as { now: number }
    expect(Object.keys(body)).toEqual(['now'])
    expect(Number.isSafeInteger(body.now)).toBe(true)
    expect(body.now).toBeGreaterThanOrEqual(before)
    expect(body.now).toBeLessThanOrEqual(after)
  })

  it('needs the internal secret (401 without it, like the whole internal surface); GET only', async () => {
    const port = await router()
    const path = '/internal/clock'
    expect((await req(port, { path })).status).toBe(401)
    expect((await req(port, { path, headers: { [INTERNAL_SECRET_HEADER]: 'x' } })).status).toBe(401)
    expect((await req(port, { method: 'POST', path, headers: SECRET, body: 'none' })).status).toBe(405)
  })
})
