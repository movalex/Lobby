// Separate browser PROCESSES (docs/EXCALIDRAW-MIGRATION.md §8.1 "Real browsers"): every BrowserProcess is
// its own `chromium.launch()` (Playwright's headless Chromium shell; spike B downloads no browser and never
// drives the user's Chrome), with one context signed in as one dev user through the real dev login, and
// one page. A third check browser is a third process.
//
// Every context aborts requests to non-local hosts (spike A's rule: Excalidraw's esm.sh font fallback
// must never leave the machine) and, unless `relay: false`, routes the page's board socket through the
// relay (relay.ts) so the test hooks' latency and socket cut work.
import './env.ts'
import { type Browser, type BrowserContext, chromium, type LaunchOptions, type Page } from '@playwright/test'
import { isForeign } from '../../spike/support/watch.ts'
import { signInContext } from '../../tests/support/api.ts'
import './facade.ts'
import { attachRelay } from './relay.ts'
import type { BrowserOptions, BrowserProcess, DevUser, SpikeBStack } from './types.ts'

/** O3's browser options: the frozen ones plus launch details for measurements. */
export interface O3BrowserOptions extends BrowserOptions {
  /** route the board socket through the relay (default true; the timing-gated measurements turn it off) */
  readonly relay?: boolean
  /** extra Chromium flags (the §8.4 measurements use spike A's GPU flags) */
  readonly args?: readonly string[]
  readonly deviceScaleFactor?: number
  /** default true: requests to non-local hosts are aborted before they leave the machine */
  readonly blockForeign?: boolean
}

export interface O3BrowserProcess extends BrowserProcess {
  readonly options: O3BrowserOptions
  /** the browser process id (evidence that browsers are separate processes) */
  readonly pid: number | null
  /** the board this page opened last */
  boardId(): string | null
  /** opens a second tab of the same user (D6) with the same routes */
  newTab(): Promise<Page>
}

const launched = new Set<Browser>()

/** Waits until the facade is installed and the engine core has processed its `welcome`. */
export async function waitBoardReady(page: Page, timeout = 60_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const h = (window as unknown as { __lobbyHarness?: { session(): { welcomed: boolean } } })
        .__lobbyHarness
      return window.lobbyCanvas && h?.session().welcomed
    },
    undefined,
    { timeout, polling: 50 },
  )
}

async function prepareContext(context: BrowserContext, opts: O3BrowserOptions): Promise<void> {
  if (opts.blockForeign !== false)
    await context.route(
      (url) => isForeign(url.href),
      (route) => route.abort('blockedbyclient'),
    )
}

async function preparePage(page: Page, opts: O3BrowserOptions): Promise<void> {
  if (opts.relay !== false) await attachRelay(page)
}

export async function launchSpikeBrowser(
  stack: SpikeBStack,
  user: DevUser,
  opts: O3BrowserOptions,
): Promise<O3BrowserProcess> {
  const launch: LaunchOptions = { headless: true, args: [...(opts.args ?? [])] }
  const browser = await chromium.launch(launch)
  launched.add(browser)
  browser.once('disconnected', () => launched.delete(browser))
  try {
    const touch = opts.touch === true
    const viewport = opts.viewport ?? { width: 1280, height: 800 }
    const context = await browser.newContext({
      baseURL: stack.ports.webUrl,
      viewport,
      hasTouch: touch,
      isMobile: touch && viewport.width < 768,
      deviceScaleFactor: opts.deviceScaleFactor,
    })
    await prepareContext(context, opts)
    if (opts.guest)
      throw new Error(
        'guest browsers join through the A3 guest flow (O5); sign-in for guests is not available in the harness yet',
      )
    await signInContext(context, user.handle, user.name)
    const page = await context.newPage()
    await preparePage(page, opts)
    let current: string | null = null
    const pid = await browserPid(browser)
    const proc: O3BrowserProcess = {
      name: opts.name,
      user,
      browser,
      context,
      page,
      options: opts,
      pid,
      boardId: () => current,
      async openBoard(boardId: string) {
        current = boardId
        await page.goto(`/b/${encodeURIComponent(boardId)}`)
        await waitBoardReady(page)
      },
      async newTab() {
        const tab = await context.newPage()
        await preparePage(tab, opts)
        return tab
      },
      async close() {
        launched.delete(browser)
        await browser.close().catch(() => undefined)
      },
    }
    return proc
  } catch (e) {
    launched.delete(browser)
    await browser.close().catch(() => undefined)
    throw e
  }
}

/** The OS process id of a launched browser (through CDP's SystemInfo; null if unavailable). */
async function browserPid(browser: Browser): Promise<number | null> {
  try {
    const cdp = await browser.newBrowserCDPSession()
    const info = (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo: { type: string; id: number }[]
    }
    await cdp.detach()
    return info.processInfo.find((p) => p.type === 'browser')?.id ?? null
  } catch {
    return null
  }
}

/** Closes every browser this worker launched (afterAll safety net). */
export async function closeAllBrowsers(): Promise<void> {
  await Promise.all([...launched].map((b) => b.close().catch(() => undefined)))
  launched.clear()
}
