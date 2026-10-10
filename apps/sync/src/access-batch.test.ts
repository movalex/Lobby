// Wave M (M7-1, CAP-SYNC-RECHECK): the periodic access round as ONE batched request (POST /internal/access-many)
// instead of one GET per board-user pair. The api half is apps/api/test/access-many.test.ts; the real server
// process runs the same paths in test/element-room/access-batch.test.ts.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ACCESS_MANY_MAX_PAIRS } from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACCESS_JITTER,
  type AccessAnswer,
  AccessBatchUnsupportedError,
  type AccessClient,
  type AccessPair,
  AccessUnavailableError,
  BATCH_REPROBE_MS,
  createAccessMonitor,
  createApiAccessClient,
  jitteredDelay,
} from './access.ts'
import type { LiveElementSession, SessionDirectory } from './engine-switch.ts'
import type { BoardRole } from './permissions.ts'

const SECRET = 'internal-secret-for-this-unit-test-0123456789'

let server: Server | null = null
afterEach(async () => {
  vi.useRealTimers()
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
})

async function api(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<string> {
  server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (d) => {
      body += d
    })
    req.on('end', () => handler(req, res, body))
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

/** A contract-shaped user id (`usr_` and 10 to 40 letters or digits). */
const usr = (n: number | string) => `usr_${String(n).padStart(12, '0')}`
const board = (n: number) => `b-${String(n).padStart(10, '0')}`

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
  const join = (boardId: string, userId: string, tab = 't', role: BoardRole = 'editor') => {
    const s = { sessionId: `${userId}:${tab}`, meta: { userId, role, name: userId, color: '#123456' } }
    boards.set(boardId, [...(boards.get(boardId) ?? []), s])
    return s.sessionId
  }
  return { registry, closed, join }
}

/** A client answering from a table, counting per-pair and batched calls (unknown pairs: "cannot tell"). */
function countingClient(table: Map<string, AccessAnswer>) {
  const single: string[] = []
  const batches: AccessPair[][] = []
  const answer = (b: string, u: string) => {
    const a = table.get(`${b}/${u}`)
    if (!a) throw new AccessUnavailableError('unknown')
    return a
  }
  let batch: (pairs: readonly AccessPair[]) => Promise<AccessAnswer[]> = async (pairs) =>
    pairs.map((p) => answer(p.boardId, p.userId))
  const client: AccessClient = {
    getRole: async (b, u) => answer(b, u).role,
    async getAccess(b, u) {
      single.push(`${b}/${u}`)
      return answer(b, u)
    },
    async getAccessMany(pairs) {
      batches.push([...pairs])
      return batch(pairs)
    },
  }
  return {
    client,
    single,
    batches,
    setBatch(fn: typeof batch) {
      batch = fn
    },
  }
}

const quiet = () => {}

describe('the batched access client (POST /internal/access-many)', () => {
  it('posts every pair with the internal secret and reads each answer in order, signedInSince per person', async () => {
    const seen: { method?: string; path?: string; secret: unknown; body: unknown }[] = []
    const base = await api((req, res, body) => {
      seen.push({
        method: req.method,
        path: req.url,
        secret: req.headers['x-draftroom-internal'],
        body: JSON.parse(body),
      })
      const { pairs } = JSON.parse(body) as { pairs: AccessPair[] }
      json(res, 200, {
        results: pairs.map((p) => ({ ...p, role: p.userId === usr(2) ? null : 'commenter' })),
        signedInSince: { [usr(1)]: 1_700_000_000_000, [usr(2)]: null },
      })
    })
    const client = createApiAccessClient({ baseUrl: base, internalSecret: SECRET })
    const pairs = [
      { boardId: board(1), userId: usr(1) },
      { boardId: board(2), userId: usr(2) },
      { boardId: board(1), userId: usr(3) }, // not in signedInSince: no session rule for it
    ]
    expect(await client.getAccessMany?.(pairs)).toEqual([
      { role: 'commenter', signedInSince: 1_700_000_000_000 },
      { role: null, signedInSince: null },
      { role: 'commenter' },
    ])
    expect(seen).toEqual([{ method: 'POST', path: '/internal/access-many', secret: SECRET, body: { pairs } }])
  })

  it('a 404, or the 403 an older api’s web-Origin check gives, is "no batch route"; anything else but a well-formed 200 is "cannot tell"', async () => {
    const pairs = [{ boardId: board(1), userId: usr(1) }]
    const ok = { results: [{ ...pairs[0], role: 'viewer' }], signedInSince: {} }
    const answers: Array<[number, unknown]> = [
      [404, { error: { code: 'NOT_FOUND' } }],
      // what an api from before wave M really answers this Origin-less POST (its CSRF hook runs before its 404)
      [403, { error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } }],
      [401, { error: { code: 'NOT_AUTHENTICATED' } }],
      [500, { error: { code: 'INTERNAL' } }],
      [204, null],
      [200, { results: [], signedInSince: {} }], // fewer results than pairs
      [200, { results: [{ boardId: board(9), userId: usr(1), role: 'viewer' }], signedInSince: {} }], // another pair
      [200, { results: [{ ...pairs[0], role: 'superuser' }], signedInSince: {} }],
      [200, { ...ok, extra: 1 }],
      [200, 'viewer'],
      [200, ok],
    ]
    let i = 0
    const base = await api((_req, res) => {
      const [status, body] = answers[i++] ?? [500, {}]
      if (status === 204) return void res.writeHead(204).end()
      json(res, status, body)
    })
    const client = createApiAccessClient({ baseUrl: base, internalSecret: SECRET })
    const many = client.getAccessMany as NonNullable<AccessClient['getAccessMany']>
    await expect(many(pairs)).rejects.toThrow(AccessBatchUnsupportedError)
    await expect(many(pairs)).rejects.toThrow(AccessBatchUnsupportedError)
    for (let k = 2; k < answers.length - 1; k++)
      await expect(many(pairs), JSON.stringify(answers[k])).rejects.toThrow(AccessUnavailableError)
    expect(await many(pairs)).toEqual([{ role: 'viewer' }])
  })
})

