// Bridge release R0 gate (docs/EXCALIDRAW-MIGRATION.md §5.10, §7.5 step 3): POST /internal/maintenance
// {on} lets the pushes that reached the server commit, closes every socket with 4099 MAINTENANCE, and
// refuses new ones the same way, before any room is touched. Internal reads keep working; the internal
// routes that write a board answer 503 MAINTENANCE. Off again, boards open as before. A restart starts
// with maintenance off (it is a runtime switch).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { JoinQueue } from '../../src/join-queue.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import { callInternal, errorCode, mintTicket } from '../harness/tickets.ts'

const connectOnce = (wsUrl: string, boardId: string, user = 'usr_zed') =>
  new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const ws = new WebSocket(
      `${wsUrl}/connect/${boardId}?sessionId=s-${Math.random().toString(36).slice(2)}&ticket=${encodeURIComponent(mintTicket(boardId, user))}`,
    )
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
    ws.on('error', reject)
  })

describe('JoinQueue.flush', () => {
  it('delivers every complete connect and what queued behind it at once, in order; a partial connect stays held', () => {
    const later: Array<() => void> = []
    const q = new JoinQueue({ schedule: (fn) => later.push(fn) })
    const got: string[] = []
    const connect = (n: number) => `{"type":"connect","n":${n}}`
    q.push(1, connect(1), (t) => got.push(`1:${t}`))
    q.push(1, '{"type":"push","a":1}', (t) => got.push(`1:${t}`))
    q.push(2, connect(2), (t) => got.push(`2:${t}`))
    q.push(3, `1_${connect(3).slice(0, 20)}`, (t) => got.push(`3:${t}`)) // first of two chunks
    q.flush()
    expect(got).toEqual([`1:${connect(1)}`, '1:{"type":"push","a":1}', `2:${connect(2)}`])
    expect(q.size).toBe(1)
    for (const fn of later.splice(0)) fn() // the scheduled turn finds nothing left to do
    expect(got).toHaveLength(3)
  })
})

