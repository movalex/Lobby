// Fixture file server for the render spike checks (A7, A11, A12, A14). The spike's vite preview proxies
// /files and /api to SPIKE_WEB_PORT + 1 (support/ports.ts), so a spec starts this server there and the
// page's image loader fetches same-origin, on the path shape of Lobby's real derivative route:
//   GET /files/ast_<body>/ver_<body>/d/drv_<body>T   → a generated PNG (thumb), …D → display
//   GET /files/__spike/<name>                          → a blob the spec stored with put()
// Images are generated here (no fixture files, no third party): a solid colour derived from <body>, a
// darker diagonal band and a 2 px border, so pixel probes can check both the colour and the placement.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { deflateSync } from 'node:zlib'

// ---- PNG ----------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** RGB PNG, 8 bits per channel. `px(x, y)` returns [r, g, b]. */
export function encodePng(
  w: number,
  h: number,
  px: (x: number, y: number) => [number, number, number],
): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(x, y)
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ])
}

/** The fill colour of a fixture image (deterministic from the id body). */
export function colorFor(body: string): [number, number, number] {
  let h = 2166136261
  for (let i = 0; i < body.length; i++) h = Math.imul(h ^ body.charCodeAt(i), 16777619)
  h >>>= 0
  // saturated, mid-light colours, far from white and from the note yellow
  const hue = h % 360
  const s = 0.75
  const l = 0.45
  const k = (n: number) => (n + hue / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

export const THUMB_SIZE = { w: 320, h: 200 }
export const DISPLAY_SIZE = { w: 1280, h: 800 }

function fixturePng(body: string, display: boolean): Buffer {
  const { w, h } = display ? DISPLAY_SIZE : THUMB_SIZE
  const [r, g, b] = colorFor(body)
  const band = Math.round(Math.min(w, h) * 0.12)
  return encodePng(w, h, (x, y) => {
    if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) return [20, 20, 20]
    const d = Math.abs(x * (h / w) - y)
    if (d < band) return [Math.round(r * 0.55), Math.round(g * 0.55), Math.round(b * 0.55)]
    return [r, g, b]
  })
}

// ---- server -------------------------------------------------------------------------------------

const DERIVATIVE_RE =
  /^\/files\/ast_([0-9A-Za-z]{10,40})\/ver_([0-9A-Za-z]{10,40})\/d\/drv_([0-9A-Za-z]{10,40})([TD])$/

export interface FilesServerStats {
  requests: number
  imageRequests: number
  notFound: number
  inFlight: number
  maxInFlight: number
  /** Image requests per version body. */
  perVersion: Map<string, number>
}

export interface FilesServer {
  origin: string
  stats: FilesServerStats
  /** Version bodies whose images answer 404 (a derivative that failed or does not exist). */
  failing: Set<string>
  /** Delay before each image response (ms). */
  delayMs: number
  put(name: string, body: string | Buffer, contentType: string): void
  resetStats(): void
  close(): Promise<void>
}

export async function startFilesServer(port: number, host = '127.0.0.1'): Promise<FilesServer> {
  const blobs = new Map<string, { body: Buffer; type: string }>()
  const cache = new Map<string, Buffer>()
  const stats: FilesServerStats = {
    requests: 0,
    imageRequests: 0,
    notFound: 0,
    inFlight: 0,
    maxInFlight: 0,
    perVersion: new Map(),
  }
  const server: FilesServer = {
    origin: `http://${host}:${port}`,
    stats,
    failing: new Set(),
    delayMs: 0,
    put(name, body, type) {
      blobs.set(name, { body: Buffer.isBuffer(body) ? body : Buffer.from(body), type })
    },
    resetStats() {
      Object.assign(stats, { requests: 0, imageRequests: 0, notFound: 0, inFlight: 0, maxInFlight: 0 })
      stats.perVersion.clear()
    },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  }
  const send = (res: ServerResponse, status: number, type: string, body: Buffer | string) => {
    res.writeHead(status, {
      'content-type': type,
      'content-length': Buffer.byteLength(body),
      'cache-control': status === 200 ? 'private, max-age=0' : 'no-store',
    })
    res.end(body)
  }
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    stats.requests++
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'method')
    if (path.startsWith('/files/__spike/')) {
      const blob = blobs.get(decodeURIComponent(path.slice('/files/__spike/'.length)))
      return blob ? send(res, 200, blob.type, blob.body) : send(res, 404, 'text/plain', 'no such blob')
    }
    const m = DERIVATIVE_RE.exec(path)
    if (!m || m[1] !== m[2] || m[2] !== m[3]) {
      stats.notFound++
      return send(res, 404, 'text/plain', 'not found')
    }
    const body = m[2] as string
    stats.imageRequests++
    stats.perVersion.set(body, (stats.perVersion.get(body) ?? 0) + 1)
    stats.inFlight++
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
    try {
      if (server.delayMs > 0) await new Promise((r) => setTimeout(r, server.delayMs))
      if (server.failing.has(body)) {
        stats.notFound++
        return send(res, 404, 'text/plain', 'derivative not found')
      }
      const key = `${body}${m[4]}`
      let png = cache.get(key)
      if (!png) {
        png = fixturePng(body, m[4] === 'D')
        cache.set(key, png)
      }
      return send(res, 200, 'image/png', png)
    } finally {
      stats.inFlight--
    }
  }
  const http = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, 'text/plain', String(e)))
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(port, host, () => resolve())
  })
  server.origin = `http://${host}:${(http.address() as AddressInfo).port}`
  return server
}

/** A fixture version id: `ver_` + a 16-character body (deterministic from n). */
export function fixtureVersion(n: number, prefix = 'fx'): string {
  return `ver_${prefix}${String(n).padStart(14, '0')}`.slice(0, 4 + 16)
}
