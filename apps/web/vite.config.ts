import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

// The browser talks to ONE origin; Vite proxies sync + file routes to apps/sync. Same-origin keeps
// cookies/CSRF simple once real sign-in lands (milestone 1). 127.0.0.1, not localhost: on Windows
// `localhost` may resolve to ::1 while the sync server binds IPv4.
const syncOrigin = process.env.DRAFTROOM_SYNC_ORIGIN ?? 'http://127.0.0.1:5858'
const proxy: Record<string, ProxyOptions> = {
  '/connect': { target: syncOrigin, ws: true },
  '/files': { target: syncOrigin },
  '/dev-api': { target: syncOrigin },
}

export default defineConfig({
  plugins: [react()],
  // Required for `vite` dev when importing '@tldraw/assets/imports.vite' (?url imports); build works without it.
  optimizeDeps: { exclude: ['@tldraw/assets'] },
  server: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 5173), strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: Number(process.env.WEB_PORT ?? 4173), strictPort: true, proxy },
})
