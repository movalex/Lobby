// e2e ports, shared by playwright.config.ts (the vite preview proxy targets) and the stack fixture (the
// processes it spawns). Fixed per run rather than random: the preview server is started once per run by
// Playwright, before any test decides anything.
//
// Several runs can share one machine: give each its own E2E_PORT_BASE and they use disjoint ports
// (sync = base, api = base + 1, web = base + 2), their own web build folder and their own output dir
// (see playwright.config.ts). Unset, the historical ports stay: sync 5881, api 5882, web 4191.
// E2E_SYNC_PORT / E2E_API_PORT / E2E_WEB_PORT still override a single port.
export const HOST = '127.0.0.1'

function port(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`${name} must be a whole number between 1024 and 65535 (got "${value}")`)
  }
  return n
}

const base = process.env.E2E_PORT_BASE ? port('E2E_PORT_BASE', process.env.E2E_PORT_BASE, 0) : null
if (base !== null && base > 65533) throw new Error('E2E_PORT_BASE must leave room for base + 2 (<= 65533)')

/** Set when E2E_PORT_BASE was given (used to name per-run folders). */
export const PORT_BASE = base
export const SYNC_PORT = port('E2E_SYNC_PORT', process.env.E2E_SYNC_PORT, base ?? 5881)
export const API_PORT = port('E2E_API_PORT', process.env.E2E_API_PORT, base === null ? 5882 : base + 1)
export const WEB_PORT = port('E2E_WEB_PORT', process.env.E2E_WEB_PORT, base === null ? 4191 : base + 2)
if (new Set([SYNC_PORT, API_PORT, WEB_PORT]).size !== 3) {
  throw new Error(`e2e ports must differ (sync ${SYNC_PORT}, api ${API_PORT}, web ${WEB_PORT})`)
}

/** The one browser origin: the API's PUBLIC_ORIGIN (Origin checks, invite links) must equal it. */
export const WEB_URL = `http://${HOST}:${WEB_PORT}`
export const API_URL = `http://${HOST}:${API_PORT}`
export const SYNC_URL = `http://${HOST}:${SYNC_PORT}`

/**
 * Per-run folder name (web build under apps/web/dist/, Playwright output under e2e/test-results/), so
 * concurrent runs never build into or wipe each other's files. Keyed on the web port: two live runs
 * can never share it.
 */
export const RUN_TAG = `web-${WEB_PORT}`
