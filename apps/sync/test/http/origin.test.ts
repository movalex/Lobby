// ALLOWED_ORIGINS (docs/FEATURES-M2-CONTRACTS.md "platform"): the board WebSocket Origin allowlist is
// enforced BEFORE the upgrade, before the ticket is read and before any room is opened. Tickets remain
// the authentication; this is defense in depth against pages on other sites.
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createSyncServer } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import {
  boardSocketTarget,
  mintTicket,
  TEST_INTERNAL_SECRET,
  TEST_TICKET_SECRET,
} from '../harness/tickets.ts'
import { listFiles, req, startServer, type TestServer } from './helpers.ts'

const WEB = 'https://draftroom-staging-web.onrender.com'

type Outcome = { kind: 'open' } | { kind: 'http'; status: number } | { kind: 'closed'; code: number }

/** Opens a board socket with an explicit Origin (or none) and reports what the server did. */
function attempt(wsUrl: string, boardId: string, origin: string | null, ticket: string): Promise<Outcome> {
  return new Promise((resolve) => {
    // the ticket in the offered subprotocol, as browsers send it (L7)
    const target = boardSocketTarget(`${wsUrl}/connect/${boardId}?sessionId=tab1`, ticket)
    const ws = new WebSocket(
      target.url,
      target.protocols,
      origin === null ? {} : { headers: { Origin: origin } },
    )
    let settled = false
    const done = (o: Outcome) => {
      if (settled) return
      settled = true
      resolve(o)
      ws.terminate()
    }
    ws.on('unexpected-response', (_req, res) => done({ kind: 'http', status: res.statusCode ?? 0 }))
    // Open for a moment without being closed: admitted (the room waits for the client's connect message).
    ws.on('open', () => setTimeout(() => done({ kind: 'open' }), 150))
    ws.on('close', (code) => done({ kind: 'closed', code }))
    ws.on('error', () => {})
  })
}

let t: TestServer | null = null
afterEach(async () => {
  await t?.stop()
  t = null
})

describe('with ALLOWED_ORIGINS', () => {
  it('admits a listed origin with a valid ticket', async () => {
    t = await startServer({ config: { allowedOrigins: [WEB] } })
    expect(await attempt(t.wsUrl, 'board-a', WEB, mintTicket('board-a', 'alice'))).toEqual({ kind: 'open' })
  })

  it('refuses any other origin with 403 before the upgrade, opening no room and logging no ticket', async () => {
    t = await startServer({ config: { allowedOrigins: [WEB] } })
    const ticket = mintTicket('board-b', 'alice')
    for (const origin of [
      'https://evil.example',
      'https://draftroom-staging-web.onrender.com.evil.example',
      'http://draftroom-staging-web.onrender.com',
      'null',
      null,
    ])
      expect(await attempt(t.wsUrl, 'board-b', origin, ticket), String(origin)).toEqual({
        kind: 'http',
        status: 403,
      })
    expect(t.server.elementRooms.openBoards()).not.toContain('board-b')
    expect(listFiles(t.roomsDir).filter((f) => f.includes('board-b'))).toEqual([])
    expect(t.logs).toContainEqual(
      expect.stringMatching(/refused: Origin "https:\/\/evil\.example" is not in/),
    )
    expect(t.logs).toContainEqual(expect.stringMatching(/refused: Origin none is not in ALLOWED_ORIGINS/))
    for (const line of t.logs) {
      expect(line).not.toContain(ticket)
      expect(line).not.toContain('board-b') // the URL (path + query) is never logged for a refusal
    }
  })

  it('checks Origin before the ticket: a foreign page never learns whether its ticket was good', async () => {
    t = await startServer({ config: { allowedOrigins: [WEB] } })
    expect(await attempt(t.wsUrl, 'board-c', 'https://evil.example', 'v1.forged.sig')).toEqual({
      kind: 'http',
      status: 403,
    })
    // With the right Origin, the same bad ticket gets the normal terminal close (4099), not a 403.
    expect(await attempt(t.wsUrl, 'board-c', WEB, 'v1.forged.sig')).toEqual({ kind: 'closed', code: 4099 })
  })

  it('survives refused clients that reset the connection mid-response', async () => {
    t = await startServer({ config: { allowedOrigins: [WEB] } })
    const port = t.port
    const abrupt = () =>
      new Promise<void>((resolve) => {
        const s = connect(port, '127.0.0.1', () => {
          s.write(
            'GET /connect/board-z?sessionId=x&ticket=y HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
              'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nOrigin: https://evil.example\r\n\r\n',
          )
          s.resetAndDestroy()
          resolve()
        })
        s.on('error', () => resolve())
      })
    await Promise.all(Array.from({ length: 40 }, abrupt))
    await new Promise((r) => setTimeout(r, 100))
    expect((await req(port, { path: '/healthz' })).status).toBe(200)
    expect(await attempt(t.wsUrl, 'board-z', WEB, mintTicket('board-z', 'alice'))).toEqual({ kind: 'open' })
  })

  it('still requires a ticket: a listed origin does not authenticate anyone', async () => {
    t = await startServer({ config: { allowedOrigins: [WEB] } })
    const foreign = mintTicket('board-d', 'mallory', 'editor', { secret: 'x'.repeat(40) })
    expect(await attempt(t.wsUrl, 'board-d', WEB, foreign)).toEqual({ kind: 'closed', code: 4099 })
  })
})

describe('without ALLOWED_ORIGINS (development)', () => {
  it('admits any origin, or none, with a valid ticket (the Vite proxy forwards the page Origin)', async () => {
    t = await startServer()
    for (const origin of ['http://127.0.0.1:5173', 'https://anything.example', null])
      expect(
        await attempt(t.wsUrl, 'board-e', origin, mintTicket('board-e', 'alice')),
        String(origin),
      ).toEqual({
        kind: 'open',
      })
  })
})

describe('production env end to end: loadConfig -> createSyncServer', () => {
  it('ALLOWED_ORIGINS from the environment is enforced on the real upgrade path', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dr-sync-origin-'))
    const logs: string[] = []
    const config = loadConfig({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '0',
      DRAFTROOM_DATA_DIR: dataDir,
      DRAFTROOM_TICKET_SECRET: TEST_TICKET_SECRET,
      DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      DRAFTROOM_API_INTERNAL_URL: 'draftroom-staging-api:10000',
      ALLOWED_ORIGINS: WEB,
      ACCESS_RECHECK_MS: '3600000',
    })
    const server = createSyncServer(config, {
      log: (...a) => logs.push(a.map(String).join(' ')),
      accessClient: { getRole: async () => 'editor' },
    })
    try {
      const { port } = await server.listen()
      const wsUrl = `ws://127.0.0.1:${port}`
      const ticket = mintTicket('board-f', 'alice')
      expect(await attempt(wsUrl, 'board-f', 'https://evil.example', ticket)).toEqual({
        kind: 'http',
        status: 403,
      })
      expect(await attempt(wsUrl, 'board-f', WEB, ticket)).toEqual({ kind: 'open' })
    } finally {
      await server.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})
