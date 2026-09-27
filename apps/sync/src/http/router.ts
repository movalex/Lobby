import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataLayout } from '@draftroom/dev-assets'
import { handleDerivative, handleMeta, handleOriginal } from './files.ts'
import { HttpError, notFound, sendError } from './respond.ts'
import { handleUpload } from './upload.ts'

export interface RouterDeps {
  layout: DataLayout
  /** /dev-api and /files exist only behind DRAFTROOM_DEV_AUTH=1 (the M1 API replaces them). */
  devRoutes: boolean
  log: (...a: unknown[]) => void
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: RouterDeps,
  seg: string[],
) => unknown

const READ = ['GET', 'HEAD']

// Captures are raw (still percent-encoded) path segments; every one is checked against a strict id
// pattern before use, so an encoded '/' or '..' can only ever fail that check.
const ROUTES: Array<{ re: RegExp; methods: string[]; handle: Handler }> = [
  {
    re: /^\/dev-api\/boards\/([^/]+)\/assets$/,
    methods: ['POST'],
    handle: (req, res, url, deps, [board = '']) => handleUpload(req, res, board, url, deps.layout),
  },
  {
    re: /^\/dev-api\/boards\/([^/]+)\/assets\/([^/]+)\/([^/]+)$/,
    methods: READ,
    handle: (_req, res, _url, deps, [board = '', ast = '', ver = '']) =>
      handleMeta(res, deps.layout, board, ast, ver),
  },
  {
    re: /^\/files\/([^/]+)\/([^/]+)\/original$/,
    methods: READ,
    handle: (req, res, url, deps, [ast = '', ver = '']) =>
      handleOriginal(req, res, url, deps.layout, ast, ver),
  },
  {
    re: /^\/files\/([^/]+)\/([^/]+)\/d\/([^/]+)$/,
    methods: READ,
    handle: (req, res, url, deps, [ast = '', ver = '', drv = '']) =>
      handleDerivative(req, res, url, deps.layout, ast, ver, drv),
  },
]

async function route(req: IncomingMessage, res: ServerResponse, url: URL, deps: RouterDeps): Promise<void> {
  const p = url.pathname
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('ok')
    return
  }
  if (!deps.devRoutes) throw notFound()
  for (const r of ROUTES) {
    const m = r.re.exec(p)
    if (!m) continue
    if (!r.methods.includes(req.method ?? '')) {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.', { Allow: r.methods.join(', ') })
    }
    await r.handle(req, res, url, deps, m.slice(1))
    return
  }
  throw notFound()
}

/** node:http request listener for everything that is not a WebSocket upgrade. */
export function createRequestHandler(deps: RouterDeps) {
  return (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = performance.now()
    let url: URL | null = null
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {}
    // Path only: query strings carry identities (?devUser=) and, from M1, tickets.
    const path = (url?.pathname ?? '(unparseable)').slice(0, 256)
    res.once('close', () => {
      const status = res.headersSent ? String(res.statusCode) : '-'
      const ms = (performance.now() - started).toFixed(1)
      deps.log(
        `${req.method} ${path} ${status} ${ms}ms${res.writableFinished ? '' : ' (connection closed early)'}`,
      )
    })
    const handled = url
      ? route(req, res, url, deps)
      : Promise.reject(new HttpError(400, 'BAD_REQUEST', 'Malformed request URL.'))
    return handled.catch((e: unknown) => {
      let err: HttpError
      if (e instanceof HttpError) err = e
      else {
        deps.log('[http error]', req.method, path, e)
        err = new HttpError(500, 'INTERNAL', 'Something went wrong. Please try again.')
      }
      if (res.headersSent) return void res.destroy()
      if (res.destroyed) return
      // An unread request body must not be drained just to keep the connection alive.
      if (!req.complete) err.headers.Connection = 'close'
      sendError(res, err)
    })
  }
}
