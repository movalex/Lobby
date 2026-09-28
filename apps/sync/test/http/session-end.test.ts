// Automatic checkpoints (docs/WAVE4-CONTRACTS.md checkpoints-2): the sync server tells the API when the
// last editor left a board after changes. In-process server with a fake SessionEndClient; real sockets
// and TLSyncClients.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSyncServer } from '../../src/app.ts'
import type { SessionEndClient } from '../../src/session-end.ts'
import { geoShape } from '../harness/records.ts'
import { NodeSyncClient, type SyncClientOptions } from '../harness/sync-client.ts'
import { callInternal } from '../harness/tickets.ts'
import { sleep, waitFor } from '../harness/wait.ts'
import { testConfig } from './helpers.ts'

const BOARD = 'b-sessendaaa'
const OTHER = 'b-sessendbbb'

let cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.reverse()) await c()
  cleanup = []
})

async function setup() {
  const calls: { boardId: string; at: number }[] = []
  const sessionEndClient: SessionEndClient = {
    async ended(boardId, at) {
      calls.push({ boardId, at })
    },
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'dr-sync-session-end-'))
  const server = createSyncServer(testConfig(dataDir), {
    log: () => {},
    sessionEndClient,
    touchClient: { touched: async () => {} },
  })
  const { port } = await server.listen()
  const clients: NodeSyncClient[] = []
  cleanup.push(async () => {
    for (const c of clients) c.dispose()
    await server.close()
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  const connected = async (opts: Omit<SyncClientOptions, 'wsUrl'>) => {
    const c = new NodeSyncClient({ wsUrl: `ws://127.0.0.1:${port}`, reconnectDelayMs: 50, ...opts })
    clients.push(c)
    await c.waitForSynced()
    return c
  }
  return { calls, connected, url: `http://127.0.0.1:${port}` }
}

describe('session end reports (automatic checkpoints)', () => {
  it('the last editor leaving after an edit is reported once; the other editor leaving first is not', async () => {
    const { calls, connected } = await setup()
    const alice = await connected({ boardId: BOARD, user: 'alice' })
    const bob = await connected({ boardId: BOARD, user: 'bob', role: 'owner' })
    alice.put(geoShape('edit'))
    await alice.waitForAcked()
    const before = Date.now()
    alice.dispose() // bob is still here
    await sleep(300)
    expect(calls).toEqual([])
    bob.dispose()
    await waitFor(() => calls.length === 1)
    expect(calls[0]?.boardId).toBe(BOARD)
    expect(calls[0]?.at).toBeGreaterThanOrEqual(before)
    await sleep(300)
    expect(calls).toHaveLength(1)
  })

  it('editors who only looked, and viewers who stay or leave, cause no report; the editor leaving does', async () => {
    const { calls, connected } = await setup()
    const looker = await connected({ boardId: OTHER, user: 'lou' })
    looker.dispose()
    await sleep(300)
    expect(calls).toEqual([])

    const vic = await connected({ boardId: BOARD, user: 'vic', role: 'viewer' })
    const alice = await connected({ boardId: BOARD, user: 'alice' })
    alice.put(geoShape('edit'))
    await alice.waitForAcked()
    alice.dispose() // vic (a viewer) stays: no editor is left
    await waitFor(() => calls.length === 1)
    vic.dispose()
    await sleep(300)
    expect(calls.map((c) => c.boardId)).toEqual([BOARD])
  })

  it('a change made while no editor is connected (Recently deleted restore) is reported when the next editor leaves', async () => {
    const { calls, connected, url } = await setup()
    const alice = await connected({ boardId: BOARD, user: 'alice' })
    const shape = geoShape('back')
    alice.put(shape)
    await alice.waitForAcked()
    alice.remove(shape.id)
    await alice.waitForAcked()
    alice.dispose()
    await waitFor(() => calls.length === 1)

    const vic = await connected({ boardId: BOARD, user: 'vic', role: 'viewer' })
    const res = await callInternal(url, 'POST', `/internal/boards/${BOARD}/deleted/restore`, {
      body: { ids: [shape.id] },
    })
    expect(res.status).toBe(200)
    await waitFor(() => vic.get(shape.id) !== undefined)
    vic.dispose()
    await sleep(300)
    expect(calls).toHaveLength(1) // a viewer leaving never reports
    const bob = await connected({ boardId: BOARD, user: 'bob' })
    bob.dispose()
    await waitFor(() => calls.length === 2)
  })
})
