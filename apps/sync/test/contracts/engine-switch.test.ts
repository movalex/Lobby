// Spike B contracts step C0 (docs/EXCALIDRAW-MIGRATION.md §8.6.2): the engine dispatch, the test-hook
// flag and routes, the pre-open check in RoomRegistry.open(), and the element-room seam of app.ts. The
// ElementRoom itself is O1's; here a fake service stands in for it.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { createSyncServer } from '../../src/app.ts'
import { loadConfig, parseTestHooks } from '../../src/config.ts'
import {
  BoardOpenRefused,
  type ElementRoomDeps,
  type ElementRoomService,
  type ElementSessionInfo,
  type ElementSocket,
  parseEngine,
  registerElementRoom,
  registeredElementRoom,
  registerPreOpenCheck,
} from '../../src/engine-switch.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { registerTestHooks, testHooks } from '../../src/test-hooks.ts'
import {
  callInternal,
  errorCode,
  mintTicket,
  TEST_INTERNAL_SECRET,
  TEST_TICKET_SECRET,
} from '../harness/tickets.ts'
import { startServer, type TestServer, testConfig } from '../http/helpers.ts'

const env = {
  DRAFTROOM_TICKET_SECRET: TEST_TICKET_SECRET,
  DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
  DRAFTROOM_DATA_DIR: '.data-config-only',
}
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})
const track = (t: TestServer) => {
  cleanups.push(() => t.stop())
  return t
}

describe('config: DRAFTROOM_ENGINE and DRAFTROOM_TEST_HOOKS', () => {
  it('the engine defaults to tldraw; excalidraw is opt-in; anything else is refused', () => {
    expect(parseEngine(undefined)).toBe('tldraw')
    expect(parseEngine('')).toBe('tldraw')
    expect(parseEngine('tldraw')).toBe('tldraw')
    expect(parseEngine('excalidraw')).toBe('excalidraw')
    expect(() => parseEngine('Excalidraw')).toThrow(/DRAFTROOM_ENGINE/)
    expect(loadConfig(env).engine).toBe('tldraw')
    expect(loadConfig({ ...env, DRAFTROOM_ENGINE: 'excalidraw' }).engine).toBe('excalidraw')
  })

  it('test hooks are off by default, on with 1, and refused in production', () => {
    expect(parseTestHooks({})).toBe(false)
    expect(parseTestHooks({ DRAFTROOM_TEST_HOOKS: '0' })).toBe(false)
    expect(parseTestHooks({ DRAFTROOM_TEST_HOOKS: '1' })).toBe(true)
    expect(() => parseTestHooks({ DRAFTROOM_TEST_HOOKS: 'yes' })).toThrow(/DRAFTROOM_TEST_HOOKS/)
    expect(() => parseTestHooks({ DRAFTROOM_TEST_HOOKS: '1', NODE_ENV: 'production' })).toThrow(/production/)
    expect(loadConfig({ ...env, DRAFTROOM_TEST_HOOKS: '1' }).testHooks).toBe(true)
  })
})

