// e2e ports, shared by playwright.config.ts (the vite preview proxy targets) and the stack fixture (the
// processes it spawns). Fixed per run rather than random: the preview server is started once per run by
// Playwright, before any test decides anything.
//
// Several runs can share one machine: give each its own E2E_PORT_BASE and they use disjoint ports
// (sync = base, api = base + 1, web = base + 2), their own web build folder and their own output dir
// (see playwright.config.ts). Unset, the historical ports stay: sync 5881, api 5882, web 4191.
// E2E_SYNC_PORT / E2E_API_PORT / E2E_WEB_PORT still override a single port.
//
// A port the browser refuses to connect to (Chromium's restricted list, below) is refused here, before
// anything starts: a base that put the web port on 6566 used to build, start the stack and then fail every
// navigation with net::ERR_UNSAFE_PORT.
export const HOST = '127.0.0.1'

/**
 * Chromium's restricted ports at or above 1024 (net/base/port_util.cc `kRestrictedPorts`; the ones below
 * 1024 are refused by the range check anyway). A page cannot be loaded from, and a socket cannot be opened
 * to, any of them: `net::ERR_UNSAFE_PORT`. Kept as a literal list so a Chromium update that adds one is a
 * one-line change here (the unit test pins the ones that have bitten a run).
 */
export const CHROMIUM_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1719, // h323gatestat
  1720, // h323hostcall
  1723, // pptp
  2049, // nfs
  3659, // apple-sasl / PasswordServer
  4045, // lockd
  4190, // ManageSieve
  5060, // sip
  5061, // sips
  6000, // X11
  6566, // sane-port
  6665, // alternate IRC
  6666, // alternate IRC
  6667, // IRC
  6668, // alternate IRC
  6669, // alternate IRC
  6679, // alternate IRC over SSL
  6697, // IRC over TLS
  10080, // Amanda
])

type Env = Readonly<Record<string, string | undefined>>

function port(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1024 || n > 65535) {
    throw new Error(`${name} must be a whole number between 1024 and 65535 (got "${value}")`)
  }
  return n
}

/** Throws for a port Chromium will not connect to; `what` says which variable or role it came from. */
export function assertBrowserSafePort(what: string, n: number): number {
  if (CHROMIUM_BLOCKED_PORTS.has(n)) {
    throw new Error(
      `${what} is ${n}, a port Chromium refuses to connect to (net::ERR_UNSAFE_PORT); pick another E2E_PORT_BASE`,
    )
  }
  return n
}

export interface ResolvedPorts {
  /** Set when E2E_PORT_BASE was given (used to name per-run folders). */
  portBase: number | null
  syncPort: number
  apiPort: number
  webPort: number
}

/** The run's three ports from an environment (E2E_PORT_BASE and the three single-port overrides). */
export function resolvePorts(env: Env): ResolvedPorts {
  const base = env.E2E_PORT_BASE ? port('E2E_PORT_BASE', env.E2E_PORT_BASE, 0) : null
  if (base !== null && base > 65533) throw new Error('E2E_PORT_BASE must leave room for base + 2 (<= 65533)')
  const syncPort = port('E2E_SYNC_PORT', env.E2E_SYNC_PORT, base ?? 5881)
  const apiPort = port('E2E_API_PORT', env.E2E_API_PORT, base === null ? 5882 : base + 1)
  const webPort = port('E2E_WEB_PORT', env.E2E_WEB_PORT, base === null ? 4191 : base + 2)
  if (new Set([syncPort, apiPort, webPort]).size !== 3) {
    throw new Error(`e2e ports must differ (sync ${syncPort}, api ${apiPort}, web ${webPort})`)
  }
  // all three, not just the web port: the browser reaches the api and sync through the web origin's proxy,
  // but a spec (or a base + 1 / + 2 that lands on a blocked port) can open any of them directly
  const from = (single: string, offset: string) => `(${env[single] ? single : `E2E_PORT_BASE${offset}`})`
  assertBrowserSafePort(`the sync port ${from('E2E_SYNC_PORT', '')}`, syncPort)
  assertBrowserSafePort(`the api port ${from('E2E_API_PORT', ' + 1')}`, apiPort)
  assertBrowserSafePort(`the web port ${from('E2E_WEB_PORT', ' + 2')}`, webPort)
  return { portBase: base, syncPort, apiPort, webPort }
}

const resolved = resolvePorts(process.env)

/** Set when E2E_PORT_BASE was given (used to name per-run folders). */
export const PORT_BASE = resolved.portBase
export const SYNC_PORT = resolved.syncPort
export const API_PORT = resolved.apiPort
export const WEB_PORT = resolved.webPort

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
