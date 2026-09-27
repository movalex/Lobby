// RETRO-19: accepted canvas writes are reported to the API (dashboard "Edited …"), throttled per
// board, fire-and-forget. In-process server with a fake TouchClient; real sockets and TLSyncClients.
import { afterEach, describe, expect, it } from 'vitest'
import type { TouchClient } from '../../src/touch.ts'
import { geoShape } from '../harness/records.ts'
import { NodeSyncClient, type SyncClientOptions } from '../harness/sync-client.ts'
import { callInternal } from '../harness/tickets.ts'
import { sleep, waitFor } from '../harness/wait.ts'
import { startServer, type TestServer } from './helpers.ts'

let servers: TestServer[] = []
let clients: NodeSyncClient[] = []
afterEach(async () => {
  for (const c of clients) c.dispose()
  await Promise.all(servers.map((s) => s.stop()))
  servers = []
  clients = []
})

async function setup(touchIntervalMs: number, behave?: () => Promise<void>) {
  const calls: { boardId: string; at: number }[] = []
  const touchClient: TouchClient = {
    touched(boardId, at) {
      calls.push({ boardId, at })
      return behave ? behave() : Promise.resolve()
    },
  }
  const t = await startServer({ touchClient, config: { touchIntervalMs } })
  servers.push(t)
  const connected = async (opts: Omit<SyncClientOptions, 'wsUrl'>) => {
    const c = new NodeSyncClient({ wsUrl: t.wsUrl, reconnectDelayMs: 50, ...opts })
    clients.push(c)
    await c.waitForSynced()
    return c
  }
  return { t, calls, connected }
}

const BOARD = 'b-touchaaaaa'
const OTHER = 'b-touchbbbbb'

describe('board edit reports (touch)', () => {
  it('an accepted write is reported at once; a burst becomes one trailing report with the last write time', async () => {
    const { calls, connected } = await setup(400)
    const alice = await connected({ boardId: BOARD, user: 'alice' })
    expect(calls).toEqual([]) // joining is not an edit
    const before = Date.now()
    alice.put(geoShape('first'))
    await alice.waitForAcked()
    await waitFor(() => calls.length === 1)
    expect(calls[0]?.boardId).toBe(BOARD)
    expect(calls[0]?.at).toBeGreaterThanOrEqual(before)

    for (let i = 0; i < 5; i++) {
      alice.put(geoShape(`burst-${i}`))
      await alice.waitForAcked()
    }
    const lastWrite = Date.now()
    expect(calls).toHaveLength(1) // throttled
    await waitFor(() => calls.length === 2, { timeoutMs: 2_000 })
    expect(calls[1]?.at).toBeLessThanOrEqual(lastWrite)
    expect(calls[1]?.at).toBeGreaterThan(calls[0]?.at ?? 0)
    await sleep(600)
    expect(calls).toHaveLength(2) // nothing more without new writes
  })

  it('presence, a read-only session’s forged writes and a vetoed nothing are not edits; boards are throttled apart', async () => {
    const { calls, connected } = await setup(60_000)
    const alice = await connected({ boardId: BOARD, user: 'alice' })
    const viewer = await connected({ boardId: BOARD, user: 'vic', role: 'viewer' })
    alice.setPresence({ userName: 'alice' })
    viewer.setPresence({ userName: 'vic' })
    viewer.sendRawPush({ 'shape:forged': ['put', geoShape('forged')] })
    await viewer.waitForAcked()
    await sleep(200)
    expect(calls).toEqual([])

    const other = await connected({ boardId: OTHER, user: 'alice' })
    alice.put(geoShape('a'))
    other.put(geoShape('b'))
    await Promise.all([alice.waitForAcked(), other.waitForAcked()])
    await waitFor(() => calls.length === 2)
    expect(calls.map((c) => c.boardId).sort()).toEqual([BOARD, OTHER].sort())
  })

  it('a slow or failing api never delays the room: edits keep flowing while reports hang', async () => {
    const { calls, connected } = await setup(0, () => new Promise<void>(() => {})) // never settles
    const alice = await connected({ boardId: BOARD, user: 'alice' })
    const bob = await connected({ boardId: BOARD, user: 'bob' })
    const started = Date.now()
    for (let i = 0; i < 10; i++) {
      alice.put(geoShape(`n-${i}`))
      await alice.waitForAcked()
    }
    await waitFor(() => bob.get(geoShape('n-9').id))
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(calls.length).toBeGreaterThanOrEqual(10) // interval 0: every write reported, none awaited
  })

  it('a restore from "Recently deleted" counts as an edit', async () => {
    const { t, calls, connected } = await setup(0)
    const alice = await connected({ boardId: BOARD, user: 'alice' })
    const shape = geoShape('restored')
    alice.put(shape)
    await alice.waitForAcked()
    alice.remove(shape.id)
    await alice.waitForAcked()
    await waitFor(() => calls.length === 2)
    const res = await callInternal(t.url, 'POST', `/internal/boards/${BOARD}/deleted/restore`, {
      body: { ids: [shape.id] },
    })
    expect(res.status).toBe(200)
    await waitFor(() => calls.length === 3)
  })
})
