/**
 * A fake Miro for tests (wave R, WS1): a `node:http` server that answers the REST API v2 read paths an import uses,
 * in the shapes Miro documents, over the fixture boards (./fixtures.ts), plus a second origin standing for the
 * signed-download host. The api reaches it through DRAFTROOM_MIRO_TEST_ORIGINS=<api>,<files> (behind the local-dev
 * guard; apps/api config.ts), so the egress rules (paths, methods, Bearer only toward the API origin, the signed
 * URL's Expires) still apply. The api's tests and the e2e fake (e2e/tests/support/miro.ts) both use it. Nothing
 * here ever calls the real Miro.
 *
 *   GET /v1/oauth-token                      the token's team and scopes (401 for any other token)
 *   GET /v2/boards?limit&offset&query&sort   offset pages of the boards whose name holds `query`
 *   GET /v2/boards/{id}                      a board (404 when the token's team cannot see it)
 *   GET /v2/boards/{id}/items?limit&cursor   cursor pages (`pageSize` a page: the sprint board takes 3)
 *   GET /v2/boards/{id}/items?tag_id&offset  offset pages of the items carrying a tag
 *   GET /v2/boards/{id}/connectors|groups    cursor pages
 *   GET /v2/boards/{id}/tags|members         offset pages
 *   GET /v2/boards/{id}/resources/(images|documents)/{rid}?redirect=false   `{ type, url }`: a signed URL on the
 *                                            files origin, valid 60 s (or on `fileHost` when a test points it away)
 *   files origin: GET /r/<rid>.(png|pdf)?Expires=… → the bytes (403 once expired)
 *
 * A test steers it through `behaviour`: a delay before each answer, 429s, a path that fails, files held until a
 * promise resolves, and so on. `requests` records method, path and whether the Authorization header was the token
 * (never the header itself).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  boardSummary,
  FIXTURE_TOKEN_CONTEXT,
  type FixtureBoard,
  fixtureBoards,
  fixturePdf,
  fixturePng,
} from './fixtures.ts'

/** The fake's token (any other is refused 401). Not a secret: only the fake knows it. */
export const FAKE_MIRO_TOKEN = 'fake-miro-token_0123456789abcdefghij-KLMNOP'

export interface FakeMiroBehaviour {
  /** waits this long before every answer of the API origin */
  delayMs: number
  /** the next n API requests answer 429 (with X-RateLimit-Reset one second ahead) */
  rateLimitNext: number
  /** API requests whose path matches answer this status */
  fail: { path: RegExp; status: number } | null
  /** the host a resource answer's URL names: the files origin, or another one (refused by the egress rules) */
  fileHost: 'files' | 'evil'
  /** resource answers name an already expired URL */
  expired: boolean
  /** file downloads wait for this (a test holds them to pause or cancel mid-files) */
  holdFiles: Promise<void> | null
  /** the scopes the token context lists */
  scopes: string[]
  /** document downloads answer with this type and these bytes instead of the fixture PDF (a disguised file) */
  document: { contentType: string; bytes: Buffer } | null
}

export interface FakeMiroRequest {
  readonly origin: 'api' | 'files'
  readonly method: string
  readonly path: string
  /** whether an Authorization header was sent, and whether it was the token */
  readonly auth: 'none' | 'token' | 'other'
}

export interface FakeMiro {
  readonly api: string
  readonly files: string
  readonly token: string
  readonly boards: FixtureBoard[]
  readonly requests: FakeMiroRequest[]
  readonly behaviour: FakeMiroBehaviour
  close(): Promise<void>
}

export interface FakeMiroOptions {
  readonly boards?: FixtureBoard[]
  /** items, connectors and groups a cursor page (Miro's own maximum is 50) */
  readonly pageSize?: number
  readonly host?: string
  /** fixed ports (the e2e stack's), else any free one */
  readonly apiPort?: number
  readonly filesPort?: number
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  })
  res.end(text)
}

const error = (res: ServerResponse, status: number, code: string, headers: Record<string, string> = {}) =>
  json(res, status, { status, code, message: `fake miro: ${code}`, type: 'error' }, headers)

const listen = (server: Server, host: string, port: number) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port))
  })

const enc = (n: number) => Buffer.from(`c${n}`).toString('base64')
const dec = (c: string | null) => {
  if (!c) return 0
  const s = Buffer.from(c, 'base64').toString('utf8')
  return /^c\d+$/.test(s) ? Number(s.slice(1)) : 0
}

