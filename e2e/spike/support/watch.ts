import type { Page } from '@playwright/test'

/** Hosts a spike page may talk to. Anything else is a third-party request. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface PageWatch {
  /** Every request URL, in order (data: and blob: included). */
  requests: string[]
  /** http(s)/ws(s) requests whose host is not local. */
  foreignRequests(): string[]
  /** Responses: url and status. */
  responses: { url: string; status: number }[]
  /** console.error messages and uncaught page errors. */
  consoleErrors: string[]
  pageErrors: string[]
  /** Counters for side effects a key press or action must never cause. */
  downloads: number
  dialogs: number
  fileChoosers: number
  popups: number
  /** Zeroes the side-effect counters and clears the lists (e.g. after page setup). */
  reset(): void
}

export function isForeign(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return true
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return false
  return !LOCAL_HOSTS.has(u.hostname)
}

/**
 * Starts collecting before navigation. Dialogs are dismissed (and counted) so they never block a test;
 * file choosers are counted and left unanswered; popups are counted and closed.
 */
export function watchPage(page: Page): PageWatch {
  const w: PageWatch = {
    requests: [],
    foreignRequests: () => w.requests.filter(isForeign),
    responses: [],
    consoleErrors: [],
    pageErrors: [],
    downloads: 0,
    dialogs: 0,
    fileChoosers: 0,
    popups: 0,
    reset() {
      w.requests.length = 0
      w.responses.length = 0
      w.consoleErrors.length = 0
      w.pageErrors.length = 0
      w.downloads = 0
      w.dialogs = 0
      w.fileChoosers = 0
      w.popups = 0
    },
  }
  page.on('request', (r) => w.requests.push(r.url()))
  page.on('websocket', (ws) => w.requests.push(ws.url()))
  page.on('response', (r) => w.responses.push({ url: r.url(), status: r.status() }))
  page.on('console', (m) => {
    if (m.type() === 'error') w.consoleErrors.push(m.text())
  })
  page.on('pageerror', (e) => w.pageErrors.push(String(e)))
  page.on('download', () => {
    w.downloads++
  })
  page.on('dialog', (d) => {
    w.dialogs++
    void d.dismiss().catch(() => {})
  })
  page.on('filechooser', () => {
    w.fileChoosers++
  })
  page.on('popup', (p) => {
    w.popups++
    void p.close().catch(() => {})
  })
  return w
}

/**
 * Chromium has the File System Access API, so Excalidraw's save/open paths (browser-fs-access) call
 * showSaveFilePicker / showOpenFilePicker instead of an <a download> or <input type=file>: Playwright's
 * download and filechooser events never fire for them. Call this BEFORE openSpike; each picker call is
 * counted and rejected with AbortError (what a user's Cancel does). Read the counts with filePickerCalls.
 */
export async function instrumentFilePickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counts: Record<string, number> = {}
    Object.defineProperty(window, '__spikePickerCalls', { value: counts })
    for (const name of ['showSaveFilePicker', 'showOpenFilePicker', 'showDirectoryPicker']) {
      counts[name] = 0
      Object.defineProperty(window, name, {
        configurable: true,
        writable: true,
        value: () => {
          counts[name] = (counts[name] ?? 0) + 1
          return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
        },
      })
    }
  })
}

export async function filePickerCalls(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => ({
    ...((window as unknown as { __spikePickerCalls?: Record<string, number> }).__spikePickerCalls ?? {}),
  }))
}
