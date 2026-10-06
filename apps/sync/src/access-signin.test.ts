// RT-01 (realtime audit, wave J3): the access answer's `signedInSince` and the monitor's session rule
// (access.ts). The real server process runs the same paths in test/element-room/signed-out.test.ts.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AccessAnswer,
  type AccessClient,
  AccessUnavailableError,
  createAccessMonitor,
  createApiAccessClient,
  SESSION_START_MARGIN_MS,
  signInEnded,
} from './access.ts'
import type { LiveElementSession, SessionDirectory } from './engine-switch.ts'
import type { BoardRole } from './permissions.ts'

const SECRET = 'internal-secret-for-this-unit-test-0123456789'

let server: Server | null = null
afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

/** An api answering 200 with each body in turn. */
async function answering(bodies: unknown[]): Promise<string> {
  let i = 0
  server = createServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(bodies[i++])),
  )
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('RT-01: signedInSince in the access answer', () => {
  it('is read when present (a time or null), absent for an api from before J3; anything else is "cannot tell"', async () => {
    const base = await answering([
      { role: 'editor', signedInSince: 1_700_000_000_000 },
      { role: 'editor', signedInSince: null },
      { role: 'viewer' },
      { role: null, signedInSince: null },
      { role: 'editor', signedInSince: '1700000000000' },
      { role: 'editor', signedInSince: -1 },
      { role: 'editor', signedInSince: true },
    ])
    const client = createApiAccessClient({ baseUrl: base, internalSecret: SECRET })
    const getAccess = client.getAccess as NonNullable<AccessClient['getAccess']>
    expect(await getAccess('b-abcdefghij', 'usr_a')).toEqual({
      role: 'editor',
      signedInSince: 1_700_000_000_000,
    })
    expect(await getAccess('b-abcdefghij', 'usr_a')).toEqual({ role: 'editor', signedInSince: null })
    expect(await getAccess('b-abcdefghij', 'usr_a')).toEqual({ role: 'viewer' })
    expect(await getAccess('b-abcdefghij', 'usr_a')).toEqual({ role: null, signedInSince: null })
    for (let k = 0; k < 3; k++)
      await expect(getAccess('b-abcdefghij', 'usr_a')).rejects.toThrow(AccessUnavailableError)
  })

  it('the rule: no live session, or a ticket issued before every live session began (with a margin)', () => {
    const since = 1_000_000
    expect(signInEnded(null, undefined)).toBe('signed-out')
    expect(signInEnded(null, since + 5)).toBe('signed-out')
    expect(signInEnded(undefined, 0)).toBeNull() // an api from before J3
    expect(signInEnded(since, undefined)).toBeNull() // a session whose ticket time is unknown
    expect(signInEnded(since, since - SESSION_START_MARGIN_MS - 1)).toBe('stale')
    expect(signInEnded(since, since - SESSION_START_MARGIN_MS)).toBeNull()
    expect(signInEnded(since, since + 60_000)).toBeNull()
  })
})

/** A session directory over plain lists, recording every close. */
function fakeRegistry() {
  const boards = new Map<string, LiveElementSession[]>()
  const closed: { boardId: string; sessionId: string; reason: string | undefined }[] = []
  const registry: SessionDirectory = {
    roomIfOpen: (boardId) =>
      boards.has(boardId)
        ? {
            closeSession: (sessionId, reason) => {
              closed.push({ boardId, sessionId, reason })
              boards.set(
                boardId,
                (boards.get(boardId) ?? []).filter((s) => s.sessionId !== sessionId),
              )
            },
          }
        : null,
    sessionsOf: (boardId) => [...(boards.get(boardId) ?? [])],
    openBoards: () => [...boards.keys()],
  }
  const join = (boardId: string, userId: string, tab: string, role: BoardRole = 'editor') => {
    const s = { sessionId: `${userId}:${tab}`, meta: { userId, role, name: userId, color: '#123456' } }
    boards.set(boardId, [...(boards.get(boardId) ?? []), s])
    return s.sessionId
  }
  return { registry, closed, join }
}

/** An access client answering from a table (unknown pairs throw: "cannot tell"). */
function tableClient(table: Map<string, AccessAnswer>, calls: string[] = []) {
  const answer = (boardId: string, userId: string) => {
    calls.push(`${boardId}/${userId}`)
    const a = table.get(`${boardId}/${userId}`)
    if (!a) throw new AccessUnavailableError('unknown')
    return a
  }
  return {
    getRole: async (b: string, u: string) => answer(b, u).role,
    getAccess: async (b: string, u: string) => answer(b, u),
  } satisfies AccessClient
}

const quiet = () => {}
const T = 1_800_000_000_000

