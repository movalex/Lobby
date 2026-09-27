// docs/M1-CONTRACTS.md §8 against an in-process server: GET …/snapshot and POST …/seed, including
// the property that matters most: a seed can never overwrite (wipe) a board that has data.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { CameraRecordType, createUserId, InstancePresenceRecordType, PageRecordType } from '@tldraw/tlschema'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FILE_CARD_SEQUENCE,
  fileCard,
  fileCardFutureSchema,
  fileCardV0,
  fileCardV0Schema,
  geoShape,
  type ShapeRecord,
  TEST_DERIVATIVE_ID,
} from '../harness/records.ts'
import { NodeSyncClient, type SyncClientOptions } from '../harness/sync-client.ts'
import { callInternal, errorCode, TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { waitFor as waitUntil } from '../harness/wait.ts'
import { req, startServer, type TestServer, waitFor } from './helpers.ts'

let servers: TestServer[] = []
let clients: NodeSyncClient[] = []
afterEach(async () => {
  for (const c of clients) c.dispose()
  await Promise.all(servers.map((s) => s.stop()))
  servers = []
  clients = []
})

async function server(): Promise<TestServer> {
  const t = await startServer()
  servers.push(t)
  return t
}

async function connected(t: TestServer, opts: Omit<SyncClientOptions, 'wsUrl'>): Promise<NodeSyncClient> {
  const c = new NodeSyncClient({ wsUrl: t.wsUrl, ...opts })
  clients.push(c)
  await c.waitForSynced()
  return c
}

let n = 0
const board = () => `b-internal${String(++n).padStart(2, '0')}`
const dbFile = (t: TestServer, boardId: string) => join(t.roomsDir, `board-${boardId}.sqlite`)

const seedBody = (records: ShapeRecord[], schema = draftroomSchema) => ({
  snapshot: {
    schema: schema.serialize(),
    documents: records.map((state) => ({ state, lastChangedClock: 7 })),
  },
})
const seed = (t: TestServer, boardId: string, body: unknown) =>
  callInternal(t.url, 'POST', `/internal/boards/${boardId}/seed`, { body })
const snapshot = async (t: TestServer, boardId: string) => {
  const res = await callInternal(t.url, 'GET', `/internal/boards/${boardId}/snapshot`)
  expect(res.status).toBe(200)
  expect(res.headers.get('cache-control')).toBe('no-store')
  return (await res.json()) as { documents: Array<{ state: ShapeRecord }>; schema: unknown }
}
const validPresence = InstancePresenceRecordType.create({
  id: InstancePresenceRecordType.createId('p'),
  currentPageId: PageRecordType.createId('page'),
  userId: createUserId('x'),
  userName: 'x',
})
const validCamera = CameraRecordType.create({ id: CameraRecordType.createId('page') })
for (const r of [validPresence, validCamera]) draftroomSchema.types[r.typeName].validate(r as never)

const ids = (snap: { documents: Array<{ state: { id: string } }> }) =>
  snap.documents.map((d) => d.state.id).sort()

describe('GET /internal/boards/:bid/snapshot', () => {
  it('returns the current records of a live board (edits and deletes included)', async () => {
    const t = await server()
    const boardId = board()
    const a = await connected(t, { boardId, user: 'alice' })
    a.put(geoShape('one', { x: 1 }), geoShape('two', { x: 2 }))
    a.update('shape:one', (r) => ({ ...r, x: 100 }))
    a.remove('shape:two')
    await a.waitForAcked()

    const snap = await snapshot(t, boardId)
    expect(ids(snap)).toEqual(['document:document', 'page:page', 'shape:one'])
    expect(snap.documents.find((d) => d.state.id === 'shape:one')?.state.x).toBe(100)
    expect(snap.schema).toEqual(draftroomSchema.serialize())
  })

  it('reopens an evicted board to read it, and answers a never-opened board without creating storage', async () => {
    const t = await server()
    const boardId = board()
    expect((await seed(t, boardId, seedBody([geoShape('kept', { x: 3 })]))).status).toBe(201)
    await waitFor(() => !t.server.registry.has(boardId), 5_000, 'eviction') // idleEvictMs 50
    const snap = await snapshot(t, boardId)
    expect(ids(snap)).toContain('shape:kept')

    const fresh = board()
    expect(ids(await snapshot(t, fresh))).toEqual(['document:document', 'page:page'])
    expect(existsSync(dbFile(t, fresh))).toBe(false)
    expect((await seed(t, fresh, seedBody([geoShape('late')]))).status).toBe(201) // still seedable
  })

  it('rejects a bad board id', async () => {
    const t = await server()
    for (const id of ['Board-Upper', '..%2Fx', 'ab'])
      expect((await callInternal(t.url, 'GET', `/internal/boards/${id}/snapshot`)).status, id).toBe(400)
  })
})

describe('POST /internal/boards/:bid/seed', () => {
  it('seeds a new board; a client connecting afterwards is served exactly the seeded records', async () => {
    const t = await server()
    const boardId = board()
    const res = await seed(
      t,
      boardId,
      seedBody([geoShape('s1', { x: 11 }), fileCard('card', { posterDerivativeId: TEST_DERIVATIVE_ID })]),
    )
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ boardId, records: 4 }) // + default document and page

    const c = await connected(t, { boardId, user: 'bob' })
    expect(c.get('shape:s1')?.x).toBe(11)
    expect(c.get('shape:card')?.props).toMatchObject({ posterDerivativeId: TEST_DERIVATIVE_ID })
    expect(c.get('page:page')).toBeDefined()
    c.put(geoShape('after'))
    await c.waitForAcked()
    expect(c.pushResults.at(-1)?.action).toBe('commit') // a seeded board is an ordinary board
  })

  it('409 on a board that already has data (open, or closed after eviction) and the data is untouched', async () => {
    const t = await server()
    const boardId = board()
    const a = await connected(t, { boardId, user: 'alice' })
    a.put(geoShape('mine', { x: 5 }))
    await a.waitForAcked()

    const res = await seed(t, boardId, seedBody([geoShape('intruder')]))
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('BOARD_EXISTS')
    expect(a.status).toBe('online') // the live session was not disturbed
    expect(a.closes).toEqual([])
    expect(ids(await snapshot(t, boardId))).toEqual(['document:document', 'page:page', 'shape:mine'])

    a.dispose()
    await waitFor(() => !t.server.registry.has(boardId), 15_000, 'eviction') // ~5 s session grace
    expect((await seed(t, boardId, seedBody([geoShape('intruder')]))).status).toBe(409)
    const snap = await snapshot(t, boardId)
    expect(ids(snap)).toEqual(['document:document', 'page:page', 'shape:mine'])
    expect(snap.documents.find((d) => d.state.id === 'shape:mine')?.state.x).toBe(5)
  })

  it('concurrent seeds of one new board: exactly one wins, the rest get 409, the winner is intact', async () => {
    const t = await server()
    const boardId = board()
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => seed(t, boardId, seedBody([geoShape(`v${i}`)]))),
    )
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 201)).toHaveLength(1)
    expect(statuses.filter((s) => s === 409)).toHaveLength(11)
    const winner = statuses.indexOf(201)
    expect(ids(await snapshot(t, boardId))).toEqual(['document:document', 'page:page', `shape:v${winner}`])
  })

  it('racing a seed against first connects never loses an acknowledged edit', async () => {
    const t = await server()
    for (let round = 0; round < 8; round++) {
      const boardId = board()
      const c = new NodeSyncClient({ wsUrl: t.wsUrl, boardId, user: 'racer' })
      clients.push(c)
      const [res] = await Promise.all([seed(t, boardId, seedBody([geoShape('seeded')])), c.waitForSynced()])
      // Either the seed initialized the board and the client opened it, or the client did first.
      if (res.status === 201) await waitUntil(() => c.get('shape:seeded'))
      else expect(res.status).toBe(409)
      c.put(geoShape('acked', { x: round }))
      await c.waitForAcked()
      expect((await seed(t, boardId, seedBody([geoShape('late')]))).status).toBe(409)
      const snap = await snapshot(t, boardId)
      expect(ids(snap)).toContain('shape:acked')
      expect(ids(snap).includes('shape:seeded')).toBe(res.status === 201)
      expect(ids(snap)).not.toContain('shape:late')
      c.dispose()
    }
  })

  it('migrates a snapshot from an older schema before storing it (file card v0 -> posterDerivativeId: null)', async () => {
    const t = await server()
    const boardId = board()
    expect(
      (await seed(t, boardId, seedBody([fileCardV0('old', { name: 'old.pdf' })], fileCardV0Schema))).status,
    ).toBe(201)
    const snap = await snapshot(t, boardId)
    expect((snap.schema as { sequences: Record<string, number> }).sequences[FILE_CARD_SEQUENCE]).toBe(1)
    expect(snap.documents.find((d) => d.state.id === 'shape:old')?.state.props).toMatchObject({
      name: 'old.pdf',
      posterDerivativeId: null,
    })
  })

  it('accepts what GET …/snapshot returns (copy a board into a new one)', async () => {
    const t = await server()
    const from = board()
    const a = await connected(t, { boardId: from, user: 'alice' })
    a.put(geoShape('x', { x: 42 }), fileCard('c'))
    await a.waitForAcked()
    const source = await snapshot(t, from)
    const to = board()
    expect((await seed(t, to, { snapshot: source })).status).toBe(201)
    const copy = await snapshot(t, to)
    expect(copy.documents.map((d) => d.state)).toEqual(source.documents.map((d) => d.state))
  })

  it('rejects invalid snapshots with 400 and writes nothing', async () => {
    const t = await server()
    const boardId = board()
    const good = geoShape('ok')
    const cases: Array<[string, unknown]> = [
      ['no snapshot', {}],
      ['snapshot not an object', { snapshot: [] }],
      ['no schema', { snapshot: { documents: [{ state: good, lastChangedClock: 0 }] } }],
      ['no records', { snapshot: { schema: draftroomSchema.serialize() } }],
      ['record without id', seedBody([{ ...good, id: undefined } as unknown as ShapeRecord])],
      ['wrong prop type', seedBody([{ ...good, x: 'left' } as unknown as ShapeRecord])],
      ['unknown shape type', seedBody([{ ...good, type: 'not-registered' }])],
      [
        'signed URL in a file card',
        seedBody([
          { ...fileCard('f'), props: { ...fileCard('f').props, posterDerivativeId: 'https://x/y?sig=1' } },
        ]),
      ],
      [
        'unknown record type',
        seedBody([{ ...good, id: 'thing:1', typeName: 'thing' } as unknown as ShapeRecord]),
      ],
      [
        // schema-valid, so only the scope rule can reject it
        'presence record (never board data)',
        seedBody([validPresence as unknown as ShapeRecord]),
      ],
      ['session record (camera)', seedBody([validCamera as unknown as ShapeRecord])],
      ['duplicate ids', seedBody([good, good])],
      [
        'store key != id',
        { snapshot: { schema: draftroomSchema.serialize(), store: { 'shape:other': good } } },
      ],
      ['newer schema than the server', seedBody([fileCard('f')], fileCardFutureSchema)],
    ]
    for (const [label, body] of cases) {
      const res = await seed(t, boardId, body)
      expect(res.status, label).toBe(400)
      expect(await errorCode(res), label).toBe('INVALID_SNAPSHOT')
    }
    const bad = await callInternal(t.url, 'POST', `/internal/boards/${boardId}/seed`, {
      rawBody: '{"snapshot":',
    })
    expect(bad.status).toBe(400)
    expect(await errorCode(bad)).toBe('INVALID_JSON')
    const type = await callInternal(t.url, 'POST', `/internal/boards/${boardId}/seed`, {
      rawBody: JSON.stringify(seedBody([good])),
      contentType: 'text/plain',
    })
    expect(type.status).toBe(415)
    // refused from the declared length alone, before any of the body is read
    const huge = await req(t.port, {
      method: 'POST',
      path: `/internal/boards/${boardId}/seed`,
      headers: {
        'x-draftroom-internal': TEST_INTERNAL_SECRET,
        'content-type': 'application/json',
        'content-length': String(65 * 1024 * 1024),
      },
      body: 'none',
    })
    expect(huge.status).toBe(413)
    expect(huge.headers.connection).toBe('close')
    expect(existsSync(dbFile(t, boardId))).toBe(false)
    expect(t.server.registry.has(boardId)).toBe(false)
    expect((await seed(t, boardId, seedBody([good]))).status).toBe(201) // and it is still seedable
  })

  it('never writes without the internal secret', async () => {
    const t = await server()
    const boardId = board()
    for (const secret of [
      null,
      'wrong',
      TEST_INTERNAL_SECRET.toUpperCase(),
      TEST_INTERNAL_SECRET.slice(0, -1),
    ]) {
      const res = await callInternal(t.url, 'POST', `/internal/boards/${boardId}/seed`, {
        body: seedBody([geoShape('x')]),
        secret,
      })
      expect(res.status).toBe(401)
      const snap = await callInternal(t.url, 'GET', `/internal/boards/${boardId}/snapshot`, { secret })
      expect(snap.status).toBe(401)
    }
    expect(existsSync(dbFile(t, boardId))).toBe(false)
  })
})
