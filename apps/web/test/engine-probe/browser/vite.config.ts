/**
 * Build config for the engine probe page only (not the app). `vite build` resolves the `production`
 * condition, so the page runs the same `dist/prod` builds of `@excalidraw/*` the app ships.
 */
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: here,
  base: '/',
  plugins: [react()],
  logLevel: 'warn',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 8000, sourcemap: false },
})
