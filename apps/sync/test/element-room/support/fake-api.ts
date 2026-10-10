// A stand-in for the api's internal routes the ElementRoom calls (packages/contracts sync-internal.ts):
// A1 file-refs, A2 workshop-state (the pull), and today's /internal/access (the access monitor), plus a
// 204 for every POST report (touched, session-ended). Driven from the test: files per version id, a
// foreign set, the vote state, delays and failures.
//
// Wave M (M7-1): POST /internal/access-many, the batched re-check, answers only with `accessMany` on (from the
// same roles and sign-in times; a pair without a role makes the whole batch a 500, "cannot tell", as the
// per-pair route's 404 does for it). Off (the default) it answers 403 "Cross-origin request refused.", exactly what
// an api from before wave M answers the sync's Origin-less POST (its CSRF hook runs before its 404).

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INTERNAL_SECRET_HEADER, type TicketRole } from '@draftroom/auth-tickets'
import type { FileRef } from '@draftroom/contracts'
import { TEST_INTERNAL_SECRET } from '../../harness/tickets.ts'

export interface ElementFakeApi {
  readonly url: string
  /** every file-refs call: board and ids */
  readonly fileRefCalls: { boardId: string; ids: string[] }[]
  /** 'ok' answers; 'error' answers 503; 'hang' never answers */
  fileRefsMode: 'ok' | 'error' | 'hang'
  /** delays every file-refs answer (ms) */
  fileRefsDelayMs: number
  addFile(ref: FileRef): void
  addForeign(versionId: string): void
  setWorkshop(boardId: string, s: { voteOpen: boolean; anonymous: boolean }): void
  workshopMode: 'ok' | 'error'
  setRole(boardId: string, userId: string, role: TicketRole | null): void
  /**
   * RT-01: the access answer's `signedInSince` for `userId` (the start of their oldest live session, or
   * null for none). Never set: the answer has no such field (an api from before J3).
   */
  setSignedInSince(userId: string, since: number | null): void
  /** M7-1: answer POST /internal/access-many (default false: 403, as an api from before wave M does) */
  accessMany: boolean
  /** every GET /internal/access, as `board/user` */
  readonly accessCalls: string[]
  /** every POST /internal/access-many, its pairs as `board/user` (404s included) */
  readonly accessManyCalls: string[][]
  close(): Promise<void>
}

export async function startElementFakeApi(secret = TEST_INTERNAL_SECRET): Promise<ElementFakeApi> {
  const files = new Map<string, FileRef>()
  const foreign = new Set<string>()
  const workshops = new Map<string, { voteOpen: boolean; anonymous: boolean }>()
  const roles = new Map<string, TicketRole | null>()
  const signedInSince = new Map<string, number | null>()
  const hanging = new Set<ServerResponse>()
  const json = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.headers[INTERNAL_SECRET_HEADER] !== secret)
      return json(res, 401, { error: { code: 'bad-secret', message: 'no' } })
    if (req.method === 'POST' && url.pathname === '/internal/access-many') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (d) => {
        body += d
      })
      req.on('end', () => {
        const pairs = (JSON.parse(body) as { pairs?: { boardId: string; userId: string }[] }).pairs ?? []
        api.accessManyCalls.push(pairs.map((p) => `${p.boardId}/${p.userId}`))
        // as the real api from before wave M answers it: its web-Origin check refuses an Origin-less POST to a
        // route it does not know before its 404 (apps/api/src/app.ts)
        if (!api.accessMany)
          return json(res, 403, { error: { code: 'FORBIDDEN', message: 'Cross-origin request refused.' } })
        if (pairs.some((p) => !roles.has(`${p.boardId}\n${p.userId}`)))
          return json(res, 500, { error: { code: 'INTERNAL' } })
        const users = [...new Set(pairs.map((p) => p.userId))]
        json(res, 200, {
          results: pairs.map((p) => ({ ...p, role: roles.get(`${p.boardId}\n${p.userId}`) ?? null })),
          signedInSince: Object.fromEntries(
            users.filter((u) => signedInSince.has(u)).map((u) => [u, signedInSince.get(u) ?? null]),
          ),
        })
      })
      return
    }
    if (req.method === 'POST') {
      req.resume()
      return res.writeHead(204).end()
    }
    if (url.pathname === '/internal/access') {
      const userId = url.searchParams.get('userId') ?? ''
      api.accessCalls.push(`${url.searchParams.get('boardId')}/${userId}`)
      const k = `${url.searchParams.get('boardId')}\n${userId}`
      if (!roles.has(k)) return json(res, 404, { error: { code: 'NOT_FOUND' } })
      return json(res, 200, {
        role: roles.get(k),
        ...(signedInSince.has(userId) ? { signedInSince: signedInSince.get(userId) } : {}),
      })
    }
    const m = /^\/internal\/boards\/([^/]+)\/(file-refs|workshop-state)$/.exec(url.pathname)
    if (!m) return res.writeHead(404).end()
    const boardId = decodeURIComponent(m[1] ?? '')
    if (m[2] === 'workshop-state') {
      if (api.workshopMode === 'error')
        return json(res, 503, { error: { code: 'unavailable', message: 'down' } })
      return json(res, 200, workshops.get(boardId) ?? { voteOpen: false, anonymous: false })
    }
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
    api.fileRefCalls.push({ boardId, ids })
    const answer = () => {
      if (api.fileRefsMode === 'hang') {
        hanging.add(res)
        return
      }
      if (api.fileRefsMode === 'error')
        return json(res, 503, { error: { code: 'unavailable', message: 'down' } })
      json(res, 200, {
        ok: ids.filter((id) => files.has(id)).map((id) => files.get(id)),
        foreign: ids.filter((id) => !files.has(id) && foreign.has(id)),
        missing: ids.filter((id) => !files.has(id) && !foreign.has(id)),
      })
    }
    if (api.fileRefsDelayMs > 0) setTimeout(answer, api.fileRefsDelayMs)
    else answer()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const api: ElementFakeApi = {
    url: `http://127.0.0.1:${port}`,
    fileRefCalls: [],
    fileRefsMode: 'ok',
    fileRefsDelayMs: 0,
    workshopMode: 'ok',
    addFile: (ref) => void files.set(ref.versionId, ref),
    addForeign: (v) => void foreign.add(v),
    setWorkshop: (b, s) => void workshops.set(b, s),
    setRole: (b, u, r) => void roles.set(`${b}\n${u}`, r),
    setSignedInSince: (u, since) => void signedInSince.set(u, since),
    accessMany: false,
    accessCalls: [],
    accessManyCalls: [],
    async close() {
      for (const r of hanging) r.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  return api
}