describe('maintenance mode in the real sync process', () => {
  const h = useProtocolHarness()

  it('closes every socket with 4099 MAINTENANCE after their pushes committed, and refuses new ones', async () => {
    const server = await h.server()
    const b1 = newBoardId()
    const b2 = newBoardId()
    const a = await h.connected(server, { boardId: b1, user: 'usr_alice', autoReconnect: false })
    const b = await h.connected(server, { boardId: b2, user: 'usr_bob', autoReconnect: false })
    a.put(geoShape('before1'))
    b.put(geoShape('before2'))
    await a.waitForAcked()
    await b.waitForAcked()
    // A push sent right before maintenance goes on still commits (it reached the server first).
    a.put(geoShape('last1'))
    await new Promise((r) => setTimeout(r, 50))

    const status0 = await callInternal(server.url, 'GET', '/internal/maintenance')
    expect(await status0.json()).toEqual({ maintenance: false })
    const on = await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: true } })
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ maintenance: true, closedSockets: 2 })
    await a.waitForClose((c) => c.code === 4099 && c.reason === 'MAINTENANCE')
    await b.waitForClose((c) => c.code === 4099 && c.reason === 'MAINTENANCE')
    expect(a.status).toBe('error')

    // new sockets: refused the same way, for an existing board and for a board that has no file yet
    expect(await connectOnce(server.wsUrl, b1)).toEqual({ code: 4099, reason: 'MAINTENANCE' })
    const fresh = newBoardId()
    expect(await connectOnce(server.wsUrl, fresh)).toEqual({ code: 4099, reason: 'MAINTENANCE' })
    expect(existsSync(boardDbPath(join(server.dataDir, 'rooms'), fresh))).toBe(false)
    // an invalid ticket is still refused as one (the ticket check comes first)
    const bad = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
      const ws = new WebSocket(`${server.wsUrl}/connect/${b1}?sessionId=s-bad&ticket=nope`)
      ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
      ws.on('error', reject)
    })
    expect(bad).toEqual({ code: 4099, reason: 'NOT_AUTHENTICATED' })

    // internal reads keep working, and see every push that reached the server
    const snap = await callInternal(server.url, 'GET', `/internal/boards/${b1}/snapshot`)
    expect(snap.status).toBe(200)
    const ids = ((await snap.json()) as { documents: Array<{ state: { id: string } }> }).documents.map(
      (d) => d.state.id,
    )
    expect(ids).toEqual(expect.arrayContaining(['shape:before1', 'shape:last1']))
    expect((await callInternal(server.url, 'GET', `/internal/boards/${b1}/text`)).status).toBe(200)
    expect((await callInternal(server.url, 'GET', `/internal/boards/${b1}/deleted`)).status).toBe(200)
    expect((await callInternal(server.url, 'GET', '/internal/backups/status')).status).toBe(200)
    // the internal routes that write a board are refused
    const writes: Array<[string, unknown]> = [
      [
        `/internal/boards/${fresh}/seed`,
        { snapshot: { schema: draftroomSchema.serialize(), documents: [] } },
      ],
      [`/internal/boards/${b1}/deleted/restore`, { ids: ['shape:before1'] }],
      [
        `/internal/boards/${b1}/place-notes`,
        {
          sessionId: 'pbs_0000000002',
          anonymous: true,
          frame: { id: 'shape:f', pageId: 'page:page', x: 0, y: 0, w: 400, h: 300, name: 'Ideas' },
          notes: [{ id: 'pnt_0000000002', text: 'n', color: 'yellow', authorId: null }],
          authors: [],
        },
      ],
    ]
    for (const [path, body] of writes) {
      const res = await callInternal(server.url, 'POST', path, { body })
      expect({ path, status: res.status }).toEqual({ path, status: 503 })
      expect(await errorCode(res)).toBe('MAINTENANCE')
    }
    expect(existsSync(boardDbPath(join(server.dataDir, 'rooms'), fresh))).toBe(false)

    // on twice: nothing more to close
    const again = await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: true } })
    expect(await again.json()).toEqual({ maintenance: true, closedSockets: 0 })

    // off: boards open again, with everything that was committed
    const off = await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: false } })
    expect(await off.json()).toEqual({ maintenance: false, closedSockets: 0 })
    const view = await h.freshView(server, b1)
    expect([...view.keys()]).toEqual(expect.arrayContaining(['shape:before1', 'shape:last1']))
    const c = await h.connected(server, { boardId: b2, user: 'usr_carol' })
    expect(c.get('shape:before2')).toBeDefined()
    c.dispose()

    // a restart starts with maintenance off
    await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: true } })
    await server.kill('SIGINT')
    await server.restart()
    expect(await (await callInternal(server.url, 'GET', '/internal/maintenance')).json()).toEqual({
      maintenance: false,
    })
  })

  it('guards the routes: the internal secret, the method and the body', async () => {
    const server = await h.server()
    for (const secret of [null, 'wrong']) {
      for (const [method, path] of [
        ['GET', '/internal/maintenance'],
        ['POST', '/internal/maintenance'],
        ['POST', '/internal/backups/run-all'],
      ] as const) {
        const res = await callInternal(
          server.url,
          method,
          path,
          method === 'GET' ? { secret } : { secret, body: { on: true } },
        )
        expect({ path, status: res.status }).toEqual({ path, status: 401 })
      }
    }
    for (const body of [{}, { on: 'yes' }, { on: true, extra: 1 }, [true], null]) {
      const res = await callInternal(server.url, 'POST', '/internal/maintenance', { body })
      expect(res.status).toBe(400)
    }
    const put = await callInternal(server.url, 'PUT', '/internal/maintenance', { body: { on: true } })
    expect(put.status).toBe(405)
    const getRunAll = await callInternal(server.url, 'GET', '/internal/backups/run-all')
    expect(getRunAll.status).toBe(405)
    // nothing above switched it on
    expect(await (await callInternal(server.url, 'GET', '/internal/maintenance')).json()).toEqual({
      maintenance: false,
    })
  })
})
