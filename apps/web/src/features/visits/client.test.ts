// Wave N, N4-1 (web side): fetchVisit and sendSeen. Every failure is silent and leaves the chip hidden.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fetchVisit, sendSeen } from './client.ts'

const g = globalThis as { fetch?: unknown; navigator?: unknown }
let fetchBefore: unknown
let navigatorBefore: unknown
let calls: { url: string; init: RequestInit | undefined }[]
beforeEach(() => {
  fetchBefore = g.fetch
  navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  calls = []
})
afterEach(() => {
  g.fetch = fetchBefore
  if (navigatorBefore) Object.defineProperty(globalThis, 'navigator', navigatorBefore as PropertyDescriptor)
})

const reply = (status: number, body?: unknown) => {
  g.fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}
const setNavigator = (value: unknown) =>
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })

describe('fetchVisit', () => {
  it('POSTs to the board’s visit route, same origin, no body, and returns the answer', async () => {
    reply(200, { previousSeenAt: 1_700_000_000_000, seenAt: 1_700_000_500_000 })
    expect(await fetchVisit('b-board00001')).toEqual({
      previousSeenAt: 1_700_000_000_000,
      seenAt: 1_700_000_500_000,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('/api/boards/b-board00001/visit')
    expect(calls[0]?.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
    expect(calls[0]?.init?.body).toBeUndefined()
  })

  it('a first visit answers a null previous time', async () => {
    reply(200, { previousSeenAt: null, seenAt: 1_700_000_500_000 })
    expect(await fetchVisit('b-board00001')).toEqual({ previousSeenAt: null, seenAt: 1_700_000_500_000 })
  })

  it('answers null for everything that is not a good answer: a guest (403), an older api (404), a 5xx, a bad body, no network', async () => {
    for (const status of [401, 403, 404, 429, 500, 503]) {
      reply(status, { error: { code: 'X', message: 'no' } })
      expect(await fetchVisit('b-board00001'), String(status)).toBeNull()
    }
    for (const body of [
      {},
      { seenAt: 5 },
      { previousSeenAt: 'yesterday', seenAt: 5 },
      { previousSeenAt: null, seenAt: 5, extra: 1 },
      'text',
      null,
    ]) {
      reply(200, body)
      expect(await fetchVisit('b-board00001'), JSON.stringify(body)).toBeNull()
    }
    g.fetch = async () => {
      throw new TypeError('Failed to fetch')
    }
    expect(await fetchVisit('b-board00001')).toBeNull()
    g.fetch = undefined
    expect(await fetchVisit('b-board00001')).toBeNull()
  })

  it('encodes the board id', async () => {
    reply(200, { previousSeenAt: null, seenAt: 5 })
    await fetchVisit('b/x y')
    expect(calls[0]?.url).toBe('/api/boards/b%2Fx%20y/visit')
  })
})

describe('sendSeen', () => {
  it('queues a body-less beacon to the seen route', () => {
    const beacons: { url: string; data: unknown }[] = []
    setNavigator({
      sendBeacon: (url: string, data?: unknown) => {
        beacons.push({ url, data })
        return true
      },
    })
    g.fetch = () => {
      throw new Error('no fetch expected when the beacon is queued')
    }
    expect(sendSeen('b-board00001')).toBe(true)
    expect(beacons).toEqual([{ url: '/api/boards/b-board00001/visit/seen', data: undefined }])
  })

  it('falls back to a keepalive fetch when the beacon is refused or missing', async () => {
    reply(204)
    setNavigator({ sendBeacon: () => false })
    expect(sendSeen('b-board00001')).toBe(true)
    setNavigator({})
    expect(sendSeen('b-board00001')).toBe(true)
    setNavigator({
      sendBeacon: () => {
        throw new Error('blocked')
      },
    })
    expect(sendSeen('b-board00001')).toBe(true)
    await Promise.resolve()
    expect(calls).toHaveLength(3)
    for (const c of calls) {
      expect(c.url).toBe('/api/boards/b-board00001/visit/seen')
      expect(c.init).toMatchObject({ method: 'POST', credentials: 'same-origin', keepalive: true })
      expect(c.init?.body).toBeUndefined()
    }
  })

  it('never throws: a fetch that rejects, or none at all, is false or ignored', () => {
    setNavigator({})
    g.fetch = () => Promise.reject(new Error('offline'))
    expect(sendSeen('b-board00001')).toBe(true) // queued; nobody waits for it
    g.fetch = undefined
    expect(sendSeen('b-board00001')).toBe(false)
    g.fetch = () => {
      throw new Error('sync throw')
    }
    expect(sendSeen('b-board00001')).toBe(false)
  })
})
