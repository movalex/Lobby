import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Required for `vite` dev when importing '@tldraw/assets/imports.vite' (?url imports); build works without it.
  optimizeDeps: { exclude: ['@tldraw/assets'] },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
})
