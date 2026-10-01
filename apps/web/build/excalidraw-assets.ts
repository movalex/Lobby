import { readdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'

// Self-hosted Excalidraw engine assets (docs/EXCALIDRAW-MIGRATION.md §2.12).
//
// Excalidraw resolves each font as new URL('./fonts/<Family>/<file>.woff2', window.EXCALIDRAW_ASSET_PATH)
// and always appends https://esm.sh/... as the last @font-face source (ExcalidrawFontFace.createUrls,
// @excalidraw/excalidraw dist/dev/chunk-FN755BR4.js ~1226-1277). apps/web/src/canvas/engine/engineGlobals.ts
// sets the asset path to /excalidraw-assets/, so this plugin serves (dev) and emits (build) the installed
// package's dist/prod/fonts/** at /excalidraw-assets/fonts/**. The dev and prod font trees are identical.
//
// Liberation/ is left out: Liberation Sans 1.05 is not OFL or MIT, and the engine only needs it for
// server-side export (plan §2.12).
//
// Active exactly when the engine route ships (apps/web/src/App.tsx): VITE_LOBBY_ENGINE=excalidraw, the
// production build included (wave 4, docs/EXCALIDRAW-CUTOVER.md G2: the static site needs
// dist/excalidraw-assets/ without the dev-auth guard). The normal (tldraw) build carries no engine file.

export const EXCALIDRAW_ASSET_BASE = '/excalidraw-assets/'
const EXCLUDED_FAMILIES = new Set(['Liberation'])

/** The installed package's dist/prod/fonts (the export map's "default" entry is dist/prod/index.js). */
function fontsDir(): string {
  const require = createRequire(import.meta.url)
  return path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts')
}

/** url path under the asset base ("fonts/Nunito/x.woff2") → absolute file path. */
function listFonts(dir: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const family of readdirSync(dir, { withFileTypes: true })) {
    if (!family.isDirectory() || EXCLUDED_FAMILIES.has(family.name)) continue
    for (const file of readdirSync(path.join(dir, family.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith('.woff2')) {
        files.set(`fonts/${family.name}/${file.name}`, path.join(dir, family.name, file.name))
      }
    }
  }
  return files
}

/**
 * Whether the fonts are served and emitted: the same gate as the engine route in App.tsx
 * (`VITE_LOBBY_ENGINE === 'excalidraw'`, dev server or any build). `env` is Vite's resolved `config.env`.
 */
export function excalidrawAssetsEnabled(env: Record<string, unknown>): boolean {
  return env.VITE_LOBBY_ENGINE === 'excalidraw'
}

const enabledFor = (config: ResolvedConfig) => excalidrawAssetsEnabled(config.env)

/** The listing key for a request under the asset base, or null when the path is malformed. */
function keyOf(req: IncomingMessage): string | null {
  try {
    return decodeURIComponent((req.url ?? '').split('?')[0] ?? '').replace(/^\/+/, '')
  } catch {
    return null
  }
}

/**
 * Under the asset base, a path that is not in the listing is a 404, never the SPA's index.html: the
 * browser would otherwise get a 200 HTML body for a missing font and move on to the esm.sh source.
 */
function notFound(res: ServerResponse): void {
  res.statusCode = 404
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end('not found')
}

export function excalidrawAssets(): Plugin {
  let enabled = false
  let fonts = new Map<string, string>()
  return {
    name: 'lobby:excalidraw-assets',
    configResolved(config) {
      enabled = enabledFor(config)
      if (enabled) fonts = listFonts(fontsDir())
    },
    configureServer(server) {
      if (!enabled) return
      server.middlewares.use(EXCALIDRAW_ASSET_BASE, (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next()
        // Only files in the listing are served: no path from the request reaches the disk.
        const key = keyOf(req)
        const file = key === null ? undefined : fonts.get(key)
        if (!file) return notFound(res)
        res.setHeader('Content-Type', 'font/woff2')
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
      })
    },
    configurePreviewServer(server) {
      if (!enabled) return
      // vite preview serves the emitted files itself; a miss must not fall through to index.html.
      server.middlewares.use(EXCALIDRAW_ASSET_BASE, (req, res, next) => {
        const key = keyOf(req)
        if (key !== null && fonts.has(key)) return next()
        notFound(res)
      })
    },
    generateBundle() {
      if (!enabled) return
      for (const [key, file] of fonts) {
        this.emitFile({
          type: 'asset',
          fileName: `${EXCALIDRAW_ASSET_BASE.slice(1)}${key}`,
          source: readFileSync(file),
        })
      }
    },
  }
}
