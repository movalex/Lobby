// A stand-in for the API's GET /internal/access (docs/M1-CONTRACTS.md §7), so access re-validation
// can be driven from a test: set a role, revoke, or make the API fail or hang.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INTERNAL_SECRET_HEADER, type TicketRole } from '@draftroom/auth-tickets'
import { TEST_INTERNAL_SECRET } from './tickets.ts'

export type FakeApiMode = 'ok' | 'error' | 'hang'

export interface AccessCall {
  boardId: string | null
  userId: string | null
  /** whether the request carried the right internal secret */
  authorized: boolean
  at: number
}

export interface FakeApi {
  /** base URL for DRAFTROOM_API_INTERNAL_URL */
  readonly url: string
  readonly calls: AccessCall[]
  mode: FakeApiMode
  /** Role for (board, user); pairs without one get HTTP 404 (which sync must treat as "cannot tell"). */
  setRole(boardId: string, userId: string, role: TicketRole | null): void
  callsFor(boardId: string, userId?: string): AccessCall[]
  close(): Promise<void>
}

export async function startFakeApi(secret = TEST_INTERNAL_SECRET): Promise<FakeApi> {
  const roles = new Map<string, TicketRole | null>()
  const calls: AccessCall[] = []
  const hanging = new Set<ServerResponse>()
  const key = (b: string, u: string) => `${b}\n${u}`

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/internal/access' || req.method !== 'GET') {
      res.writeHead(404).end()
      return
    }
    const boardId = url.searchParams.get('boardId')
    const userId = url.searchParams.get('userId')
    const authorized = req.headers[INTERNAL_SECRET_HEADER] === secret
    calls.push({ boardId, userId, authorized, at: Date.now() })
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"UNAUTHORIZED"}}')
      return
    }
    if (api.mode === 'hang') {
      hanging.add(res)
      return
    }
    if (api.mode === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"code":"INTERNAL"}}')
      return
    }
    const k = key(boardId ?? '', userId ?? '')
    if (!roles.has(k)) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"NOT_FOUND"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ role: roles.get(k) }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  const api: FakeApi = {
    url: `http://127.0.0.1:${port}`,
    calls,
    mode: 'ok',
    setRole(boardId, userId, role) {
      roles.set(key(boardId, userId), role)
    },
    callsFor(boardId, userId) {
      return calls.filter((c) => c.boardId === boardId && (userId === undefined || c.userId === userId))
    },
    async close() {
      for (const res of hanging) res.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  return api
}
