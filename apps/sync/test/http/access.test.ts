// docs/M1-CONTRACTS.md §7 against an in-process server with a scripted AccessClient: which sessions
// a re-check closes, how (fatal or not), when checks run, and that an unanswerable API closes nothing.
import { afterEach, describe, expect, it } from 'vitest'
import { geoShape } from '../harness/records.ts'
import { NodeSyncClient, type SyncClientOptions } from '../harness/sync-client.ts'
import { callInternal, mintTicket } from '../harness/tickets.ts'
import { sleep, waitFor } from '../harness/wait.ts'
import { fakeAccess, startServer, type TestServer } from './helpers.ts'

let servers: TestServer[] = []
let clients: NodeSyncClient[] = []
afterEach(async () => {
  for (const c of clients) c.dispose()
  await Promise.all(servers.map((s) => s.stop()))
  servers = []
  clients = []
})

async function setup(accessRecheckMs: number) {
  const access = fakeAccess()
  const t = await startServer({ accessClient: access, config: { accessRecheckMs } })
  servers.push(t)
  const client = (opts: Omit<SyncClientOptions, 'wsUrl'>) => {
    const c = new NodeSyncClient({ wsUrl: t.wsUrl, reconnectDelayMs: 50, ...opts })
    clients.push(c)
    return c
  }
  const connected = async (opts: Omit<SyncClientOptions, 'wsUrl'>) => {
    const c = client(opts)
    await c.waitForSynced()
    return c
  }
  return { t, access, client, connected }
}

const BOARD = 'b-accessaaaa'
const OTHER = 'b-accessbbbb'
const accessChanged = (t: TestServer, body: unknown, secret?: string | null) =>
  callInternal(t.url, 'POST', '/internal/access-changed', { body, secret })

describe('periodic re-check (ACCESS_RECHECK_MS)', () => {
  it('revocation closes only that user’s sessions on that board with 4099 FORBIDDEN (terminal) within one interval', async () => {
    const { access, connected } = await setup(200)
    for (const [b, u] of [
      [BOARD, 'alice'],
      [BOARD, 'bob'],
      [OTHER, 'alice'],
    ] as const)
      access.set(b, u, 'editor')
    const alice1 = await connected({ boardId: BOARD, user: 'alice' })
    const alice2 = await connected({ boardId: BOARD, user: 'alice' }) // second tab
    const bob = await connected({ boardId: BOARD, user: 'bob' })
    const aliceElsewhere = await connected({ boardId: OTHER, user: 'alice' })

    access.set(BOARD, 'alice', null)
    const revokedAt = Date.now()
    for (const c of [alice1, alice2]) {
      expect(await c.waitForClose((x) => x.code === 4099, 5_000)).toMatchObject({ reason: 'FORBIDDEN' })
    }
    const took = Date.now() - revokedAt
    expect(took).toBeLessThan(200 + 1_000) // one interval + slack
    await sleep(500)
    for (const c of [alice1, alice2]) {
      expect(c.status).toBe('error')
      expect(c.syncErrors).toEqual(['FORBIDDEN'])
      expect(c.socketGeneration).toBe(1) // terminal: no reconnect attempt
    }
    for (const c of [bob, aliceElsewhere]) {
      expect(c.status).toBe('online')
      expect(c.closes).toEqual([])
    }
  })

  it('asks the API once per (board, user) per round, however many tabs the user has', async () => {
    const { access, connected } = await setup(150)
    access.set(BOARD, 'alice', 'editor')
    await connected({ boardId: BOARD, user: 'alice' })
    await connected({ boardId: BOARD, user: 'alice' })
    await connected({ boardId: BOARD, user: 'alice' })
    access.calls.length = 0
    await sleep(700)
    const rounds = access.calls.length
    expect(rounds).toBeGreaterThanOrEqual(2)
    expect(rounds).toBeLessThanOrEqual(6) // ~4 rounds; 3 tabs would have tripled it
    expect(new Set(access.calls)).toEqual(new Set([`${BOARD}/alice`]))
  })

  it('a role change closes the session non-fatally; the reconnect carries the new role and is read-only', async () => {
    const { access, connected } = await setup(200)
    access.set(BOARD, 'alice', 'editor')
    const a = await connected({ boardId: BOARD, user: 'alice' })
    a.put(geoShape('x', { x: 1 }))
    await a.waitForAcked()
    expect(a.connectEvents()[0]?.isReadonly).toBe(false)

    access.set(BOARD, 'alice', 'viewer')
    a.setRole('viewer') // what the API's ticket endpoint now issues
    const close = await a.waitForClose(() => true, 5_000)
    expect(close.code).not.toBe(4099)
    await waitFor(() => a.socketGeneration === 2 && a.isSynced(), { describe: () => a.describe('reconnect') })
    expect(a.connectEvents().at(-1)?.isReadonly).toBe(true)
    expect(a.syncErrors).toEqual([])

    a.update('shape:x', (r) => ({ ...r, x: 999 }))
    await a.waitForAcked()
    expect(a.pushResults.at(-1)?.action).toBe('discard')
    expect(a.get('shape:x')?.x).toBe(1)
    await sleep(700) // several more rounds: the role now matches, so it stays connected
    expect(a.socketGeneration).toBe(2)
    expect(a.status).toBe('online')
  })

  it('an API that cannot answer closes nothing (fail open) and the failure is logged without secrets', async () => {
    const { t, access, connected } = await setup(100)
    const a = await connected({ boardId: BOARD, user: 'alice' }) // no answer configured -> the fake throws
    await sleep(600)
    expect(access.calls.length).toBeGreaterThanOrEqual(3)
    expect(a.status).toBe('online')
    expect(a.closes).toEqual([])
    a.put(geoShape('still-writable'))
    await a.waitForAcked()
    expect(a.pushResults.at(-1)?.action).toBe('commit')
    const failures = t.logs.filter((l) => l.includes('[access] check failed'))
    expect(failures.length).toBeGreaterThanOrEqual(3)
    expect(failures[0]).toMatch(new RegExp(`board ${BOARD}; keeping its sessions`))
    for (const l of t.logs) expect(l).not.toMatch(/ticket=|v1\.[A-Za-z0-9_-]{20,}/)
  })
})

