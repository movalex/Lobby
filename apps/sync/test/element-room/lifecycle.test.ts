// §6.2 `schema`, `validation` (the message level), `room-lifecycle` and `internal` (spike subset),
// through the real server process: version refusals, malformed messages, 20 concurrent first connects
// making one room and one file, eviction and reopen keeping clock, rows and tombstones, the internal
// snapshot and metrics routes, and the test routes existing only with DRAFTROOM_TEST_HOOKS=1.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LobbyElementsSnapshot } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { callInternal } from '../harness/tickets.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('versions and malformed messages', () => {
  const cases: [string, unknown, number, string][] = [
    [
      'a newer protocol',
      { type: 'hello', proto: 2, schema: 1, since: 0, epoch: null, tab: 't' },
      4099,
      'SERVER_TOO_OLD',
    ],
    [
      'an older protocol',
      { type: 'hello', proto: 0, schema: 1, since: 0, epoch: null, tab: 't' },
      4099,
      'CLIENT_TOO_OLD',
    ],
    [
      'a newer element schema',
      { type: 'hello', proto: 1, schema: 2, since: 0, epoch: null, tab: 't' },
      4099,
      'SERVER_TOO_OLD',
    ],
    ['a tldraw connect message', { type: 'connect', protocolVersion: 7 }, 4099, 'CLIENT_TOO_OLD'],
    [
      'a push before hello',
      { type: 'push', seq: 1, base: 0, ops: [{ k: 'c', el: rect('x') }] },
      4099,
      'INVALID_MESSAGE',
    ],
    [
      'a presence naming an identity',
      { type: 'hello', proto: 1, schema: 1, since: 0, epoch: null, tab: 't', uid: 'x' },
      4099,
      'INVALID_MESSAGE',
    ],
    ['not JSON', '{nope', 4099, 'INVALID_MESSAGE'],
  ]
  for (const [name, frame, code, reason] of cases)
    it(`${name} → ${code} ${reason}`, async () => {
      const st = await h.stack()
      const c = await st.socket({ boardId: newBoardId(), user: 'alice' })
      c.send(frame)
      expect(await c.untilClosed()).toMatchObject({ code, reason })
    })

  it('after hello, a presence message with identity fields closes 4099 INVALID_MESSAGE', async () => {
    const st = await h.stack()
    const c = await st.client({ boardId: newBoardId(), user: 'alice' })
    c.send({
      type: 'presence',
      pointer: null,
      button: 'up',
      sel: [],
      view: null,
      idle: false,
      editing: null,
      uid: 'bob',
    })
    expect(await c.untilClosed()).toMatchObject({ code: 4099, reason: 'INVALID_MESSAGE' })
  })

  it('a bad op is INVALID in its place; the rest of the push is applied and the socket stays open', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const c = await st.client({ boardId: b, user: 'alice' })
    const ack = await c.push([
      { k: 'c', el: rect('ok1') },
      { k: 'c', el: { nope: true } },
      { k: 'x' },
      { k: 'c', el: rect('ok2') },
    ])
    expect(ack.r.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['ok', 'INVALID', 'INVALID', 'ok'])
    expect(c.closeCode).toBeNull()
    expect((await st.snapshot(b)).elements.map((e) => e.id).sort()).toEqual(['ok1', 'ok2'])
  })
})

describe('room lifecycle', () => {
  it('20 concurrent first connects: one room, one board file, one epoch', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const clients = await Promise.all(
      Array.from({ length: 20 }, (_, i) => st.client({ boardId: b, user: `u${i}` })),
    )
    expect(new Set(clients.map((c) => c.epoch)).size).toBe(1)
    const files = readdirSync(join(st.server.dataDir, 'rooms')).filter((f) => f.endsWith('.sqlite'))
    expect(files).toHaveLength(1)
  })

  it('evicted when idle; reopened with its clock, rows and tombstones', async () => {
    const st = await h.stack({ env: { IDLE_EVICT_MS: '200' } })
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1'), rect('r2')])
    await a.push([{ k: 'p', id: 'r2', pv: a.confirmed.get('r2')?.version, g: { life: { isDeleted: true } } }])
    const before = await st.snapshot(b)
    a.close()
    await a.untilClosed()
    await sleep(600)
    const metrics = await (await callInternal(st.server.url, 'GET', '/internal/metrics')).text()
    expect(metrics).toMatch(/^lobby_rooms_open 0$/m)
    const a2 = await st.client({ boardId: b, user: 'alice' })
    expect(a2.clock).toBe(before.clock)
    expect(a2.epoch).toBe(before.epoch)
    const after = await st.snapshot(b)
    expect(after).toEqual(before)
    expect(after.elements.find((e) => e.id === 'r2')?.isDeleted).toBe(true)
  })
})

describe('internal routes', () => {
  it('the snapshot route serves live elements and the doc; a board without a file is opened, empty (W4d 2A)', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const a = await st.client({ boardId: b, user: 'alice' })
    await a.create([rect('r1'), rect('r2')])
    await a.push(
      [{ k: 'p', id: 'r2', pv: a.confirmed.get('r2')?.version, g: { life: { isDeleted: true } } }],
      {
        doc: { set: { 'tagDef:x': { name: 'x', color: 'red' } } },
      },
    )
    const res = await callInternal(st.server.url, 'GET', `/internal/boards/${b}/snapshot`)
    expect(res.status).toBe(200)
    const snap = LobbyElementsSnapshot.parse(await res.json())
    expect(snap.elements.map((e) => e.id)).toEqual(['r1'])
    expect(snap.doc).toEqual({ 'tagDef:x': { name: 'x', color: 'red' } })
    // a board nobody has opened: opened now as an empty board (before: 404, and the api answered 503)
    const fresh = await callInternal(st.server.url, 'GET', `/internal/boards/${newBoardId()}/snapshot`)
    expect(fresh.status).toBe(200)
    expect(LobbyElementsSnapshot.parse(await fresh.json())).toMatchObject({ clock: 0, elements: [], doc: {} })
    expect(
      (await callInternal(st.server.url, 'GET', `/internal/boards/${b}/snapshot`, { secret: null })).status,
    ).toBe(401)
  })

  it('/internal/metrics speaks Prometheus text behind the secret', async () => {
    const st = await h.stack()
    const a = await st.client({ boardId: newBoardId(), user: 'alice' })
    await a.create([rect('r1')])
    const res = await callInternal(st.server.url, 'GET', '/internal/metrics')
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const m of [
      'lobby_rooms_open 1',
      'lobby_commit_ms_count',
      'lobby_ops_total{result="ok"}',
      'lobby_event_loop_delay_ms',
    ])
      expect(text).toContain(m)
    expect((await callInternal(st.server.url, 'GET', '/internal/metrics', { secret: null })).status).toBe(401)
  })

  it('the test routes do not exist without DRAFTROOM_TEST_HOOKS=1', async () => {
    const st = await h.stack({ env: { DRAFTROOM_TEST_HOOKS: undefined } })
    const b = newBoardId()
    await st.client({ boardId: b, user: 'alice' })
    expect((await callInternal(st.server.url, 'GET', `/internal/test/boards/${b}/snapshot`)).status).toBe(404)
    expect(
      (
        await callInternal(st.server.url, 'POST', `/internal/test/boards/${b}/fail-commit`, {
          body: { count: 1 },
        })
      ).status,
    ).toBe(404)
  })
})
