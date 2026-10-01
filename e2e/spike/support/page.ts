import type { Page } from '@playwright/test'
import type { SpikeRole, SpikeTheme } from './spike-global.ts'
import './spike-global.ts'
import { isForeign } from './watch.ts'

export interface OpenSpikeOptions {
  role?: SpikeRole
  theme?: SpikeTheme
  /** Extra query parameters for the page. */
  query?: Record<string, string>
  /** Wait for `window.__lobbySpike.ready` (default true). */
  waitReady?: boolean
  /** Let non-localhost requests reach the network (default false: they are aborted, still observable). */
  allowForeign?: boolean
}

/**
 * Aborts every http(s) request to a non-localhost host before it leaves the machine. The page's
 * 'request' event still fires, so watchPage().foreignRequests() still records the attempt. (Excalidraw
 * appends an esm.sh @font-face source to every font; a missing local file makes the browser try it.)
 */
export async function blockForeignRequests(page: Page): Promise<void> {
  await page.route(
    (url) => isForeign(url.href),
    (route) => route.abort('blockedbyclient'),
  )
}

/** Opens /spike/<name>?role=…&theme=… and (by default) waits until the engine is initialised. */
export async function openSpike(page: Page, name: string, opts: OpenSpikeOptions = {}): Promise<void> {
  const params = new URLSearchParams({
    role: opts.role ?? 'editor',
    theme: opts.theme ?? 'light',
    ...opts.query,
  })
  if (!opts.allowForeign) await blockForeignRequests(page)
  await page.goto(`/spike/${encodeURIComponent(name)}?${params}`)
  if (opts.waitReady !== false) await waitSpikeReady(page)
}

/** Resolves once `window.__lobbySpike.ready` has resolved (onInitialize fired). */
export async function waitSpikeReady(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(() => window.__lobbySpike !== undefined, undefined, { timeout })
  await page.evaluate(async () => {
    await window.__lobbySpike?.ready
  })
}

/** Switches the role of a mounted page (re-renders ExcalidrawHost with the role's `interaction`). */
export async function setSpikeRole(page: Page, role: SpikeRole): Promise<void> {
  await page.evaluate((r) => {
    const spike = window.__lobbySpike
    if (!spike?.setRole) throw new Error('this spike page has no setRole')
    spike.setRole(r)
  }, role)
  await page.waitForFunction((r) => window.__lobbySpike?.role === r, role)
}