describe('POST /internal/access-changed', () => {
  it('re-checks immediately (long interval): 204 at once, the revoked session is closed right after', async () => {
    const { t, access, connected } = await setup(60_000)
    access.set(BOARD, 'alice', 'editor')
    access.set(BOARD, 'bob', 'editor')
    const a = await connected({ boardId: BOARD, user: 'alice' })
    const b = await connected({ boardId: BOARD, user: 'bob' })
    access.set(BOARD, 'alice', null)
    const started = Date.now()
    const res = await accessChanged(t, { boardId: BOARD, userId: 'alice' })
    expect(res.status).toBe(204)
    expect(await a.waitForClose((c) => c.code === 4099, 2_000)).toMatchObject({ reason: 'FORBIDDEN' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(access.calls).toEqual([`${BOARD}/alice`]) // only the named user was asked
    expect(b.status).toBe('online')
  })

  it('without userId re-checks every user on that board and no other board', async () => {
    const { t, access, connected } = await setup(60_000)
    for (const u of ['alice', 'bob']) access.set(BOARD, u, 'viewer')
    access.set(OTHER, 'carol', 'editor')
    const a = await connected({ boardId: BOARD, user: 'alice' }) // editor ticket, API now says viewer
    const b = await connected({ boardId: BOARD, user: 'bob', role: 'viewer' })
    await connected({ boardId: OTHER, user: 'carol' })
    expect((await accessChanged(t, { boardId: BOARD })).status).toBe(204)
    await a.waitForClose(() => true, 2_000)
    expect(a.closes[0]?.code).not.toBe(4099) // role change, not revocation
    await sleep(200)
    expect(b.closes).toEqual([]) // role unchanged
    expect(new Set(access.calls)).toEqual(new Set([`${BOARD}/alice`, `${BOARD}/bob`]))
  })

  it('validates its input and ignores callers without the secret', async () => {
    const { t, access, connected } = await setup(60_000)
    access.set(BOARD, 'alice', null)
    const a = await connected({ boardId: BOARD, user: 'alice' })
    for (const secret of [null, 'wrong']) {
      const res = await accessChanged(t, { boardId: BOARD, userId: 'alice' }, secret)
      expect(res.status).toBe(401)
    }
    for (const body of [
      {},
      { boardId: 'Bad-Board' },
      { boardId: BOARD, userId: 42 },
      { boardId: BOARD, userId: '' },
      [],
    ])
      expect((await accessChanged(t, body)).status, JSON.stringify(body)).toBe(400)
    const text = await callInternal(t.url, 'POST', '/internal/access-changed', {
      rawBody: JSON.stringify({ boardId: BOARD }),
      contentType: 'text/plain',
    })
    expect(text.status).toBe(415)
    await sleep(300)
    expect(access.calls).toEqual([]) // nothing above triggered a check
    expect(a.status).toBe('online')
  })
})

describe('stale answers and stale tickets', () => {
  it('an answer requested before a session was admitted never closes that session', async () => {
    const { t, access, connected } = await setup(60_000)
    access.set(BOARD, 'alice', 'editor')
    const tab1 = await connected({ boardId: BOARD, user: 'alice' })
    let release = () => {}
    access.gate = new Promise<void>((r) => {
      release = r
    })
    access.set(BOARD, 'alice', null) // the in-flight check will answer "revoked"...
    const round = t.server.monitor.checkAll()
    await waitFor(() => access.calls.length === 1)
    access.set(BOARD, 'alice', 'editor') // ...but access is re-granted and a new tab joins meanwhile
    const tab2 = await connected({ boardId: BOARD, user: 'alice' })
    access.gate = null
    release()
    await round
    expect(await tab1.waitForClose((c) => c.code === 4099, 2_000)).toMatchObject({ reason: 'FORBIDDEN' })
    await sleep(200)
    expect(tab2.status).toBe('online') // admitted after the question was asked: untouched
    expect(tab2.closes).toEqual([])
  })

  it('an access change during an in-flight periodic check asks again (the in-flight answer predates it)', async () => {
    const { t, access, connected } = await setup(60_000)
    access.set(BOARD, 'alice', 'editor')
    const a = await connected({ boardId: BOARD, user: 'alice' })
    let release = () => {}
    access.gate = new Promise<void>((r) => {
      release = r
    })
    const round = t.server.monitor.checkAll() // will answer 'editor' (read before the change)
    await waitFor(() => access.calls.length === 1)
    access.set(BOARD, 'alice', null)
    expect((await accessChanged(t, { boardId: BOARD, userId: 'alice' })).status).toBe(204)
    access.gate = null
    release()
    await round
    expect(await a.waitForClose((c) => c.code === 4099, 2_000)).toMatchObject({ reason: 'FORBIDDEN' })
    expect(access.calls).toEqual([`${BOARD}/alice`, `${BOARD}/alice`])
  })

  it('a ticket issued before a recorded access change triggers a check as soon as it is admitted', async () => {
    const { t, access, client, connected } = await setup(60_000)
    const issuedBefore = Date.now() - 10_000
    access.set(BOARD, 'alice', null)
    // No live session yet, so this only records the change.
    expect((await accessChanged(t, { boardId: BOARD, userId: 'alice' })).status).toBe(204)
    await sleep(100)
    expect(access.calls).toEqual([])
    // A ticket minted before the revocation is still within its 60 s lifetime.
    const stale = client({
      boardId: BOARD,
      ticket: mintTicket(BOARD, 'alice', 'editor', { now: issuedBefore }),
    })
    expect(await stale.waitForClose((c) => c.code === 4099, 2_000)).toMatchObject({ reason: 'FORBIDDEN' })
    expect(access.calls).toEqual([`${BOARD}/alice`])

    // A user without a recorded change is admitted without any extra API call.
    access.set(BOARD, 'bob', 'editor')
    await connected({ boardId: BOARD, user: 'bob' })
    await sleep(100)
    expect(access.calls).toEqual([`${BOARD}/alice`])
  })
})
