// Room registry behavior seen from outside: one room (one SQLite file) per board even under a
// connection stampede, and idle eviction that closes the DB without crashing and reopens it intact.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { newBoardId, roomFiles, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import type { NodeSyncClient } from '../harness/sync-client.ts'
import { sleep, waitFor } from '../harness/wait.ts'

const h = useProtocolHarness()

describe('room creation', () => {
  it('20 clients connecting at once to a brand-new board share one room: all converge on the same 20 shapes, one board file', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const clients: NodeSyncClient[] = []
    for (let i = 0; i < 20; i++) clients.push(h.client(server, { boardId, user: `user-${i}` })) // same tick
    await Promise.all(clients.map((c) => c.waitForSynced(15_000)))

    clients.forEach((c, i) => {
      c.put(geoShape(`s${i}`, { x: i }))
    })
    await Promise.all(clients.map((c) => c.waitForAcked(15_000)))
    const expected = clients.map((_, i) => `shape:s${i}`).sort()
    const ids = (c: NodeSyncClient) =>
      c
        .shapes()
        .map((s) => s.id as string)
        .sort()
    await waitFor(() => clients.every((c) => ids(c).length === 20), {
      timeoutMs: 15_000,
      describe: () => clients.map((c) => `${c.name}:${ids(c).length}`).join(' '),
    })
    for (const c of clients) expect(ids(c)).toEqual(expected)
    expect([...(await h.freshView(server, boardId)).keys()].sort()).toEqual(expected)

    const files = roomFiles(server.dataDir)
    expect(files.filter((f) => f.endsWith('.sqlite'))).toEqual([`board-${boardId}.sqlite`])
    expect(files.every((f) => f.startsWith(`board-${boardId}.sqlite`))).toBe(true)
  })
})

describe('idle eviction', () => {
  it('evicts an idle room (DB closed) without crashing, then reopens it with records, deletes and clock intact', async () => {
    const server = await h.server({ env: { IDLE_EVICT_MS: '200' } })
    const boardId = newBoardId()
    const wal = join(server.dataDir, 'rooms', `board-${boardId}.sqlite-wal`)

    const a = await h.connected(server, { boardId, user: 'alice' })
    const stale = await h.connected(server, { boardId, user: 'bob' })
    a.put(geoShape('keep', { x: 1 }), geoShape('gone', { x: 2 }))
    await a.waitForAcked()
    await waitFor(() => stale.get('shape:gone'))
    stale.goOffline() // holds a lastServerClock from before the delete

    a.remove('shape:gone')
    a.update('shape:keep', (r) => ({ ...r, x: 10 }))
    await a.waitForAcked()
    a.dispose()
    expect(existsSync(wal)).toBe(true) // room open

    // SQLite removes the -wal file when the last connection closes: the room was evicted.
    // ~5 s session-removal grace + up to 2 s prune interval + IDLE_EVICT_MS.
    const evictStart = Date.now()
    await waitFor(() => !existsSync(wal), { timeoutMs: 20_000, intervalMs: 100 })
    const evictedAfterMs = Date.now() - evictStart
    // Still alive well past SQLiteSyncStorage's 1 s trailing prune timer. (Through the protocol the
    // last delete is always >= 5 s old when a room closes, because of the session-removal grace, so
    // this checks eviction + reopen health rather than hitting the prune-after-close window itself.)
    await sleep(1_500)
    expect(server.exitInfo(), server.logs()).toBeNull()
    expect((await fetch(`${server.url}/healthz`)).status).toBe(200)

    // a client that was offline across the eviction catches up incrementally from the reopened room
    stale.goOnline()
    await stale.waitForSynced()
    expect(stale.connectEvents().at(-1)?.hydrationType).toBe('wipe_presence')
    expect(stale.get('shape:gone')).toBeUndefined()
    expect(stale.get('shape:keep')?.x).toBe(10)

    const fresh = await h.freshView(server, boardId)
    expect([...fresh.keys()]).toEqual(['shape:keep'])
    expect(fresh.get('shape:keep')?.x).toBe(10)
    console.info(`[eviction] room closed ${evictedAfterMs} ms after the last session left`)
  })
})
