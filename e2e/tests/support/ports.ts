// Fixed e2e ports, shared by playwright.config.ts (the vite preview proxy targets) and the stack
// fixture (the processes it spawns). Fixed rather than random: the preview server is started once per
// run by Playwright, before any test decides anything.
export const HOST = '127.0.0.1'
export const SYNC_PORT = Number(process.env.E2E_SYNC_PORT ?? '5881')
export const API_PORT = Number(process.env.E2E_API_PORT ?? '5882')
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? '4191')

/** The one browser origin: the API's PUBLIC_ORIGIN (Origin checks, invite links) must equal it. */
export const WEB_URL = `http://${HOST}:${WEB_PORT}`
export const API_URL = `http://${HOST}:${API_PORT}`
export const SYNC_URL = `http://${HOST}:${SYNC_PORT}`
