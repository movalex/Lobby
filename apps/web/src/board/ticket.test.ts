import type { TicketResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.ts'
import { BOARD_ID, makeUser } from '../api/test-fixtures.ts'
import {
  BOARD_SOCKET_PROTOCOL,
  buildTimeSyncOrigin,
  createTicketUri,
  firstTicketWhileStarting,
  isCanvasStarting,
  STARTING_BACKOFF_MS,
  syncSocketOrigin,
  TICKET_PROTOCOL_PREFIX,
  type TicketRetry,
  type TicketUriOptions,
  ticketInProtocol,
  ticketProtocols,
} from './ticket.ts'

// Every test starts from a build without a sync origin, whatever the shell running vitest has set.
beforeEach(() => vi.stubEnv('VITE_DRAFTROOM_SYNC_ORIGIN', ''))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const ticket = (n: number, role: TicketResponse['role'] = 'editor'): TicketResponse => ({
  ticket: `v1.payload${n}.sig+/=${n}`,
  expiresAt: 1_000 + n,
  role,
  user: { id: makeUser('alice').id, name: 'Alice', color: '#1d4ed8' },
})

function setup(fetchTicket: TicketUriOptions['fetchTicket'], over: Partial<TicketUriOptions> = {}) {
  const onTicket = vi.fn()
  const onAccessLost = vi.fn()
  const onSignedOut = vi.fn()
  const sleeps: number[] = []
  const t = createTicketUri({
    boardId: BOARD_ID,
    fetchTicket,
    onTicket,
    onAccessLost,
    onSignedOut,
    origin: { protocol: 'http:', host: '127.0.0.1:5173' },
    sleep: async (ms) => {
      sleeps.push(ms)
      // A retry loop that never gives up would spin forever against this instant sleep; fail instead.
      if (sleeps.length > 50) throw new Error('retry loop did not stop')
    },
    ...over,
  })
  return { t, onTicket, onAccessLost, onSignedOut, sleeps }
}

/** Resolves true if `p` settles within a few macrotasks (a never-settling promise stays false). */
async function settles(p: Promise<unknown>) {
  let done = false
  void p.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  return done
}

describe('sync uri: a fresh ticket on every (re)connect', () => {
  it('fetches a new ticket for each connection attempt and puts it (encoded) in the socket URL', async () => {
    let n = 0
    const fetchTicket = vi.fn(async () => ticket(++n))
    const { t, onTicket } = setup(fetchTicket)
    const first = await t.uri()
    const second = await t.uri() // a reconnect
    expect(fetchTicket).toHaveBeenCalledTimes(2)
    expect(fetchTicket).toHaveBeenCalledWith(BOARD_ID)
    const u1 = new URL(first)
    expect(`${u1.protocol}//${u1.host}${u1.pathname}`).toBe(`ws://127.0.0.1:5173/connect/${BOARD_ID}`)
    expect(u1.searchParams.get('ticket')).toBe('v1.payload1.sig+/=1')
    expect(new URL(second).searchParams.get('ticket')).toBe('v1.payload2.sig+/=2')
    // useSync appends these itself and throws if they are already present.
    expect(u1.searchParams.has('sessionId')).toBe(false)
    expect(u1.searchParams.has('storeId')).toBe(false)
    expect(onTicket).toHaveBeenCalledTimes(2)
  })

  it('uses wss: on https pages', async () => {
    const { t } = setup(async () => ticket(1), { origin: { protocol: 'https:', host: 'draftroom.example' } })
    expect(await t.uri()).toMatch(/^wss:\/\/draftroom\.example\/connect\/b-3k9x0q2m7a\?ticket=/)
  })

  it('reports each ticket so the UI follows role changes between reconnects', async () => {
    const roles: TicketResponse['role'][] = ['editor', 'viewer']
    const { t, onTicket } = setup(async () => ticket(1, roles.shift() ?? 'viewer'))
    await t.uri()
    await t.uri()
    expect(onTicket.mock.calls.map(([x]) => (x as TicketResponse).role)).toEqual(['editor', 'viewer'])
  })

  it('403/404 means access is gone: tell the page once and never settle (no reconnect loop)', async () => {
    for (const [status, kind] of [
      [403, 'forbidden'],
      [404, 'not-found'],
    ] as const) {
      const fetchTicket = vi.fn(async () => {
        throw new ApiError(kind, status, 'X', 'no')
      })
      const { t, onAccessLost, onSignedOut, sleeps } = setup(fetchTicket)
      expect(await settles(t.uri())).toBe(false)
      expect(onAccessLost).toHaveBeenCalledTimes(1)
      expect(onSignedOut).not.toHaveBeenCalled()
      expect(fetchTicket).toHaveBeenCalledTimes(1)
      expect(sleeps).toEqual([])
    }
  })

  it('409 NEW_CANVAS (a board made on the new canvas, bridge release R0): tell the page, never retry', async () => {
    const fetchTicket = vi.fn(async () => {
      throw new ApiError('conflict', 409, 'NEW_CANVAS', 'This board was made on the new canvas.')
    })
    const onNewCanvas = vi.fn()
    const { t, onAccessLost, onSignedOut, sleeps } = setup(fetchTicket, { onNewCanvas })
    expect(await settles(t.uri())).toBe(false)
    expect(onNewCanvas).toHaveBeenCalledTimes(1)
    expect(onAccessLost).not.toHaveBeenCalled()
    expect(onSignedOut).not.toHaveBeenCalled()
    expect(fetchTicket).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })

  it('401 means the session ended: sign out, do not retry', async () => {
    const fetchTicket = vi.fn(async () => {
      throw new ApiError('unauthorized', 401, 'X', 'no')
    })
    const { t, onSignedOut, onAccessLost } = setup(fetchTicket)
    expect(await settles(t.uri())).toBe(false)
    expect(onSignedOut).toHaveBeenCalledTimes(1)
    expect(onAccessLost).not.toHaveBeenCalled()
    expect(fetchTicket).toHaveBeenCalledTimes(1)
  })

  it('transient failures retry with capped backoff and never reject (useSync has no catch)', async () => {
    const failures = [
      new ApiError('network', 0, 'NETWORK', 'down'),
      new ApiError('server', 503, 'HTTP_503', 'busy'),
      new ApiError('rate-limited', 429, 'X', 'slow down'),
      new TypeError('boom'),
      new ApiError('network', 0, 'NETWORK', 'down'),
      new ApiError('network', 0, 'NETWORK', 'down'),
    ]
    const fetchTicket = vi.fn(async () => {
      const f = failures.shift()
      if (f) throw f
      return ticket(7)
    })
    const { t, sleeps, onAccessLost } = setup(fetchTicket, { backoffMs: [10, 20, 40] })
    const url = await t.uri()
    expect(new URL(url).searchParams.get('ticket')).toBe('v1.payload7.sig+/=7')
    expect(fetchTicket).toHaveBeenCalledTimes(7)
    expect(sleeps).toEqual([10, 20, 40, 40, 40, 40])
    expect(onAccessLost).not.toHaveBeenCalled()
  })

  it('K6-1: 503 CANVAS_STARTING (the api has not reached sync yet) is retried on the short backoff while "Connecting", and is never taken for NEW_CANVAS', async () => {
    const starting = () =>
      new ApiError(
        'server',
        503,
        'CANVAS_STARTING',
        'Lobby is connecting to the board server. Try again in a moment.',
      )
    const failures = [starting(), starting(), starting(), starting(), starting(), starting()]
    const fetchTicket = vi.fn(async () => {
      const f = failures.shift()
      if (f) throw f
      return ticket(3)
    })
    const onNewCanvas = vi.fn()
    const states: boolean[] = []
    const onConnecting = vi.fn((_info: TicketRetry) => void states.push(t.connecting()))
    const { t, sleeps, onAccessLost, onSignedOut, onTicket } = setup(fetchTicket, {
      onNewCanvas,
      onConnecting,
    })
    expect(t.connecting()).toBe(false)
    const url = await t.uri()
    expect(new URL(url).searchParams.get('ticket')).toBe('v1.payload3.sig+/=3')
    expect(fetchTicket).toHaveBeenCalledTimes(7)
    // short and capped at 2 s (the api's Retry-After), never the 5 s of the general backoff
    expect(sleeps).toEqual([...STARTING_BACKOFF_MS, 2_000])
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(2_000)
    expect(onConnecting.mock.calls.map(([info]) => info)).toEqual(
      sleeps.map((waitMs, i) => ({ attempt: i + 1, waitMs, starting: true })),
    )
    expect(states.every(Boolean)).toBe(true) // "Connecting" while it waits
    expect(t.connecting()).toBe(false) // and not once the ticket came
    expect(onTicket).toHaveBeenCalledTimes(1)
    expect(onNewCanvas).not.toHaveBeenCalled()
    expect(onAccessLost).not.toHaveBeenCalled()
    expect(onSignedOut).not.toHaveBeenCalled()
    expect(isCanvasStarting(starting())).toBe(true)
    expect(isCanvasStarting(new ApiError('conflict', 409, 'NEW_CANVAS', 'x'))).toBe(false)
    expect(isCanvasStarting(new ApiError('server', 503, 'HTTP_503', 'x'))).toBe(false)
  })

  it('K6-1: a starting api and other transient failures keep their own backoff counts', async () => {
    const failures = [
      new ApiError('network', 0, 'NETWORK', 'down'),
      new ApiError('server', 503, 'CANVAS_STARTING', 'starting'),
      new ApiError('network', 0, 'NETWORK', 'down'),
      new ApiError('server', 503, 'CANVAS_STARTING', 'starting'),
    ]
    const fetchTicket = vi.fn(async () => {
      const f = failures.shift()
      if (f) throw f
      return ticket(4)
    })
    const onConnecting = vi.fn((_info: TicketRetry) => {})
    const { t, sleeps } = setup(fetchTicket, { backoffMs: [10, 20, 40], onConnecting })
    await t.uri()
    expect(sleeps).toEqual([10, STARTING_BACKOFF_MS[0], 20, STARTING_BACKOFF_MS[1]])
    expect(onConnecting.mock.calls.map(([i]) => i.starting)).toEqual([false, true, false, true])
  })

  it('K6-1: the first ticket (before the session) waits out a starting api, and gives every other failure back at once', async () => {
    const sleeps: number[] = []
    const sleep = async (ms: number) => void sleeps.push(ms)
    let n = 0
    const ok = await firstTicketWhileStarting(
      async () => {
        if (n++ < 3) throw new ApiError('server', 503, 'CANVAS_STARTING', 'starting')
        return ticket(5)
      },
      { sleep },
    )
    expect(ok.ticket).toBe('v1.payload5.sig+/=5')
    expect(sleeps).toEqual(STARTING_BACKOFF_MS.slice(0, 3))
    // NEW_CANVAS, no access and every other error: thrown as they are, no wait
    for (const e of [
      new ApiError('conflict', 409, 'NEW_CANVAS', 'made on the new canvas'),
      new ApiError('not-found', 404, 'NOT_FOUND', 'no'),
      new ApiError('server', 500, 'INTERNAL', 'boom'),
    ]) {
      sleeps.length = 0
      await expect(firstTicketWhileStarting(async () => Promise.reject(e), { sleep })).rejects.toBe(e)
      expect(sleeps).toEqual([])
    }
    // a start that lasts past maxWaitMs is reported (the page's error screen, with Try again)
    sleeps.length = 0
    const lasting = new ApiError('server', 503, 'CANVAS_STARTING', 'starting')
    await expect(
      firstTicketWhileStarting(async () => Promise.reject(lasting), { sleep, maxWaitMs: 5_000 }),
    ).rejects.toBe(lasting)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5_000)
  })

  it('shares one attempt between overlapping uri() calls', async () => {
    let release: (t: TicketResponse) => void = () => {}
    const fetchTicket = vi.fn(() => new Promise<TicketResponse>((r) => (release = r)))
    const { t } = setup(fetchTicket)
    const a = t.uri()
    const b = t.uri()
    release(ticket(1))
    expect(await a).toBe(await b)
    expect(fetchTicket).toHaveBeenCalledTimes(1)
  })

  it('cancel() abandons the attempt in flight; the next uri() fetches a fresh ticket', async () => {
    const pending: ((t: TicketResponse) => void)[] = []
    const fetchTicket = vi.fn(() => new Promise<TicketResponse>((r) => pending.push(r)))
    const { t, onTicket } = setup(fetchTicket)
    const stale = t.uri()
    t.cancel()
    const fresh = t.uri()
    pending[0]?.(ticket(1))
    pending[1]?.(ticket(2))
    expect(await settles(stale)).toBe(false)
    expect(new URL(await fresh).searchParams.get('ticket')).toBe('v1.payload2.sig+/=2')
    expect(onTicket).toHaveBeenCalledTimes(1)
  })
})

