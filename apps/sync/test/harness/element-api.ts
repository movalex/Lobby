// A stand-in for the api's internal routes an Excalidraw-engine sync server calls (packages/contracts
// sync-internal.ts): A1 `GET /internal/boards/:bid/file-refs?ids=`, A2 `GET /internal/boards/:bid/
// workshop-state`, today's `GET /internal/access` (the access monitor), and a 204 for every POST report
// (touched, session-ended), which it records. Driven from the test: files per version id, a foreign set,
// the vote state, roles, delays and failures. Every request must carry the internal secret (401 otherwise).
//
// The tldraw engine's stand-in (access only) stays in ./fake-api.ts.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { INTERNAL_SECRET_HEADER, type TicketRole } from '@draftroom/auth-tickets'
import type { FileRef } from '@draftroom/contracts'
import { TEST_INTERNAL_SECRET } from './tickets.ts'

export type ElementApiMode = 'ok' | 'error' | 'hang'

export interface ElementApiReport {
  readonly path: string
  readonly body: string
  readonly at: number
}

export interface ElementApi {
  /** base URL for DRAFTROOM_API_INTERNAL_URL */
  readonly url: string
  /** every file-refs call: board and ids, in order */
  readonly fileRefCalls: { boardId: string; ids: string[] }[]
  /** every POST the server sent (touched, session-ended), in order */
  readonly reports: ElementApiReport[]
  /** requests without the right secret (the server must never send one) */
  readonly unauthorized: number
  /** 'ok' answers; 'error' answers 503; 'hang' never answers */
  fileRefsMode: ElementApiMode
  /** delays every file-refs answer (ms) */
  fileRefsDelayMs: number
  workshopMode: 'ok' | 'error'
  /** the access route: 'ok' answers from `setRole` (404 without one), 'error' 500, 'hang' never */
  accessMode: ElementApiMode
  /** a version the board's workspace owns (file-refs `ok`) */
  addFile(ref: FileRef): void
  /** a version of another workspace (file-refs `foreign`) */
  addForeign(versionId: string): void
  /** the vote state the room pulls (A2) */
  setWorkshop(boardId: string, s: { voteOpen: boolean; anonymous: boolean }): void
  setRole(boardId: string, userId: string, role: TicketRole | null): void
  close(): Promise<void>
}

/** A file-refs answer's `ok` entry for a version: an image unless `o` says otherwise. */
export function fileRef(versionId: string, assetId: string, o: Partial<FileRef> = {}): FileRef {
  return {
    versionId,
    assetId,
    kind: 'image',
    name: 'image.png',
    mimeType: 'image/png',
    sizeBytes: 1_024,
    pageCount: null,
    ...o,
  } as FileRef
}

export async function startElementApi(secret = TEST_INTERNAL_SECRET): Promise<ElementApi> {
  const files = new Map<string, FileRef>()
  const foreign = new Set<string>()
  const workshops = new Map<string, { voteOpen: boolean; anonymous: boolean }>()
  const roles = new Map<string, TicketRole | null>()
  const hanging = new Set<ServerResponse>()
  let unauthorized = 0
  const json = (res: ServerResponse, status: number, body: unknown) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.headers[INTERNAL_SECRET_HEADER] !== secret) {
      unauthorized++
      return json(res, 401, { error: { code: 'bad-secret', message: 'no' } })
    }
    if (req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (d) => {
        body += d
      })
      req.on('end', () => {
        api.reports.push({ path: url.pathname, body, at: Date.now() })
        res.writeHead(204).end()
      })
      return
    }
    if (url.pathname === '/internal/access') {
      if (api.accessMode === 'hang') return void hanging.add(res)
      if (api.accessMode === 'error') return json(res, 500, { error: { code: 'INTERNAL' } })
      const k = `${url.searchParams.get('boardId')}\n${url.searchParams.get('userId')}`
      if (!roles.has(k)) return json(res, 404, { error: { code: 'NOT_FOUND' } })
      return json(res, 200, { role: roles.get(k) })
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
      if (api.fileRefsMode === 'hang') return void hanging.add(res)
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
  const api: ElementApi = {
    url: `http://127.0.0.1:${port}`,
    fileRefCalls: [],
    reports: [],
    get unauthorized() {
      return unauthorized
    },
    fileRefsMode: 'ok',
    fileRefsDelayMs: 0,
    workshopMode: 'ok',
    accessMode: 'ok',
    addFile: (ref) => void files.set(ref.versionId, ref),
    addForeign: (v) => void foreign.add(v),
    setWorkshop: (b, s) => void workshops.set(b, s),
    setRole: (b, u, r) => void roles.set(`${b}\n${u}`, r),
    async close() {
      for (const r of hanging) r.destroy()
      hanging.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  return api
}
