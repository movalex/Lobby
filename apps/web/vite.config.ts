import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

// The browser talks to ONE origin; Vite proxies the API (sessions, boards, file routes) to apps/api
// and the canvas WebSocket to apps/sync. Same-origin keeps the session cookie first-party and lets the
// API's Origin check (CSRF) compare against a single PUBLIC_ORIGIN. 127.0.0.1, not localhost: on
// Windows `localhost` may resolve to ::1 while the servers bind IPv4.
const apiOrigin = process.env.DRAFTROOM_API_ORIGIN ?? 'http://127.0.0.1:5859'
const syncOrigin = process.env.DRAFTROOM_SYNC_ORIGIN ?? 'http://127.0.0.1:5858'
const proxy: Record<string, ProxyOptions> = {
  '/api': { target: apiOrigin },
  '/files': { target: apiOrigin },
  '/connect': { target: syncOrigin, ws: true },
}

export default defineConfig({
  plugins: [react()],
  // Required for `vite` dev when importing '@tldraw/assets/imports.vite' (?url imports); build works without it.
  optimizeDeps: { exclude: ['@tldraw/assets'] },
  // tldraw alone is ~1.8 MB minified. It is already split into the lazily loaded board chunk.
  build: { chunkSizeWarningLimit: 2000 },
  server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 5173), strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 4173), strictPort: true, proxy },
})