describe('RT-01: the access monitor and ended sign-ins', () => {
  it('userChanged re-checks that person on every open board where they are, and closes them NOT_AUTHENTICATED', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>()
    const calls: string[] = []
    const client = tableClient(table, calls)
    const m = createAccessMonitor({ registry, client, intervalMs: 60_000, log: quiet })
    const a1 = join('b-one', 'alice', 't1')
    const a2 = join('b-two', 'alice', 't2')
    const bob = join('b-one', 'bob', 't3')
    join('b-three', 'carol', 't4') // a board alice is not on: never asked
    m.admitted('b-one', a1, 'alice', T)
    m.admitted('b-two', a2, 'alice', T)
    m.admitted('b-one', bob, 'bob', T)
    for (const b of ['b-one', 'b-two']) table.set(`${b}/alice`, { role: 'editor', signedInSince: null })
    table.set('b-one/bob', { role: 'editor', signedInSince: T - 1 })
    await m.userChanged('alice')
    expect(calls.sort()).toEqual(['b-one/alice', 'b-two/alice'])
    expect(closed).toEqual([
      { boardId: 'b-one', sessionId: a1, reason: 'NOT_AUTHENTICATED' },
      { boardId: 'b-two', sessionId: a2, reason: 'NOT_AUTHENTICATED' },
    ])
  })

  it('after a new sign-in only the sockets whose ticket predates every live session close (to reconnect: their new ticket decides)', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>()
    const m = createAccessMonitor({ registry, client: tableClient(table), intervalMs: 60_000, log: quiet })
    const old = join('b-one', 'alice', 'old')
    m.admitted('b-one', old, 'alice', T - 30_000)
    const fresh = join('b-one', 'alice', 'fresh')
    m.admitted('b-one', fresh, 'alice', T)
    table.set('b-one/alice', { role: 'editor', signedInSince: T - 10_000 })
    await m.userChanged('alice')
    expect(closed).toEqual([{ boardId: 'b-one', sessionId: old, reason: undefined }])
    // the periodic round agrees: nothing more closes
    await m.checkAll()
    expect(closed).toHaveLength(1)
  })

  it('a replaced socket (same session id) keeps its successor’s ticket time', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>()
    const m = createAccessMonitor({ registry, client: tableClient(table), intervalMs: 60_000, log: quiet })
    const sid = join('b-one', 'alice', 'tab')
    m.admitted('b-one', sid, 'alice', T - 30_000) // the old socket
    m.admitted('b-one', sid, 'alice', T) // its replacement, with a ticket from the new session
    m.removed('b-one', sid) // the old socket leaves after its successor was admitted
    table.set('b-one/alice', { role: 'editor', signedInSince: T - 10_000 })
    await m.checkAll()
    expect(closed).toEqual([])
  })

  it('lost access stays FORBIDDEN without a session; a client without getAccess keeps the role rules only', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>([['b-one/alice', { role: null, signedInSince: null }]])
    const m = createAccessMonitor({ registry, client: tableClient(table), intervalMs: 60_000, log: quiet })
    const a = join('b-one', 'alice', 't')
    m.admitted('b-one', a, 'alice', T)
    await m.checkAll()
    expect(closed).toEqual([{ boardId: 'b-one', sessionId: a, reason: 'FORBIDDEN' }])

    const r2 = fakeRegistry()
    const roleOnly: AccessClient = { getRole: async () => 'editor' }
    const m2 = createAccessMonitor({
      registry: r2.registry,
      client: roleOnly,
      intervalMs: 60_000,
      log: quiet,
    })
    const s = r2.join('b-one', 'alice', 't')
    m2.admitted('b-one', s, 'alice', 0)
    await m2.userChanged('alice')
    await m2.checkAll()
    expect(r2.closed).toEqual([])
  })

  it('an answer in flight never closes a socket admitted after it was asked; a stale ticket admitted after the push asks again', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>([['b-one/alice', { role: 'editor', signedInSince: null }]])
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const calls: string[] = []
    const base = tableClient(table, calls)
    const gated: AccessClient = {
      getRole: base.getRole,
      async getAccess(b, u) {
        const a = await base.getAccess(b, u)
        await gate
        return a
      },
    }
    const m = createAccessMonitor({ registry, client: gated, intervalMs: 60_000, log: quiet })
    const early = join('b-one', 'alice', 'early')
    m.admitted('b-one', early, 'alice', T)
    const pending = m.userChanged('alice')
    // signed in again while the api's (older) answer is on its way: this socket is not the answer's
    const later = join('b-one', 'alice', 'later')
    m.admitted('b-one', later, 'alice', Date.now() + 60_000) // a ticket from after the change: no re-check
    release()
    await pending
    expect(closed).toEqual([{ boardId: 'b-one', sessionId: early, reason: 'NOT_AUTHENTICATED' }])
    // a ticket issued before the change (the ended session's), admitted after it: its admission asks again
    table.set('b-one/alice', { role: 'editor', signedInSince: Date.now() - 1_000 })
    const stale = join('b-one', 'alice', 'stale')
    m.admitted('b-one', stale, 'alice', Date.now() - 20_000)
    await expect.poll(() => closed.map((c) => c.sessionId)).toEqual([early, stale])
    expect(calls.filter((c) => c === 'b-one/alice')).toHaveLength(2)
  })
})
