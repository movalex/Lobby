import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ProxyOptions } from 'vite'
import { excalidrawAssets } from './build/excalidraw-assets.ts'
import { excalidrawHostRewrite } from './build/excalidraw-host-rewrite.ts'

// The browser talks to ONE origin; Vite proxies the API (sessions, boards, file routes) to apps/api
// and the canvas WebSocket to apps/sync. Same-origin keeps the session cookie first-party and lets the
// API's Origin check (CSRF) compare against a single PUBLIC_ORIGIN. 127.0.0.1, not localhost: on
// Windows `localhost` may resolve to ::1 while the servers bind IPv4.
const apiOrigin = process.env.DRAFTROOM_API_ORIGIN ?? 'http://127.0.0.1:5859'
const syncOrigin = process.env.DRAFTROOM_SYNC_ORIGIN ?? 'http://127.0.0.1:5858'
// Vite ends a proxied response with a 502 only if its headers were not sent yet. When the api dies
// mid-response (a SIGKILL, a crash) that left the browser's side of an already-streaming response open
// forever: the board event stream (SSE) then never reconnected. Abort it instead, as the upstream did.
const abortStartedResponses: ProxyOptions['configure'] = (proxy) => {
  proxy.on('error', (_err, _req, res) => {
    if ('headersSent' in res && res.headersSent && !res.writableEnded) res.destroy()
  })
}
const proxy: Record<string, ProxyOptions> = {
  '/api': { target: apiOrigin, configure: abortStartedResponses },
  '/files': { target: apiOrigin, configure: abortStartedResponses },
  '/connect': { target: syncOrigin, ws: true },
}

/**
 * The commit this build is made from, for the feedback dialog's context block (src/features/feedback/build-info.ts):
 * Render's RENDER_GIT_COMMIT during its build, else the local git HEAD, else 'unknown'. Never read at run time.
 */
function buildCommit(): string {
  const fromEnv = (process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? '').trim()
  if (/^[0-9a-f]{7,40}$/i.test(fromEnv)) return fromEnv.slice(0, 12)
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

/**
 * PLAN-wave4 (docs/EXCALIDRAW-MIGRATION.md §2.2): the engine's Mermaid converter is never used on a Lobby board
 * (its dialog is off; a pasted chart definition stays plain text), so it is a stub module and Mermaid, its
 * parser, d3 and the rest stay out of the build (./build/mermaid-to-excalidraw-stub.ts).
 */
export const MERMAID_STUB = fileURLToPath(new URL('./build/mermaid-to-excalidraw-stub.ts', import.meta.url))

// ---- K1-6 (wave K): the engine in a chunk of its own ------------------------------------------------------
//
// The engine shared a chunk (and so a content hash) with Lobby's board page, so every web deploy made every
// browser download about 625 KB brotli of Excalidraw again. Now three vendor groups, highest priority first:
//
//   preload-helper  Vite's preload helper (the engine's own lazy imports use it; on its own, nothing else
//                   would keep it out of the engine group, whose dependencies are pulled in with it);
//   react           react, react-dom and scheduler (the engine imports react-dom; in the app's entry, every
//                   Lobby change would have changed the engine chunk's import line, and so its hash);
//   excalidraw      the engine's static closure: @excalidraw/excalidraw/dist/prod/index.js and every
//                   node_modules module it imports, transitively (its own lazy chunks, the locales, the code
//                   editor and the font subsetter stay lazy), and the engine's stylesheet.
//
// The engine chunk imports only those vendor chunks, so a build that changes only Lobby's code keeps its file
// name (apps/web/test/bundle/vendor-chunk.test.ts builds twice to check it). The host rewrite
// (./build/excalidraw-host-rewrite.ts) transforms modules, so it covers the new chunk as it covered the old.

const norm = (id: string) => id.split('\\').join('/')
const ENGINE_ENTRY = /\/node_modules\/@excalidraw\/excalidraw\/dist\/prod\/index\.js$/
const ENGINE_CSS = /\/node_modules\/@excalidraw\/excalidraw\/dist\/prod\/index\.css$/
const REACT_PKG = /\/node_modules\/(?:react|react-dom|scheduler)\//

/** The engine's static closure, read from the module graph before the chunks are made (`buildEnd`). */
export function engineChunk(): Plugin & { inEngine(id: string): boolean } {
  let closure = new Set<string>()
  return {
    name: 'lobby-engine-chunk',
    apply: 'build',
    buildEnd() {
      const seen = new Set<string>()
      const stack = [...this.getModuleIds()].filter((id) => ENGINE_ENTRY.test(norm(id)))
      while (stack.length) {
        const id = stack.pop() as string
        if (seen.has(id)) continue
        const n = norm(id)
        if (!n.includes('/node_modules/') || REACT_PKG.test(n)) continue
        seen.add(id)
        for (const next of this.getModuleInfo(id)?.importedIds ?? []) stack.push(next)
      }
      closure = seen
    },
    inEngine: (id: string) => closure.has(id),
  }
}

// ---- K1-6: the head scripts, hashed under /assets -------------------------------------------------------
//
// public/theme-boot.js and public/zod-jitless.js are blocking classic scripts in index.html's <head> (same
// origin, never inline: the CSP has no inline-script hash, and zod-jitless must run before any bundle). Served
// from the site root they revalidated on every visit (max-age=0), one round trip before the first paint. The
// build emits each as assets/<name>-<hash>.js (cached for a year with every other file under /assets/,
// render.yaml) and points the built index.html's tag at it: still a classic `<script src>` in the same place,
// same-origin, not inline. index.html itself keeps the plain paths (the dev server serves public/, and
// theme.test.ts / zod-jitless.test.ts read it); public/ still copies both files to the root, for a tab whose
// cached page names them.

export const HEAD_SCRIPTS = ['theme-boot.js', 'zod-jitless.js'] as const

/** The file name a head script is emitted under: assets/<name>-<8 characters of its sha256>.js */
export function hashedHeadScriptName(name: string, source: string | Uint8Array): string {
  const hash = createHash('sha256').update(source).digest('base64url').slice(0, 8)
  return `assets/${name.replace(/\.js$/, '')}-${hash}.js`
}

export function hashedHeadScripts(names: readonly string[] = HEAD_SCRIPTS): Plugin {
  let publicDir = fileURLToPath(new URL('./public/', import.meta.url))
  let base = '/'
  const emitted = new Map<string, string>()
  return {
    name: 'lobby-hashed-head-scripts',
    apply: 'build',
    configResolved(config) {
      if (config.publicDir) publicDir = `${config.publicDir.replace(/[\\/]$/, '')}/`
      base = config.base
    },
    buildStart() {
      emitted.clear()
      for (const name of names) {
        const source = readFileSync(`${publicDir}${name}`, 'utf8')
        const fileName = hashedHeadScriptName(name, source)
        this.emitFile({ type: 'asset', fileName, source })
        emitted.set(name, fileName)
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        let out = html
        for (const [name, fileName] of emitted) {
          const tag = `<script src="/${name}"></script>`
          if (!out.includes(tag)) throw new Error(`index.html has no ${tag} to point at ${fileName}`)
          out = out.replace(tag, `<script src="${base}${fileName}"></script>`)
        }
        return out
      },
    },
  }
}

// ---- wave M (S2, M3-5): /version.json, so an open tab can learn about a new build ---------------------------------
//
// The build emits dist/version.json `{"commit":"<the same commit as __LOBBY_COMMIT__>"}`. render.yaml serves it with
// Cache-Control: no-store; W3's lib/version-check.ts fetches it (never while the tab is hidden) and compares it with
// the commit the page was built from. Build only: the dev server has no such file (a fetch there gets index.html,
// which is not JSON).

export const VERSION_FILE = 'version.json'

/** The body of /version.json for a build of `commit`. */
export const versionJsonSource = (commit: string) => `${JSON.stringify({ commit })}\n`

export function versionJson(commit: string): Plugin {
  return {
    name: 'lobby-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: VERSION_FILE, source: versionJsonSource(commit) })
    },
  }
}