describe('the test-only routes (§2.4.6)', () => {
  const snap = { clock: 3, epoch: 'e1', horizon: 0, elements: [] }
  const fake = () => {
    const calls: unknown[] = []
    const off = registerTestHooks({
      snapshot: (b) => (b === 'b-known' ? snap : null),
      leaseHook: (b, r) => calls.push(['lease', b, r]),
      failCommit: (b, r) => calls.push(['fail', b, r]),
    })
    cleanups.push(off)
    return calls
  }

  it('do not exist without the flag, even with hooks registered', async () => {
    fake()
    const t = track(await startServer())
    for (const [m, p] of [
      ['GET', '/internal/test/boards/b-known/snapshot'],
      ['POST', '/internal/test/boards/b-known/lease-hook'],
      ['POST', '/internal/test/boards/b-known/fail-commit'],
    ] as const)
      expect((await callInternal(t.url, m, p, m === 'POST' ? { body: { mode: 'off' } } : {})).status, p).toBe(
        404,
      )
  })

  it('with the flag: snapshot 200, lease-hook and fail-commit 204, bad bodies 400, no secret 401', async () => {
    const calls = fake()
    const t = track(await startServer({ config: { testHooks: true } }))
    const s = await callInternal(t.url, 'GET', '/internal/test/boards/b-known/snapshot')
    expect(s.status).toBe(200)
    expect(await s.json()).toEqual(snap)
    expect((await callInternal(t.url, 'GET', '/internal/test/boards/b-other/snapshot')).status).toBe(404)
    expect(
      (
        await callInternal(t.url, 'POST', '/internal/test/boards/b-known/lease-hook', {
          body: { mode: 'delay', ms: 300 },
        })
      ).status,
    ).toBe(204)
    expect(
      (await callInternal(t.url, 'POST', '/internal/test/boards/b-known/fail-commit', { body: { count: 2 } }))
        .status,
    ).toBe(204)
    expect(calls).toEqual([
      ['lease', 'b-known', { mode: 'delay', ms: 300 }],
      ['fail', 'b-known', { count: 2 }],
    ])
    expect(
      (
        await callInternal(t.url, 'POST', '/internal/test/boards/b-known/lease-hook', {
          body: { mode: 'later' },
        })
      ).status,
    ).toBe(400)
    expect(
      (await callInternal(t.url, 'POST', '/internal/test/boards/b-known/fail-commit', { body: { count: 0 } }))
        .status,
    ).toBe(400)
    expect(
      (await callInternal(t.url, 'GET', '/internal/test/boards/b-known/snapshot', { secret: null })).status,
    ).toBe(401)
    expect(
      (await callInternal(t.url, 'GET', '/internal/test/boards/b-known/snapshot', { secret: 'wrong' }))
        .status,
    ).toBe(401)
  })

  it('answer 404 when the flag is on but no room registered its hooks', async () => {
    expect(testHooks()).toBeNull()
    const t = track(await startServer({ config: { testHooks: true } }))
    expect((await callInternal(t.url, 'GET', '/internal/test/boards/b-known/snapshot')).status).toBe(404)
  })
})

describe('pre-open checks in RoomRegistry.open() (§8.3 B8, the R0 stand-in hook)', () => {
  it('a refusal stops the open before any writable handle: no file, 409 new-canvas, 4099 NEW_CANVAS_BOARD', async () => {
    const seen: string[] = []
    cleanups.push(
      registerPreOpenCheck(({ boardId, exists }) => {
        seen.push(`${boardId}:${exists}`)
        return boardId === 'b-refused' ? { ok: false, reason: 'new-canvas' } : { ok: true }
      }),
    )
    const t = track(await startServer())
    expect(() => t.server.registry.getOrCreate('b-refused')).toThrow(BoardOpenRefused)
    expect(existsSync(boardDbPath(t.roomsDir, 'b-refused'))).toBe(false)
    // an internal route that opens the board (asset-refs creates nothing for a missing board, so seed it)
    const seed = await callInternal(t.url, 'POST', '/internal/boards/b-refused/seed', {
      body: { snapshot: { store: {}, schema: {} } },
    })
    expect([400, 409]).toContain(seed.status) // a malformed snapshot may be refused first; never 201
    const place = await callInternal(t.url, 'POST', '/internal/boards/b-refused/place-notes', { body: {} })
    expect(place.status).not.toBe(200)
    // the socket path
    const ticket = mintTicket('b-refused', 'usr_0123456789')
    const ws = new WebSocket(
      `${t.wsUrl}/connect/b-refused?sessionId=tab-1&ticket=${encodeURIComponent(ticket)}`,
    )
    const closed = await new Promise<{ code: number; reason: string }>((resolve) =>
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })),
    )
    expect(closed).toEqual({ code: 4099, reason: 'NEW_CANVAS_BOARD' })
    expect(existsSync(boardDbPath(t.roomsDir, 'b-refused'))).toBe(false)
    expect(seen).toContain('b-refused:false')
    // other boards open as before
    expect(() => t.server.registry.getOrCreate('b-allowed')).not.toThrow()
  })

  it('the router maps a refusal on an existing board to 409 new-canvas', async () => {
    const t = track(await startServer())
    t.server.registry.getOrCreate('b-born-after') // the file now exists
    t.server.registry.closeAll()
    cleanups.push(
      registerPreOpenCheck(({ boardId }) =>
        boardId === 'b-born-after' ? { ok: false, reason: 'new-canvas' } : { ok: true },
      ),
    )
    const t2 = track(await startServer({ config: { dataDir: t.dataDir } }))
    const res = await callInternal(t2.url, 'GET', '/internal/boards/b-born-after/snapshot')
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('new-canvas')
  })
})