describe('the periodic round: one batched call (M7-1)', () => {
  it('50 open pairs: ONE call per round, no per-pair call; above ACCESS_MANY_MAX_PAIRS, one call per chunk, one after another', async () => {
    const { registry, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>()
    for (let b = 0; b < 10; b++)
      for (let u = 0; u < 5; u++) {
        join(board(b), usr(u))
        table.set(`${board(b)}/${usr(u)}`, { role: 'editor', signedInSince: 1 })
      }
    const c = countingClient(table)
    const m = createAccessMonitor({ registry, client: c.client, intervalMs: 10_000, log: quiet })
    await m.checkAll()
    expect(c.batches).toHaveLength(1)
    expect(c.batches[0]).toHaveLength(50)
    expect(c.single).toEqual([])
    await m.checkAll()
    expect(c.batches).toHaveLength(2)
    expect(m.lastRound()).toMatchObject({ pairs: 50, failed: 0, batched: true })

    // 620 pairs: 500 + 120, the second request only once the first has answered
    const big = fakeRegistry()
    const bigTable = new Map<string, AccessAnswer>()
    for (let u = 0; u < 620; u++) {
      big.join(board(1), usr(u))
      bigTable.set(`${board(1)}/${usr(u)}`, { role: 'editor' })
    }
    const c2 = countingClient(bigTable)
    let inFlight = 0
    let maxInFlight = 0
    c2.setBatch(async (pairs) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return pairs.map(() => ({ role: 'editor' }))
    })
    const m2 = createAccessMonitor({
      registry: big.registry,
      client: c2.client,
      intervalMs: 10_000,
      log: quiet,
    })
    await m2.checkAll()
    expect(c2.batches.map((b) => b.length)).toEqual([ACCESS_MANY_MAX_PAIRS, 120])
    expect(maxInFlight).toBe(1)
    expect(c2.single).toEqual([])
  })

  it('a revoked person is closed within one round (FORBIDDEN), a signed-out one NOT_AUTHENTICATED, others stay', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>()
    const a = join(board(1), usr(1))
    const b = join(board(1), usr(2))
    const keep = join(board(1), usr(3))
    const viewer = join(board(2), usr(4), 't', 'viewer')
    table.set(`${board(1)}/${usr(1)}`, { role: null, signedInSince: 5 })
    table.set(`${board(1)}/${usr(2)}`, { role: 'editor', signedInSince: null })
    table.set(`${board(1)}/${usr(3)}`, { role: 'editor', signedInSince: 5 })
    table.set(`${board(2)}/${usr(4)}`, { role: 'editor', signedInSince: 5 }) // raised: reconnect for the new role
    const c = countingClient(table)
    const m = createAccessMonitor({ registry, client: c.client, intervalMs: 10_000, log: quiet })
    for (const [bd, s, u] of [
      [board(1), a, usr(1)],
      [board(1), b, usr(2)],
      [board(1), keep, usr(3)],
      [board(2), viewer, usr(4)],
    ] as const)
      m.admitted(bd, s, u, 10)
    await m.checkAll()
    expect(c.batches).toHaveLength(1)
    expect(closed).toEqual([
      { boardId: board(1), sessionId: a, reason: 'FORBIDDEN' },
      { boardId: board(1), sessionId: b, reason: 'NOT_AUTHENTICATED' },
      { boardId: board(2), sessionId: viewer, reason: undefined },
    ])
  })

  it('an answer never closes a session admitted after the batch was asked', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>([[`${board(1)}/${usr(1)}`, { role: null }]])
    const c = countingClient(table)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    c.setBatch(async (pairs) => {
      await gate
      return pairs.map(() => ({ role: null }))
    })
    const m = createAccessMonitor({ registry, client: c.client, intervalMs: 10_000, log: quiet })
    const early = join(board(1), usr(1), 'early')
    m.admitted(board(1), early, usr(1), 1)
    const round = m.checkAll()
    await Promise.resolve()
    const later = join(board(1), usr(1), 'later') // re-granted meanwhile: a newer ticket
    m.admitted(board(1), later, usr(1), Date.now() + 60_000)
    release()
    await round
    expect(closed.map((x) => x.sessionId)).toEqual([early])
  })

  it('the batch failing keeps every session (fail open), says so once without ids, and the round reads failed', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>()
    for (let u = 0; u < 4; u++) {
      const s = join(board(1), usr(u))
      table.set(`${board(1)}/${usr(u)}`, { role: null })
      void s
    }
    const c = countingClient(table)
    c.setBatch(async () => {
      throw new AccessUnavailableError('timed out')
    })
    const logs: string[] = []
    const m = createAccessMonitor({
      registry,
      client: c.client,
      intervalMs: 10_000,
      log: (...a) => logs.push(a.join(' ')),
    })
    await m.checkAll()
    expect(closed).toEqual([])
    expect(c.single).toEqual([]) // no per-pair storm behind a failing batch
    expect(logs).toEqual(['[access] batched check of 4 pairs failed; keeping their sessions (timed out)'])
    expect(logs.join('\n')).not.toMatch(/usr_|b-0/)
    expect(m.lastRound()).toMatchObject({ pairs: 4, failed: 1 })
    // the api is back: the next round answers (and closes)
    c.setBatch(async (pairs) => pairs.map(() => ({ role: null })))
    await m.checkAll()
    expect(closed).toHaveLength(4)
    expect(m.lastRound()).toMatchObject({ failed: 0 })
  })

  it('ids the contract does not take go per pair, the rest in the batch', async () => {
    const { registry, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>([
      [`${board(1)}/alice`, { role: 'editor' }],
      [`${board(1)}/${usr(1)}`, { role: 'editor' }],
    ])
    join(board(1), 'alice')
    join(board(1), usr(1))
    const c = countingClient(table)
    const m = createAccessMonitor({ registry, client: c.client, intervalMs: 10_000, log: quiet })
    await m.checkAll()
    expect(c.single).toEqual([`${board(1)}/alice`])
    expect(c.batches).toEqual([[{ boardId: board(1), userId: usr(1) }]])
  })
})

