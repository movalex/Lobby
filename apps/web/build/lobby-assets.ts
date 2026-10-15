import type { IncomingMessage, ServerResponse } from 'node:http'
import { ICON_ASSET_PREFIX } from '@draftroom/contracts'
import { formatReport, type GeneratedIcons, pinnedIcons } from '@draftroom/icon-sets/generate'
import type { Plugin } from 'vite'

// Wave Q (WS1): Lobby's own generated assets, same origin under /lobby-assets/ (docs/WAVE-Q-CONTRACTS.md §3.2). Today
// the built-in icons: packages/icon-sets converts the pinned Lucide and Tabler outline sets (node_modules, never
// committed) into
//
//   /lobby-assets/icons/index.<hash>.json      the index (searched client-side)
//   /lobby-assets/icons/shard-<n>.<hash>.json  64 shards of geometry
//   /lobby-assets/icons/LICENSES.txt           both sets' licences (the panel's footer links it)
//
// served from memory by the dev server and emitted by the build. The index's hashed name reaches the web as the
// define `__LOBBY_ICON_INDEX__` (read by src/features/elements/icons/catalog.ts, in a lazy chunk), never as a fixed
// name. Under the prefix only generated files exist: anything else is a 404 (never the SPA's index.html, which a
// JSON reader would take for a broken file). Same origin, so the CSP and the build's host scan are unchanged.
// The generation (about 4 s) runs once per process; the build log carries the report's summary.

export const LOBBY_ASSET_BASE = '/lobby-assets/'
/** The define the web reads the index file name from. */
export const ICON_INDEX_DEFINE = '__LOBBY_ICON_INDEX__'

const HASHED_CACHE = 'public, max-age=31536000, immutable'

export interface LobbyAssetFile {
  readonly type: string
  readonly body: string
  /** a content-hashed name (cached for a year); LICENSES.txt is not */
  readonly hashed: boolean
}

/** The files under ICON_ASSET_PREFIX, by their path under LOBBY_ASSET_BASE ("icons/index.<hash>.json"). */
export function lobbyAssetFiles(icons: GeneratedIcons): Map<string, LobbyAssetFile> {
  const out = new Map<string, LobbyAssetFile>()
  const dir = ICON_ASSET_PREFIX.slice(LOBBY_ASSET_BASE.length)
  for (const f of icons.files) {
    const txt = f.name.endsWith('.txt')
    out.set(`${dir}${f.name}`, {
      type: txt ? 'text/plain; charset=utf-8' : 'application/json',
      body: f.content,
      hashed: !txt,
    })
  }
  return out
}

/** The listing key of a request under LOBBY_ASSET_BASE (the middleware is mounted there), or null when malformed. */
function keyOf(req: IncomingMessage): string | null {
  try {
    return decodeURIComponent((req.url ?? '').split('?')[0] ?? '').replace(/^\/+/, '')
  } catch {
    return null
  }
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end('not found')
}

export function lobbyAssets(generate: () => GeneratedIcons = pinnedIcons): Plugin {
  let icons: GeneratedIcons | undefined
  let files = new Map<string, LobbyAssetFile>()
  const load = () => {
    if (!icons) {
      icons = generate()
      files = lobbyAssetFiles(icons)
    }
    return icons
  }
  return {
    name: 'lobby:lobby-assets',
    config() {
      return { define: { [ICON_INDEX_DEFINE]: JSON.stringify(load().indexFile) } }
    },
    configResolved(config) {
      const report = formatReport(load().report)
      config.logger.info(`lobby-assets: icons\n${report.replace(/^/gm, '  ')}`)
    },
    configureServer(server) {
      server.middlewares.use(LOBBY_ASSET_BASE, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        // only generated files are served: no path from the request reaches the disk
        const key = keyOf(req)
        const file = key === null ? undefined : files.get(key)
        if (!file) return notFound(res)
        res.setHeader('Content-Type', file.type)
        res.setHeader('Cache-Control', file.hashed ? HASHED_CACHE : 'no-cache')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.end(req.method === 'HEAD' ? undefined : file.body)
      })
    },
    configurePreviewServer(server) {
      // vite preview serves the emitted files itself; a miss must not fall through to index.html
      server.middlewares.use(LOBBY_ASSET_BASE, (req, res, next) => {
        const key = keyOf(req)
        if (key !== null && files.has(key)) return next()
        notFound(res)
      })
    },
    generateBundle() {
      for (const [key, file] of files) {
        this.emitFile({ type: 'asset', fileName: `${LOBBY_ASSET_BASE.slice(1)}${key}`, source: file.body })
      }
    },
  }
}
