/**
 * Static server for the probe page: the built page from `dist/`, and `/excalidraw-assets/*` from the
 * installed `@excalidraw/excalidraw/dist/prod/` (fonts). Binds 127.0.0.1 only.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const dist = resolve(here, 'dist')
const assets = resolve(here, '../../../node_modules/@excalidraw/excalidraw/dist/prod')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep)

export const startProbeServer = (
  port: number,
): Promise<{ server: Server; url: string; served: string[] }> => {
  const served: string[] = []
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname)
    const file = path.startsWith('/excalidraw-assets/')
      ? resolve(assets, normalize(path.slice('/excalidraw-assets/'.length)))
      : resolve(dist, normalize(path === '/' ? 'index.html' : path.slice(1)))
    if (!(inside(assets, file) || inside(dist, file)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    served.push(path)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${port}/`, served }))
  })
}

export const assetsDir = assets
export const distDir = dist
export const joinDist = (...p: string[]) => join(dist, ...p)