describe('an older api (stale pair: this sync against the 4e4a549 api)', () => {
  it('a 404 makes that round per pair (and still revokes); later rounds stay per pair until the hourly re-probe', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>()
    for (let u = 0; u < 50; u++) {
      join(board(u % 10), usr(u))
      table.set(`${board(u % 10)}/${usr(u)}`, { role: u === 7 ? null : 'editor' })
    }
    const c = countingClient(table)
    c.setBatch(async () => {
      throw new AccessBatchUnsupportedError('HTTP 404')
    })
    let now = 1_000_000
    const logs: string[] = []
    const m = createAccessMonitor({
      registry,
      client: c.client,
      intervalMs: 10_000,
      log: (...a) => logs.push(a.join(' ')),
      now: () => now,
    })
    await m.checkAll()
    expect(c.batches).toHaveLength(1)
    expect(c.single).toHaveLength(50)
    expect(closed).toEqual([{ boardId: board(7), sessionId: `${usr(7)}:t`, reason: 'FORBIDDEN' }])
    expect(m.lastRound()).toMatchObject({ failed: 0, batched: false })
    expect(logs.filter((l) => l.includes('no batched access check'))).toHaveLength(1)
    // the next rounds: no batch call at all
    now += BATCH_REPROBE_MS - 1
    await m.checkAll()
    expect(c.batches).toHaveLength(1)
    expect(c.single).toHaveLength(50 + 49)
    // an hour on: the batch is tried again (an api upgraded meanwhile answers it)
    now += 1
    c.setBatch(async (pairs) => pairs.map((p) => table.get(`${p.boardId}/${p.userId}`) ?? { role: null }))
    await m.checkAll()
    expect(c.batches).toHaveLength(2)
    expect(c.single).toHaveLength(99)
    expect(m.lastRound()).toMatchObject({ batched: true })
  })

  it('through the real HTTP client: the api answers the batch route as the 4e4a549 api does (403 Cross-origin) and 200 per pair', async () => {
    const calls: string[] = []
    const base = await api((req, res) => {
      calls.push(`${req.method} ${new URL(req.url ?? '/', 'http://x').pathname}`)
      if (req.method === 'POST')
        return json(res, 403, { error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } })
      const u = new URL(req.url ?? '/', 'http://x').searchParams.get('userId')
      json(res, 200, { role: u === usr(2) ? null : 'editor', signedInSince: 1 })
    })
    const { registry, closed, join } = fakeRegistry()
    const s1 = join(board(1), usr(1))
    const s2 = join(board(1), usr(2))
    const m = createAccessMonitor({
      registry,
      client: createApiAccessClient({ baseUrl: base, internalSecret: SECRET }),
      intervalMs: 10_000,
      log: quiet,
    })
    m.admitted(board(1), s1, usr(1), 10)
    m.admitted(board(1), s2, usr(2), 10)
    await m.checkAll()
    expect(closed).toEqual([{ boardId: board(1), sessionId: s2, reason: 'FORBIDDEN' }])
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual(['POST /internal/access-many'])
    expect(calls.filter((c) => c.startsWith('GET'))).toHaveLength(2)
    await m.checkAll()
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1) // not asked again this hour
  })
})

