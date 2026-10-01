// Separate browser PROCESSES (docs/EXCALIDRAW-MIGRATION.md §8.1 "Real browsers"): every BrowserProcess is
// its own `chromium.launch()` (Playwright's headless Chromium shell; spike B downloads no browser and never
// drives the user's Chrome), with one context signed in as one dev user through the real dev login, and
// one page. A third check browser is a third process.
//
// Guests (`guest: true`, A3): the context is NOT signed in. `openBoard(boardId)` joins the board as a
// name-only guest the way the product does it: the board's owner makes a guest link through the api the
// Share dialog calls (stack.guestLink: a viewer link by default, the "limited guest" of §2.3.2 and B5 R1;
// `guestRole` picks commenter or editor, a workshop link), and the guest's page opens `/invite/<token>`,
// types the DevUser's `name` into the invite page's "Your name" field and presses "Join", which calls
// `POST /api/invitations/:token/guest` and lands on `/b/:boardId` with the guest's `dr_session` cookie. The
// board's ticket then carries the api's `guest: true` claim. A guest who joins a second board uses the
// invite page's "Join and open board" (the same guest user). Only boards made by `stack.createBoard` have a
// known owner, so only they can be joined as a guest.
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
import type { GuestRole, O3Stack } from './stack.ts'
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
  /**
   * With `guest: true`: the role of the guest link the guest joins through. Default `viewer`, a limited
   * (read-only) guest; `commenter`; `editor` is a workshop link (a guest who may edit).
   */
  readonly guestRole?: GuestRole
}

export interface O3BrowserProcess extends BrowserProcess {
  readonly options: O3BrowserOptions
  /** the browser process id (evidence that browsers are separate processes) */
  readonly pid: number | null
  /** the board this page opened last */
  boardId(): string | null
  /** opens a second tab of the same user (D6) with the same routes */
  newTab(): Promise<Page>
  /** a guest's user id (`usr_…`, from the join), null for a dev user or before the first join */
  guestUid(): string | null
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

const isO3Stack = (s: SpikeBStack): s is O3Stack => typeof (s as Partial<O3Stack>).guestLink === 'function'

/**
 * Joins `boardId` as a name-only guest in `page` through the invite page (see the header), and returns the
 * guest's user id. The page ends on `/b/:boardId` (the board is not necessarily ready yet).
 */
export async function joinBoardAsGuest(
  page: Page,
  stack: SpikeBStack,
  boardId: string,
  name: string,
  role: GuestRole = 'viewer',
  timeout = 30_000,
): Promise<string> {
  if (!isO3Stack(stack)) throw new Error('guest browsers need a stack started by harness.startStack')
  const link = await stack.guestLink(boardId, role)
  const joined = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && /\/api\/invitations\/[^/]+\/guest$/.test(new URL(r.url()).pathname),
    { timeout },
  )
  await page.goto(link)
  const join = page.getByTestId('invite-guest-join')
  const again = page.getByTestId('invite-guest-continue')
  await join.or(again).first().waitFor({ state: 'visible', timeout })
  if (await again.isVisible()) await again.click()
  else {
    await page.getByTestId('invite-guest-name').fill(name)
    await join.click()
  }
  const res = await joined
  if (res.status() !== 201 && res.status() !== 200)
    throw new Error(`guest join of ${boardId}: HTTP ${res.status()} ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as { boardId: string; user: { id: string } }
  if (body.boardId !== boardId) throw new Error(`guest join: the link opened ${body.boardId}, not ${boardId}`)
  await page.waitForURL((u) => u.pathname === `/b/${encodeURIComponent(boardId)}`, { timeout })
  return body.user.id
}

export async function launchSpikeBrowser(
  stack: SpikeBStack,
  user: DevUser,
  opts: O3BrowserOptions,
): Promise<O3BrowserProcess> {
  if (opts.guest && !isO3Stack(stack))
    throw new Error('guest browsers need a stack started by harness.startStack')
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
    // a guest's context has no sign-in at all: the guest link gives it its session (openBoard)
    if (!opts.guest) await signInContext(context, user.handle, user.name)
    const page = await context.newPage()
    await preparePage(page, opts)
    let current: string | null = null
    let guestUid: string | null = null
    const joined = new Set<string>()
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
      guestUid: () => guestUid,
      async openBoard(boardId: string) {
        current = boardId
        if (opts.guest && !joined.has(boardId)) {
          guestUid = await joinBoardAsGuest(page, stack, boardId, user.name, opts.guestRole ?? 'viewer')
          joined.add(boardId)
        } else await page.goto(`/b/${encodeURIComponent(boardId)}`)
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
