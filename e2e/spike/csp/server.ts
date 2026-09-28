// A static server with a Content-Security-Policy header, for spike check A12: it serves a built
// apps/web (SPA fallback, like the Render static site in render.yaml), answers 404 under
// /excalidraw-assets/ for a missing file (never index.html: a 200 HTML body would send the browser to
// the next @font-face source), proxies /api and /files to the api and /connect (WebSocket) to sync, and
// collects the browser's CSP violation reports (report-uri /__csp-report).
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { extname, join, normalize, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

/** sha256 CSP sources of every inline <script> in an HTML file (the theme boot script of index.html). */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    out.push(
      `'sha256-${createHash('sha256')
        .update(m[1] ?? '', 'utf8')
        .digest('base64')}'`,
    )
  }
  return out
}

export interface CspServer {
  origin: string
  /** Bodies POSTed to /__csp-report. */
  reports: unknown[]
  /** Every request: method, path, status. */
  log: { method: string; path: string; status: number }[]
  setPolicy(policy: string): void
  close(): Promise<void>
}

export interface CspServerOptions {
  root: string
  port: number
  host?: string
  api: { host: string; port: number }
  sync: { host: string; port: number }
  policy: string
}

export async function startCspServer(o: CspServerOptions): Promise<CspServer> {
  const host = o.host ?? '127.0.0.1'
  const reports: unknown[] = []
  const log: CspServer['log'] = []
  let policy = o.policy
  const root = normalize(o.root)
  const index = readFileSync(join(root, 'index.html'))

  const security = (res: ServerResponse) => {
    res.setHeader('Content-Security-Policy', `${policy}; report-uri /__csp-report`)
    // render.yaml's static-site headers
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  }
  const send = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    type: string,
    body: Buffer | string,
  ) => {
    security(res)
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
    res.end(req.method === 'HEAD' ? undefined : body)
    log.push({ method: req.method ?? '?', path: req.url ?? '', status })
  }
  const proxy = (req: IncomingMessage, res: ServerResponse, target: { host: string; port: number }) => {
    const up = httpRequest(
      { host: target.host, port: target.port, method: req.method, path: req.url, headers: req.headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
        log.push({ method: req.method ?? '?', path: req.url ?? '', status: r.statusCode ?? 502 })
      },
    )
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502)
      res.end()
    })
    req.pipe(up)
  }

  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/')
    if (req.method === 'POST' && path === '/__csp-report') {
      let body = ''
      req.on('data', (d) => {
        body += String(d)
      })
      req.on('end', () => {
        try {
          reports.push(JSON.parse(body))
        } catch {
          reports.push(body)
        }
        res.writeHead(204)
        res.end()
      })
      return
    }
    if (path.startsWith('/api/') || path.startsWith('/files/')) return proxy(req, res, o.api)
    if (path.startsWith('/connect/')) return proxy(req, res, o.sync)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'text/plain', 'method')
    const file = normalize(join(root, path))
    const inside = file.startsWith(root + sep)
    if (inside && existsSync(file) && statSync(file).isFile()) {
      return send(req, res, 200, TYPES[extname(file)] ?? 'application/octet-stream', readFileSync(file))
    }
    // a missing asset is a 404, never the SPA page (fonts would fall through to the next source)
    if (path.startsWith('/excalidraw-assets/') || path.startsWith('/assets/') || extname(path)) {
      return send(req, res, 404, 'text/plain', 'not found')
    }
    return send(req, res, 200, TYPES['.html'] as string, index)
  })
  // WebSocket: a raw TCP tunnel to sync for /connect/*
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/connect/')) return socket.destroy()
    const up = connect(o.sync.port, o.sync.host, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`]
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
      up.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port, host, () => resolve())
  })
  return {
    origin: `http://${host}:${o.port}`,
    reports,
    log,
    setPolicy: (p) => {
      policy = p
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
