import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'
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

export default defineConfig({
  plugins: [react(), excalidrawAssets(), excalidrawHostRewrite()],
  define: { __LOBBY_COMMIT__: JSON.stringify(buildCommit()) },
  resolve: {
    alias: [{ find: /^@excalidraw\/mermaid-to-excalidraw$/, replacement: MERMAID_STUB }],
  },
  // The board chunk (the Excalidraw engine and Lobby's board page) is about 2 MB minified, lazily loaded.
  build: { chunkSizeWarningLimit: 2200 },
  server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 5173), strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 4173), strictPort: true, proxy },
})