describe('DRAFTROOM_ENGINE=excalidraw hands sockets and board routes to the registered ElementRoom', () => {
  it('refuses to build without a registered factory, then dispatches to a fake one', async () => {
    const before = registeredElementRoom()
    cleanups.push(() => (before ? registerElementRoom(before) : undefined))
    registerElementRoom(null as never)
    const dir = mkdtempSync(join(tmpdir(), 'dr-engine-switch-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    expect(() => createSyncServer(testConfig(dir, { engine: 'excalidraw' }))).toThrow(/no ElementRoom/)

    const sessions: { info: ElementSessionInfo; socket: ElementSocket; got: string[]; closed: boolean }[] = []
    let deps: ElementRoomDeps | null = null
    const service: ElementRoomService = {
      connect(info, socket) {
        const s = { info, socket, got: [] as string[], closed: false }
        sessions.push(s)
        return {
          message: (text) => s.got.push(text),
          closed: () => {
            s.closed = true
          },
        }
      },
      sessionsOf: (b) =>
        sessions
          .filter((s) => s.info.boardId === b && !s.closed)
          .map((s) => ({
            sessionId: s.info.sid,
            meta: { userId: s.info.uid, role: s.info.role, name: s.info.name, color: s.info.color },
          })),
      roomIfOpen: (b) => (sessions.some((s) => s.info.boardId === b) ? { closeSession: () => {} } : null),
      openBoards: () => [...new Set(sessions.map((s) => s.info.boardId))],
      routes: () => [
        {
          method: 'GET',
          path: /^\/internal\/boards\/([^/]+)\/snapshot$/,
          handle: (_req, res, [b]) =>
            res
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify({ format: 'lobby-elements', board: b })),
        },
      ],
      metrics: () => 'lobby_rooms 1\n',
      closeAll: async () => {},
    }
    registerElementRoom((d) => {
      deps = d
      return service
    })
    const t = track(await startServer({ config: { engine: 'excalidraw' } }))
    expect(t.server.elementRooms).toBe(service)
    expect(deps).not.toBeNull()
    // the element room's route replaces the tldraw one; tldraw-only board routes are gone
    const snap = await callInternal(t.url, 'GET', '/internal/boards/b-el/snapshot')
    expect(await snap.json()).toEqual({ format: 'lobby-elements', board: 'b-el' })
    expect((await callInternal(t.url, 'GET', '/internal/boards/b-el/asset-refs')).status).toBe(404)
    const metrics = await callInternal(t.url, 'GET', '/internal/metrics')
    expect(await metrics.text()).toBe('lobby_rooms 1\n')
    expect((await callInternal(t.url, 'GET', '/internal/metrics', { secret: null })).status).toBe(401)
    // a verified socket reaches connect() with the ticket's identity, and its frames reach the handle
    const ticket = mintTicket('b-el', 'usr_0123456789', 'viewer', { name: 'Vera' })
    const ws = new WebSocket(`${t.wsUrl}/connect/b-el?sessionId=tab-7&ticket=${encodeURIComponent(ticket)}`)
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ type: 'ping' }))
    await expect.poll(() => sessions[0]?.got.length ?? 0).toBe(1)
    expect(sessions[0]?.info).toMatchObject({
      boardId: 'b-el',
      sid: 'usr_0123456789:tab-7',
      uid: 'usr_0123456789',
      name: 'Vera',
      role: 'viewer',
      guest: false,
      readonly: true,
    })
    expect(t.server.registry.openBoards()).toEqual([]) // the tldraw registry never opened the board
    expect(existsSync(boardDbPath(t.roomsDir, 'b-el'))).toBe(false)
    ws.close()
    await expect.poll(() => sessions[0]?.closed).toBe(true)
  })
})