describe('sync origin: VITE_DRAFTROOM_SYNC_ORIGIN (Render static sites cannot proxy WebSockets)', () => {
  const socketBase = (url: string) => {
    const u = new URL(url)
    return `${u.protocol}//${u.host}${u.pathname}`
  }
  it('defaults to the page origin when the build sets no sync origin', async () => {
    const { t } = setup(async () => ticket(1))
    expect(socketBase(await t.uri())).toBe(`ws://127.0.0.1:5173/connect/${BOARD_ID}`)
    const https = setup(async () => ticket(1), { origin: { protocol: 'https:', host: 'app.example' } })
    expect(socketBase(await https.t.uri())).toBe(`wss://app.example/connect/${BOARD_ID}`)
  })

  it('honors the build-time value: the socket goes to the sync origin, the ticket rides along', async () => {
    vi.stubEnv('VITE_DRAFTROOM_SYNC_ORIGIN', 'https://draftroom-staging-sync.onrender.com')
    const { t } = setup(async () => ticket(3), {
      origin: { protocol: 'https:', host: 'draftroom-staging-web.onrender.com' },
    })
    const url = await t.uri()
    expect(socketBase(url)).toBe(`wss://draftroom-staging-sync.onrender.com/connect/${BOARD_ID}`)
    expect(new URL(url).searchParams.get('ticket')).toBe('v1.payload3.sig+/=3')
    expect(new URL(url).searchParams.has('sessionId')).toBe(false)
  })

  it('maps http -> ws and https -> wss, accepts ws(s) as-is, a trailing slash and a port', () => {
    const http = { protocol: 'http:', host: '127.0.0.1:5173' }
    const https = { protocol: 'https:', host: 'app.example' }
    expect(syncSocketOrigin(http, 'http://127.0.0.1:5858')).toEqual({ ok: true, base: 'ws://127.0.0.1:5858' })
    expect(syncSocketOrigin(https, 'https://sync.example/')).toEqual({ ok: true, base: 'wss://sync.example' })
    expect(syncSocketOrigin(https, ' wss://Sync.Example:8443 ')).toEqual({
      ok: true,
      base: 'wss://sync.example:8443',
    })
    expect(syncSocketOrigin(https, 'https://sync.example:443')).toEqual({
      ok: true,
      base: 'wss://sync.example',
    })
    expect(syncSocketOrigin(http, 'ws://sync.test:5858')).toEqual({ ok: true, base: 'ws://sync.test:5858' })
    expect(syncSocketOrigin(http, undefined)).toEqual({ ok: true, base: 'ws://127.0.0.1:5173' })
    expect(syncSocketOrigin(http, '  ')).toEqual({ ok: true, base: 'ws://127.0.0.1:5173' })
  })

  it('an explicit option wins over the build value; null forces the page origin', async () => {
    vi.stubEnv('VITE_DRAFTROOM_SYNC_ORIGIN', 'https://from-build.example')
    const explicit = setup(async () => ticket(1), { syncOrigin: 'http://127.0.0.1:5858' })
    expect(socketBase(await explicit.t.uri())).toBe(`ws://127.0.0.1:5858/connect/${BOARD_ID}`)
    const pinned = setup(async () => ticket(1), { syncOrigin: null })
    expect(socketBase(await pinned.t.uri())).toBe(`ws://127.0.0.1:5173/connect/${BOARD_ID}`)
    expect(buildTimeSyncOrigin()).toBe('https://from-build.example')
  })

  it('refuses a value that is not an origin: reports it once and falls back to the page origin', async () => {
    for (const bad of [
      'sync.example',
      'ftp://sync.example',
      'https://sync.example/connect',
      'https://sync.example?x=1',
      'https://sync.example#x',
      'https://user:pw@sync.example',
      'not a url',
    ]) {
      const r = syncSocketOrigin({ protocol: 'http:', host: '127.0.0.1:5173' }, bad)
      expect(r, bad).toMatchObject({ ok: false, base: 'ws://127.0.0.1:5173' })
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('VITE_DRAFTROOM_SYNC_ORIGIN', 'https://sync.example/base/')
    const { t } = setup(async () => ticket(1))
    await t.uri()
    await t.uri()
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toMatch(/VITE_DRAFTROOM_SYNC_ORIGIN must be an origin only/)
    expect(socketBase(await t.uri())).toBe(`ws://127.0.0.1:5173/connect/${BOARD_ID}`)
  })

  it('refuses an insecure socket from an https page (the browser would block it as mixed content)', () => {
    const https = { protocol: 'https:', host: 'app.example' }
    for (const insecure of ['http://sync.example', 'ws://sync.example'])
      expect(syncSocketOrigin(https, insecure), insecure).toEqual({
        ok: false,
        base: 'wss://app.example',
        error: 'VITE_DRAFTROOM_SYNC_ORIGIN must be https/wss when the page is served over https',
      })
  })
})

describe('the board socket carries the ticket in the handshake, not the URL (L7)', () => {
  /** A WebSocket stand-in that records what it was opened with. */
  const opened: { url: string; protocols: string | string[] | undefined }[] = []
  class FakeSocket {
    readonly url: string
    readonly protocols: string | string[] | undefined
    constructor(url: string, protocols?: string | string[]) {
      this.url = url
      this.protocols = protocols
      opened.push({ url, protocols })
    }
  }
  beforeEach(() => {
    opened.length = 0
  })
  // what the api signs: v1.<base64url>.<base64url>
  const signed = 'v1.eyJiaWQiOiJiLTEifQ.q2Z_-Lw0'

  it('moves the ticket out of the URL into a second offered subprotocol, after lobby.board.v1', async () => {
    const t = createTicketUri({
      boardId: BOARD_ID,
      fetchTicket: async () => ({ ...ticket(1), ticket: signed }),
      onTicket: () => {},
      onAccessLost: () => {},
      onSignedOut: () => {},
      origin: { protocol: 'https:', host: 'lobby.example' },
    })
    // as the board session builds the socket URL
    const url = `${await t.uri()}&${new URLSearchParams({ sessionId: 'tab-1' })}`
    const Socket = ticketInProtocol(FakeSocket)
    const ws = new Socket(url)
    expect(ws).toBeInstanceOf(FakeSocket)
    expect(opened).toHaveLength(1)
    const u = new URL(opened[0]?.url ?? '')
    expect(`${u.protocol}//${u.host}${u.pathname}`).toBe(`wss://lobby.example/connect/${BOARD_ID}`)
    expect(u.searchParams.has('ticket')).toBe(false)
    expect(u.searchParams.get('sessionId')).toBe('tab-1')
    expect(opened[0]?.url).not.toContain(signed)
    expect(opened[0]?.protocols).toEqual([BOARD_SOCKET_PROTOCOL, `${TICKET_PROTOCOL_PREFIX}${signed}`])
    expect(BOARD_SOCKET_PROTOCOL).toBe('lobby.board.v1')
  })

  it('leaves a URL without a ticket, or a ticket that is not an HTTP token, as it is (the server reads ?ticket= too)', () => {
    const Socket = ticketInProtocol(FakeSocket)
    new Socket('ws://127.0.0.1:5173/connect/b?sessionId=t')
    const odd = 'v1.payload1.sig+/=1'
    const withOdd = `ws://127.0.0.1:5173/connect/b?${new URLSearchParams({ ticket: odd, sessionId: 't' })}`
    new Socket(withOdd)
    expect(opened).toEqual([
      { url: 'ws://127.0.0.1:5173/connect/b?sessionId=t', protocols: undefined },
      { url: withOdd, protocols: undefined },
    ])
    expect(ticketProtocols(odd)).toBeNull()
    expect(ticketProtocols('')).toBeNull()
    expect(ticketProtocols(signed)).toEqual([BOARD_SOCKET_PROTOCOL, `lobby.ticket.${signed}`])
  })
})