// ---- wave N1 (wave M follow-up 3): no half-made og:image ----------------------------------------------------------
//
// index.html's og:image is `%VITE_PUBLIC_ORIGIN%/icon-512.png`: Vite fills the percent-delimited name in when the build
// has VITE_PUBLIC_ORIGIN (render.yaml sets it), and otherwise leaves it as it is, so a local or CI build served a link
// preview image at the address "%VITE_PUBLIC_ORIGIN%/icon-512.png". A build without the origin now drops the og:image
// tags (the image, its size and its alt) instead: a preview with no picture, never one with a broken address. Runs before
// Vite's own replacement, so the unset-variable warning is not printed for a tag that is gone.

/** The og:image family of tags that name the origin. */
const OG_IMAGE_TAGS = /[ \t]*<meta\b[^>]*\bproperty="og:image(?::[a-z]+)?"[^>]*>[ \t]*\r?\n?/g

/** `html` without its og:image tags when `origin` is unset or blank; unchanged when the build has an origin. */
export function withoutUnsetOrigin(html: string, origin: string | undefined): string {
  return origin?.trim() ? html : html.replace(OG_IMAGE_TAGS, '')
}

export function dropUnsetPublicOrigin(): Plugin {
  let origin: string | undefined
  return {
    name: 'lobby-drop-unset-public-origin',
    configResolved(config) {
      const value = (config.env as Record<string, unknown>).VITE_PUBLIC_ORIGIN
      origin = typeof value === 'string' ? value : undefined
    },
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => withoutUnsetOrigin(html, origin),
    },
  }
}

/** The commit of this build: __LOBBY_COMMIT__ and /version.json say the same. */
export const LOBBY_COMMIT = buildCommit()

const engine = engineChunk()

export default defineConfig({
  plugins: [
    react(),
    excalidrawAssets(),
    excalidrawHostRewrite(),
    engine,
    hashedHeadScripts(),
    versionJson(LOBBY_COMMIT),
    dropUnsetPublicOrigin(),
  ],
  define: { __LOBBY_COMMIT__: JSON.stringify(LOBBY_COMMIT) },
  resolve: {
    alias: [{ find: /^@excalidraw\/mermaid-to-excalidraw$/, replacement: MERMAID_STUB }],
  },
  build: {
    // The engine chunk is about 1.5 MB minified, lazily loaded (Lobby's board page is another 1.1 MB).
    chunkSizeWarningLimit: 2200,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'preload-helper', test: (id) => id.includes('vite/preload-helper'), priority: 40 },
            { name: 'react', test: (id) => REACT_PKG.test(norm(id)), priority: 30 },
            {
              name: 'excalidraw',
              test: (id) => engine.inEngine(id) || ENGINE_CSS.test(norm(id)),
              priority: 20,
            },
          ],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 5173), strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 4173), strictPort: true, proxy },
})