describe('forced checks stay per pair and immediate', () => {
  it('accessChanged / userChanged ask per pair at once, never the batch', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>([
      [`${board(1)}/${usr(1)}`, { role: null }],
      [`${board(2)}/${usr(2)}`, { role: 'editor', signedInSince: null }],
    ])
    join(board(1), usr(1))
    join(board(2), usr(2))
    const c = countingClient(table)
    const m = createAccessMonitor({ registry, client: c.client, intervalMs: 10_000, log: quiet })
    await m.accessChanged(board(1))
    await m.userChanged(usr(2))
    expect(c.batches).toEqual([])
    expect(c.single).toEqual([`${board(1)}/${usr(1)}`, `${board(2)}/${usr(2)}`])
    expect(closed.map((x) => x.reason)).toEqual(['FORBIDDEN', 'NOT_AUTHENTICATED'])
  })

  it('a change while the round’s batch is in flight for that pair is asked again right after it (never the older answer)', async () => {
    const { registry, closed, join } = fakeRegistry()
    const table = new Map<string, AccessAnswer>([[`${board(1)}/${usr(1)}`, { role: 'editor' }]])
    const sid = join(board(1), usr(1))
    const c = countingClient(table)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    c.setBatch(async (pairs) => {
      const answers = pairs.map(() => ({ role: 'editor' as const })) // asked before the revocation
      await gate
      return answers
    })
    const m = createAccessMonitor({ registry, client: c.client, intervalMs: 10_000, log: quiet })
    m.admitted(board(1), sid, usr(1), 1)
    const round = m.checkAll()
    await Promise.resolve()
    table.set(`${board(1)}/${usr(1)}`, { role: null }) // revoked now
    const forced = m.accessChanged(board(1), usr(1))
    release()
    await Promise.all([round, forced])
    expect(c.single).toEqual([`${board(1)}/${usr(1)}`])
    expect(closed).toEqual([{ boardId: board(1), sessionId: sid, reason: 'FORBIDDEN' }])
  })
})

describe('the round’s interval is jittered ±20 %', () => {
  it('jitteredDelay stays within [0.8, 1.2] of the interval', () => {
    expect(ACCESS_JITTER).toBe(0.2)
    expect(jitteredDelay(10_000, () => 0)).toBe(8_000)
    expect(jitteredDelay(10_000, () => 0.5)).toBe(10_000)
    expect(jitteredDelay(10_000, () => 0.999_999)).toBe(12_000)
    for (let i = 0; i < 1_000; i++) {
      const d = jitteredDelay(10_000)
      expect(d).toBeGreaterThanOrEqual(8_000)
      expect(d).toBeLessThanOrEqual(12_000)
    }
    // out-of-range random sources are clamped
    expect(jitteredDelay(10_000, () => -1)).toBe(8_000)
    expect(jitteredDelay(10_000, () => 7)).toBe(12_000)
  })

  it('the rounds are scheduled with it (fake timers), and stop() ends them', async () => {
    vi.useFakeTimers()
    const { registry, join } = fakeRegistry()
    join(board(1), usr(1))
    const c = countingClient(new Map([[`${board(1)}/${usr(1)}`, { role: 'editor' as const }]]))
    let r = 0 // the first delay is the shortest, the second the longest
    const m = createAccessMonitor({
      registry,
      client: c.client,
      intervalMs: 10_000,
      log: quiet,
      random: () => (r++ % 2 === 0 ? 0 : 0.999_999),
    })
    m.start()
    await vi.advanceTimersByTimeAsync(7_999)
    expect(c.batches).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1) // 8 000: the first round
    expect(c.batches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(11_999)
    expect(c.batches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1) // + 12 000: the second
    expect(c.batches).toHaveLength(2)
    m.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(c.batches).toHaveLength(2)
  })
})
