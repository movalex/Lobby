// The fake api of the load runs (docs/EXCALIDRAW-MIGRATION.md §8.3 B9, §8.6.6): everything sync asks the
// api during a run, on the frozen internal contracts (packages/contracts/src/sync-internal.ts) and the
// existing internal routes, behind the per-run internal secret:
//
//   GET /internal/access?boardId=&userId=              → 200 {role}        (access re-validation, access.ts)
//   GET /internal/boards/:bid/touched?at=              → 204               (touch.ts)
//   GET /internal/boards/:bid/session-ended?at=        → 204               (session-end.ts)
//   GET /internal/boards/:bid/file-refs?ids=ver_a,…    → 200 FileRefsResponse (A1)
//   GET /internal/boards/:bid/workshop-state           → 200 WorkshopStateBody (A2 pull)
//
// A wrong or missing secret gets 401 `bad-secret` (the frozen error body). Boards and users are declared
// by the run (the generated boards and their load users); file-refs answers `ok` for every version id the
// board declares (the generated images' `ver_…` ids) and `missing` for anything else. It counts every call
// for the report. No database, no state on disk.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type FileRef,
  type FileRefsResponse,
  parseFileRefsIds,
  SYNC_INTERNAL_ERROR_STATUS,
  SYNC_INTERNAL_SECRET_HEADER,
  type SyncInternalErrorCode,
  type WorkshopStateBody,
} from '../../packages/contracts/src/sync-internal.ts'

type Role = 'owner' | 'editor' | 'commenter' | 'viewer'

export interface FakeBoard {
  readonly id: string
  /** uid → role; users not listed have no access (null) */
  readonly members: Map<string, Role>
  /** version ids this board's workspace owns (file-refs `ok`) */
  readonly files: Map<string, FileRef>
  workshop: WorkshopStateBody
}

export interface FakeApiCounts {
  access: number
  touched: number
  sessionEnded: number
  fileRefs: number
  fileRefIds: number
  workshopState: number
  badSecret: number
  notFound: number
}

export interface FakeApi {
  readonly url: string
  readonly port: number
  readonly boards: Map<string, FakeBoard>
  readonly counts: FakeApiCounts
  addBoard(id: string, members?: Iterable<[string, Role]>, files?: Iterable<string>): FakeBoard
  /** fail every call with 503 (fail-closed checks) or answer normally */
  setDown(down: boolean): void
  close(): Promise<void>
}

/** A file-refs row for a generated image version (`ver_…`), with a stable asset id. */
export function fakeFileRef(versionId: string): FileRef {
  const tail = versionId.slice(4).padEnd(10, '0').slice(0, 40)
  return {
    versionId,
    assetId: `ast_${tail}`,
    kind: 'image',
    name: `${versionId}.png`,
    mimeType: 'image/png',
    sizeBytes: 1024,
    pageCount: null,
  }
}

const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}

function sendError(res: ServerResponse, code: SyncInternalErrorCode, message: string): void {
  res
    .writeHead(SYNC_INTERNAL_ERROR_STATUS[code], {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    .end(JSON.stringify({ error: { code, message } }))
}
function sendJson(res: ServerResponse, body: unknown): void {
  res
    .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(JSON.stringify(body))
}

export async function startFakeApi(opts: {
  internalSecret: string
  host?: string
  port?: number
}): Promise<FakeApi> {
  const boards = new Map<string, FakeBoard>()
  const counts: FakeApiCounts = {
    access: 0,
    touched: 0,
    sessionEnded: 0,
    fileRefs: 0,
    fileRefIds: 0,
    workshopState: 0,
    badSecret: 0,
    notFound: 0,
  }
  let down = false

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake-api')
    const secret = req.headers[SYNC_INTERNAL_SECRET_HEADER]
    if (typeof secret !== 'string' || !safeEqual(secret, opts.internalSecret)) {
      counts.badSecret++
      return sendError(res, 'bad-secret', 'Bad internal secret.')
    }
    if (req.method !== 'GET') return sendError(res, 'bad-request', 'Only GET is served here.')
    if (down) return sendError(res, 'unavailable', 'The fake api is down (test).')

    if (url.pathname === '/internal/access') {
      counts.access++
      const board = boards.get(url.searchParams.get('boardId') ?? '')
      const uid = url.searchParams.get('userId') ?? ''
      return sendJson(res, { role: board?.members.get(uid) ?? null })
    }
    const m = /^\/internal\/boards\/([^/]+)\/([a-z-]+)$/.exec(url.pathname)
    const board = m ? boards.get(decodeURIComponent(m[1] as string)) : undefined
    const route = m?.[2]
    if (route === 'touched' || route === 'session-ended') {
      if (route === 'touched') counts.touched++
      else counts.sessionEnded++
      return res.writeHead(204).end()
    }
    if (!board) {
      counts.notFound++
      return sendError(res, 'board-not-found', 'No such board.')
    }
    if (route === 'file-refs') {
      counts.fileRefs++
      const ids = parseFileRefsIds(url.searchParams.get('ids'))
      if (!ids) return sendError(res, 'bad-request', 'Bad ids.')
      counts.fileRefIds += ids.length
      const body: FileRefsResponse = { ok: [], foreign: [], missing: [] }
      for (const id of ids) {
        const ref = board.files.get(id)
        if (ref) body.ok.push(ref)
        else body.missing.push(id)
      }
      return sendJson(res, body)
    }
    if (route === 'workshop-state') {
      counts.workshopState++
      return sendJson(res, board.workshop)
    }
    counts.notFound++
    return sendError(res, 'board-not-found', 'No such route.')
  }

  const server: Server = createServer((req, res) => {
    try {
      handle(req, res)
    } catch {
      if (!res.headersSent) sendError(res, 'unavailable', 'fake api error')
    }
  })
  server.keepAliveTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve())
  })
  const { port, address } = server.address() as AddressInfo
  const host = address.includes(':') ? `[${address}]` : address
  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    port,
    boards,
    counts,
    addBoard(id, members = [], files = []) {
      const board: FakeBoard = {
        id,
        members: new Map(members),
        files: new Map([...files].map((v) => [v, fakeFileRef(v)])),
        workshop: { voteOpen: false, anonymous: false },
      }
      boards.set(id, board)
      return board
    },
    setDown(d) {
      down = d
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
