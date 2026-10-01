// draftroom-rehearsal-edge: TLS termination for the Lobby rehearsal stack on the NAS (LAN only).
//
// Production mode of the api and sync requires https origins (PUBLIC_ORIGIN, ALLOWED_ORIGINS), so this
// small server plays the part of Render's edge for the rehearsal:
//   :8443  the static web build with the SPA fallback, plus /api/* and /files/* proxied to the api,
//          exactly what the static site's rewrites do in render.yaml (same origin for the session cookie),
//          with render.yaml's security headers (no CSP: R0 is the tldraw build).
//   :8444  the sync service: WebSocket upgrades and plain requests (/healthz) proxied as they are.
// Both listeners use the same self-signed certificate (/edge/tls). Runs in the pinned node image:
//   node /edge/edge.mjs   (env: EDGE_DIST, EDGE_API_URL, EDGE_SYNC_URL, EDGE_WEB_PORT, EDGE_SYNC_PORT,
//                          EDGE_TLS_KEY, EDGE_TLS_CERT)
// It logs method, path prefix and status only: never a query string (tickets travel there), a cookie
// or a body.
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'

const DIST = path.resolve(process.env.EDGE_DIST ?? '/web')
const API = new URL(process.env.EDGE_API_URL ?? 'http://draftroom-rehearsal-api:10000')
const SYNC = new URL(process.env.EDGE_SYNC_URL ?? 'http://draftroom-rehearsal-sync:10000')
const WEB_PORT = Number(process.env.EDGE_WEB_PORT ?? 8443)
const SYNC_PORT = Number(process.env.EDGE_SYNC_PORT ?? 8444)
const tls = {
  key: fs.readFileSync(process.env.EDGE_TLS_KEY ?? '/edge/tls/edge.key'),
  cert: fs.readFileSync(process.env.EDGE_TLS_CERT ?? '/edge/tls/edge.crt'),
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml',
}
// render.yaml "headers" for /* (the static site), plus the cut-over's Content-Security-Policy when
// EDGE_CSP is set (docs/research/excalidraw/render.cutover.yaml.patch with the sync origin replaced by
// the rehearsal's; runbook C13 adds it, B5 removes it: R0's web is not built for it).
const CSP = (process.env.EDGE_CSP ?? '').trim()
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  ...(CSP ? { 'content-security-policy': CSP } : {}),
}

const log = (...a) => console.log(new Date().toISOString(), ...a)
const pathOnly = (url) => (url ?? '/').split('?')[0].slice(0, 120)

function forwardHeaders(req, target) {
  const h = { ...req.headers }
  const ip = req.socket.remoteAddress ?? ''
  h['x-forwarded-for'] = h['x-forwarded-for'] ? `${h['x-forwarded-for']}, ${ip}` : ip
  h['x-forwarded-proto'] = 'https'
  h['x-forwarded-host'] = req.headers.host ?? ''
  h.host = target.host
  return h
}

function proxy(req, res, target, tag) {
  const up = http.request(
    {
      hostname: target.hostname,
      port: Number(target.port || 80),
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, target),
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
      r.on('error', () => res.destroy())
    },
  )
  up.on('error', (e) => {
    log(`[${tag} upstream error]`, req.method, pathOnly(req.url), e.code ?? e.message)
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end('{"error":{"code":"UPSTREAM_UNAVAILABLE","message":"The rehearsal upstream is not reachable."}}')
  })
  // SSE and long polls: when the browser goes away, drop the upstream request too.
  res.on('close', () => up.destroy())
  req.on('aborted', () => up.destroy())
  req.pipe(up)
}

function serveStatic(req, res) {
  let pathname
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'https://edge.invalid').pathname)
  } catch {
    res.writeHead(400)
    return res.end()
  }
  let file = path.normalize(path.join(DIST, pathname))
  if (file !== DIST && !file.startsWith(DIST + path.sep)) {
    res.writeHead(403)
    return res.end()
  }
  let st = null
  try {
    st = fs.statSync(file)
  } catch {}
  let immutable = false
  if (!st || st.isDirectory()) {
    // A missing file under /excalidraw-assets/ answers 404, never index.html (render.cutover.yaml.patch:
    // the rewrite to /excalidraw-assets/__not-found__ above the SPA rule; runbook P6). A 200 HTML body
    // would make the browser take the font as broken and try its next source. Always on: the tldraw
    // build never requests the prefix, and the rewrite stays through a rollback (B5).
    if (pathname.startsWith('/excalidraw-assets/')) {
      res.writeHead(404, { ...SECURITY, 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    // The SPA fallback (render.yaml: rewrite /* -> /index.html; a file that exists is served as-is).
    file = path.join(DIST, 'index.html')
    try {
      st = fs.statSync(file)
    } catch {
      res.writeHead(404, SECURITY)
      return res.end('web build missing')
    }
  } else {
    immutable = pathname.startsWith('/assets/')
  }
  const headers = {
    ...SECURITY,
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') return res.end()
  fs.createReadStream(file).pipe(res)
}

// ---- :8443 the web origin -------------------------------------------------------------------------
const web = https.createServer(tls, (req, res) => {
  const u = req.url ?? '/'
  if (u === '/api' || u.startsWith('/api/') || u.startsWith('/files/')) return proxy(req, res, API, 'api')
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, SECURITY)
    return res.end()
  }
  serveStatic(req, res)
})
web.on('upgrade', (_req, socket) => socket.destroy()) // the board socket goes to :8444, as on Render

// ---- :8444 the sync origin ------------------------------------------------------------------------
const sync = https.createServer(tls, (req, res) => proxy(req, res, SYNC, 'sync'))
sync.on('upgrade', (req, socket, head) => {
  const up = net.connect(Number(SYNC.port || 80), SYNC.hostname, () => {
    const h = forwardHeaders(req, SYNC)
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries(h)) {
      if (v === undefined) continue
      raw += `${k}: ${Array.isArray(v) ? v.join(', ') : v}\r\n`
    }
    raw += '\r\n'
    up.write(raw)
    if (head?.length) up.write(head)
    socket.pipe(up)
    up.pipe(socket)
  })
  const drop = () => {
    socket.destroy()
    up.destroy()
  }
  up.on('error', (e) => {
    log('[ws upstream error]', pathOnly(req.url), e.code ?? e.message)
    drop()
  })
  socket.on('error', drop)
  socket.on('close', () => up.destroy())
  up.on('close', () => socket.destroy())
})

for (const s of [web, sync]) {
  s.keepAliveTimeout = 65_000
  s.on('tlsClientError', () => {}) // browsers probing the self-signed cert: not worth a log line each
}

web.listen(WEB_PORT, '0.0.0.0', () => log(`[edge] web :${WEB_PORT} dist=${DIST} api=${API.origin} csp=${CSP ? 'on' : 'off'}`))
sync.listen(SYNC_PORT, '0.0.0.0', () => log(`[edge] sync :${SYNC_PORT} -> ${SYNC.origin}`))
if (!fs.existsSync(path.join(DIST, 'index.html'))) log('[edge] WARNING: no index.html under', DIST)

const stop = (sig) => {
  log(`[edge] ${sig}: closing`)
  web.close()
  sync.close()
  setTimeout(() => process.exit(0), 500).unref()
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
