import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'
import { excalidrawAssets } from './build/excalidraw-assets.ts'

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

export default defineConfig({
  plugins: [react(), excalidrawAssets()],
  // Required for `vite` dev when importing '@tldraw/assets/imports.vite' (?url imports); build works without it.
  optimizeDeps: { exclude: ['@tldraw/assets'] },
  // tldraw alone is ~1.8 MB minified. It is already split into the lazily loaded board chunk.
  build: { chunkSizeWarningLimit: 2000 },
  server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 5173), strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 4173), strictPort: true, proxy },
})