export async function startFakeMiro(opts: FakeMiroOptions = {}): Promise<FakeMiro> {
  const host = opts.host ?? '127.0.0.1'
  const boards = opts.boards ?? fixtureBoards()
  const pageSize = opts.pageSize ?? 10
  const requests: FakeMiroRequest[] = []
  const behaviour: FakeMiroBehaviour = {
    delayMs: 0,
    rateLimitNext: 0,
    fail: null,
    fileHost: 'files',
    expired: false,
    holdFiles: null,
    scopes: ['boards:read'],
    document: null,
  }
  let filesOrigin = ''
  const png = fixturePng()
  const pdf = fixturePdf()

  const authOf = (req: IncomingMessage): FakeMiroRequest['auth'] => {
    const h = req.headers.authorization
    if (h === undefined) return 'none'
    return h === `Bearer ${FAKE_MIRO_TOKEN}` ? 'token' : 'other'
  }

  const cursorPage = (res: ServerResponse, all: readonly unknown[], q: URLSearchParams) => {
    const limit = Math.min(Number(q.get('limit') ?? pageSize) || pageSize, pageSize)
    const from = dec(q.get('cursor'))
    const data = all.slice(from, from + limit)
    const next = from + limit < all.length ? enc(from + limit) : undefined
    json(res, 200, {
      data,
      total: all.length,
      size: data.length,
      limit,
      ...(next ? { cursor: next } : {}),
      links: { self: 'https://api.miro.com/v2/…' },
      type: 'cursor-list',
    })
  }
  const offsetPage = (res: ServerResponse, all: readonly unknown[], q: URLSearchParams) => {
    const limit = Math.min(Number(q.get('limit') ?? 50) || 50, 50)
    const offset = Number(q.get('offset') ?? 0) || 0
    const data = all.slice(offset, offset + limit)
    json(res, 200, { data, total: all.length, size: data.length, offset, limit, type: 'list' })
  }

  const api = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const path = url.pathname
    const auth = authOf(req)
    requests.push({ origin: 'api', method: req.method ?? '', path, auth })
    if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs))
    const now = Math.floor(Date.now() / 1000)
    const rate = {
      'x-ratelimit-limit': '100000',
      'x-ratelimit-remaining': '99000',
      'x-ratelimit-reset': String(now + 60),
    }
    if (req.method !== 'GET') return error(res, 405, 'methodNotAllowed', rate)
    if (auth !== 'token') return error(res, 401, 'tokenNotProvided', rate)
    if (behaviour.rateLimitNext > 0) {
      behaviour.rateLimitNext--
      return error(res, 429, 'tooManyRequests', {
        ...rate,
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(now + 1),
      })
    }
    if (behaviour.fail?.path.test(path)) return error(res, behaviour.fail.status, 'failed', rate)
    if (path === '/v1/oauth-token')
      return json(res, 200, { ...FIXTURE_TOKEN_CONTEXT, scopes: behaviour.scopes }, rate)
    if (path === '/v2/boards') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase()
      return offsetPage(
        res,
        boards.filter((b) => b.name.toLowerCase().includes(query)).map(boardSummary),
        url.searchParams,
      )
    }
    const m =
      /^\/v2\/boards\/([A-Za-z0-9_=-]+)(?:\/(items|connectors|groups|tags|members|resources\/(images|documents)\/([A-Za-z0-9_=-]+)))?$/.exec(
        decodeURIComponent(path),
      )
    const board = m ? boards.find((b) => b.id === m[1]) : undefined
    if (!m || !board) return error(res, 404, 'notFound', rate)
    const q = url.searchParams
    switch (m[2]) {
      case undefined:
        return json(res, 200, boardSummary(board), rate)
      case 'items': {
        const tag = q.get('tag_id')
        if (tag) {
          const ids = new Set(board.tagItems[tag] ?? [])
          return offsetPage(
            res,
            board.items.filter((i) => ids.has(i.id as string)),
            q,
          )
        }
        return cursorPage(res, board.items, q)
      }
      case 'connectors':
        return cursorPage(res, board.connectors, q)
      case 'groups':
        return cursorPage(res, board.groups, q)
      case 'tags':
        return offsetPage(res, board.tags, q)
      case 'members':
        return offsetPage(res, board.members, q)
      default: {
        if (q.get('redirect') !== 'false') return error(res, 400, 'redirectRequired', rate)
        const kind = m[3] === 'images' ? 'image' : 'document'
        const expires = behaviour.expired ? now - 10 : now + 60
        const base = behaviour.fileHost === 'evil' ? 'https://evil.example' : filesOrigin
        const ext = kind === 'image' ? 'png' : 'pdf'
        return json(
          res,
          200,
          { type: kind, url: `${base}/r/${m[4]}.${ext}?Expires=${expires}&Signature=fake&Key-Pair-Id=fake` },
          rate,
        )
      }
    }
  })

  const files = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    requests.push({ origin: 'files', method: req.method ?? '', path: url.pathname, auth: authOf(req) })
    if (behaviour.holdFiles) await behaviour.holdFiles
    const m = /^\/r\/[A-Za-z0-9_=-]+\.(png|pdf)$/.exec(url.pathname)
    const expires = Number(url.searchParams.get('Expires') ?? 0)
    if (!m || req.method !== 'GET') return error(res, 404, 'notFound')
    if (expires * 1000 < Date.now()) return error(res, 403, 'expired')
    const doc = m[1] === 'pdf' ? behaviour.document : null
    const bytes = doc ? doc.bytes : m[1] === 'png' ? png : pdf
    res.writeHead(200, {
      'content-type': doc ? doc.contentType : m[1] === 'png' ? 'image/png' : 'application/pdf',
      'content-length': String(bytes.length),
    })
    res.end(bytes)
  })

  const apiPort = await listen(api, host, opts.apiPort ?? 0)
  const filesPort = await listen(files, host, opts.filesPort ?? 0)
  filesOrigin = `http://${host}:${filesPort}`
  return {
    api: `http://${host}:${apiPort}`,
    files: filesOrigin,
    token: FAKE_MIRO_TOKEN,
    boards,
    requests,
    behaviour,
    close: () =>
      Promise.all(
        [api, files].map(
          (s) =>
            new Promise<void>((r) => {
              s.closeAllConnections?.()
              s.close(() => r())
            }),
        ),
      ).then(() => undefined),
  }
}
