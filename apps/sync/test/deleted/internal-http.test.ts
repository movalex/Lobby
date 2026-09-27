// GET /internal/boards/:bid/deleted and POST …/deleted/restore on a real server with a real
// TLSyncClient over WebSocket (what the API proxies for "Recently deleted").
import { afterEach, describe, expect, it } from 'vitest'
import { geoShape, noteShape } from '../harness/records.ts'
import { NodeSyncClient } from '../harness/sync-client.ts'
import { callInternal, errorCode } from '../harness/tickets.ts'
import { waitFor } from '../harness/wait.ts'
import { startServer, type TestServer } from '../http/helpers.ts'

let servers: TestServer[] = []
let clients: NodeSyncClient[] = []
afterEach(async () => {
  for (const c of clients) c.dispose()
  await Promise.all(servers.map((s) => s.stop()))
  servers = []
  clients = []
})

async function setup() {
  const t = await startServer()
  servers.push(t)
  const connect = async (user: string) => {
    const c = new NodeSyncClient({ wsUrl: t.wsUrl, boardId: 'b-deletedhttp', user })
    clients.push(c)
    await c.waitForSynced()
    return c
  }
  return { t, connect }
}

const list = async (t: TestServer, board = 'b-deletedhttp', query = '') => {
  const res = await callInternal(t.url, 'GET', `/internal/boards/${board}/deleted${query}`)
  return {
    status: res.status,
    body: (await res.json()) as { entries: { shapeId: string }[]; total: number; limit: number },
  }
}

describe('internal recently-deleted endpoints', () => {
  it('lists deletes made over the wire and restores them to every connected client', async () => {
    const { t, connect } = await setup()
    const alice = await connect('usr_alice')
    const bob = await connect('usr_bob')
    alice.put(noteShape('n1', 'hello'), geoShape('g1', { x: 300, index: 'a2' }))
    await alice.waitForAcked()
    await waitFor(() => bob.get('shape:g1') !== undefined)
    alice.remove('shape:n1', 'shape:g1')
    await alice.waitForAcked()
    await waitFor(() => bob.get('shape:n1') === undefined)

    const listed = await list(t)
    expect(listed.status).toBe(200)
    expect(listed.body.entries.map((e) => e.shapeId).sort()).toEqual(['shape:g1', 'shape:n1'])
    expect(listed.body).toMatchObject({ total: 2, limit: 2000 })
    expect((await list(t, 'b-deletedhttp', '?limit=1')).body.entries).toHaveLength(1)

    const res = await callInternal(t.url, 'POST', '/internal/boards/b-deletedhttp/deleted/restore', {
      body: { ids: ['shape:n1'] },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ restored: ['shape:n1'], skipped: [], bindings: 0, reparented: 0 })
    await waitFor(() => bob.get('shape:n1') !== undefined)
    await waitFor(() => alice.get('shape:n1') !== undefined)
    expect((await list(t)).body.entries.map((e) => e.shapeId)).toEqual(['shape:g1'])
  })

  it('answers an empty list for a board without storage (and creates nothing)', async () => {
    const { t } = await setup()
    const res = await list(t, 'b-neverseen0')
    expect(res).toEqual({ status: 200, body: { entries: [], total: 0, limit: 2000 } })
  })

  it('requires the internal secret and validates its input', async () => {
    const { t } = await setup()
    expect(
      (await callInternal(t.url, 'GET', '/internal/boards/b-x00000000/deleted', { secret: null })).status,
    ).toBe(401)
    expect(
      (
        await callInternal(t.url, 'POST', '/internal/boards/b-x00000000/deleted/restore', {
          secret: 'wrong',
          body: {},
        })
      ).status,
    ).toBe(401)
    const bad = await callInternal(t.url, 'GET', '/internal/boards/NOT_OK/deleted')
    expect(bad.status).toBe(400)
    expect(await errorCode(bad)).toBe('INVALID_BOARD_ID')
    expect((await callInternal(t.url, 'GET', '/internal/boards/b-x00000000/deleted?limit=0')).status).toBe(
      400,
    )
    for (const body of [
      {},
      { ids: [] },
      { ids: ['not-a-shape'] },
      { ids: Array(501).fill('shape:a') },
      { ids: [1] },
    ]) {
      const r = await callInternal(t.url, 'POST', '/internal/boards/b-x00000000/deleted/restore', { body })
      expect(r.status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    expect((await callInternal(t.url, 'PUT', '/internal/boards/b-x00000000/deleted')).status).toBe(405)
  })
})
