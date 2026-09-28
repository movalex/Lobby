// Spike ports (docs/EXCALIDRAW-MIGRATION.md §8). One run owns SPIKE_WEB_PORT (default 7740) and, for the
// vite preview proxy, the two ports after it: /api and /files go to SPIKE_WEB_PORT + 1, /connect to
// SPIKE_WEB_PORT + 2, unless SPIKE_API_ORIGIN / SPIKE_SYNC_ORIGIN say otherwise. Spike A pages call
// neither, but the proxy must never reach someone's local dev servers on the default ports.
export const HOST = '127.0.0.1'

function port(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1024 || n > 65533) {
    throw new Error(`${name} must be a whole number between 1024 and 65533 (got "${value}")`)
  }
  return n
}

export const SPIKE_WEB_PORT = port('SPIKE_WEB_PORT', process.env.SPIKE_WEB_PORT, 7740)
export const SPIKE_WEB_URL = `http://${HOST}:${SPIKE_WEB_PORT}`
export const SPIKE_API_ORIGIN = process.env.SPIKE_API_ORIGIN || `http://${HOST}:${SPIKE_WEB_PORT + 1}`
export const SPIKE_SYNC_ORIGIN = process.env.SPIKE_SYNC_ORIGIN || `http://${HOST}:${SPIKE_WEB_PORT + 2}`

/** Per-run folder name: web build under apps/web/dist/, Playwright output under e2e/test-results/. */
export const SPIKE_RUN_TAG = `spike-${SPIKE_WEB_PORT}`
