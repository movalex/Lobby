// Helpers for the collaboration-quality suites (saving.spec.ts, conflicts.spec.ts): the truthful save
// indicator (docs/research/saved-indicator.md) and per-property undo (docs/research/undo-per-prop.md).
import { type Browser, expect, type Page } from '@playwright/test'
import { signInContext } from './api.ts'
import { getShape, type Session, toScreen, waitForBoard } from './board.ts'
import type { TestUser } from './users.ts'

/** The save indicator's states (apps/web/src/sync-quality/useSaveStatus.ts DisplayState). */
export type SaveState =
  | 'connecting'
  | 'saved'
  | 'saving'
  | 'offline'
  | 'offline-pending'
  | 'rejected'
  | 'error'
  | 'unsupported'
  | 'readonly'

export const saveStatus = (page: Page) => page.getByTestId('save-status')

export async function expectSaveState(page: Page, state: SaveState, timeout = 20_000) {
  await expect(saveStatus(page)).toHaveAttribute('data-state', state, { timeout })
}

declare global {
  interface Window {
    __drSaveLog?: { state: string; t: number }[]
  }
}

/**
 * Records every state the save indicator shows from now on (a MutationObserver in the page, so no
 * transition between two polls is missed, however short). Survives the element being re-rendered.
 */
export async function recordSaveStates(page: Page) {
  await page.evaluate(() => {
    const read = () => document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state') ?? ''
    const log: { state: string; t: number }[] = [{ state: read(), t: performance.now() }]
    window.__drSaveLog = log
    new MutationObserver(() => {
      const state = read()
      if (log.at(-1)?.state !== state) log.push({ state, t: performance.now() })
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state'],
    })
  })
}

/** The states recorded since recordSaveStates (consecutive duplicates collapsed). */
export async function saveLog(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.__drSaveLog ?? []).map((e) => e.state))
}

/** Forgets what was recorded so far; the current state becomes the first entry. */
export async function markSaveLog(page: Page) {
  await page.evaluate(() => {
    const log = window.__drSaveLog
    if (!log) throw new Error('recordSaveStates was not called')
    const last = log.at(-1)
    log.splice(0, log.length, ...(last ? [last] : []))
  })
}

/** Document pushes (a sync `push` frame that carries a diff) this page's sockets have sent. */
export interface PushCounter {
  documentPushes(): number
  presencePushes(): number
  /** The record ids the document pushes touched. */
  touched(): string[]
  reset(): void
}

/**
 * Counts outgoing sync frames on `page`. Must be attached before the board's socket opens. A chunked
 * frame ("<n>_…", only for very large pushes) counts as a document push.
 */
export function countPushes(page: Page): PushCounter {
  let doc = 0
  let presence = 0
  const ids = new Set<string>()
  page.on('websocket', (ws) => {
    if (!/\/connect\//.test(ws.url())) return
    ws.on('framesent', ({ payload }) => {
      const text = typeof payload === 'string' ? payload : payload.toString('utf8')
      if (/^\d+_/.test(text)) {
        doc++
        return
      }
      let msg: { type?: string; diff?: Record<string, unknown>; presence?: unknown }
      try {
        msg = JSON.parse(text)
      } catch {
        return
      }
      if (msg.type !== 'push') return
      if (msg.diff && Object.keys(msg.diff).length > 0) {
        doc++
        for (const id of Object.keys(msg.diff)) ids.add(id)
      } else if (msg.presence !== undefined) presence++
    })
  })
  return {
    documentPushes: () => doc,
    presencePushes: () => presence,
    touched: () => [...ids].sort(),
    reset: () => {
      doc = 0
      presence = 0
      ids.clear()
    },
  }
}

/**
 * Like openSession (support/board.ts), but hands the page to `beforeOpen` before the board loads,
 * so socket listeners (or a routeWebSocket relay) see the very first connect.
 */
export async function openSessionWatched(
  browser: Browser,
  board: string,
  user: TestUser,
  beforeOpen: (page: Page) => void | Promise<void>,
): Promise<Session> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await beforeOpen(page)
  await signInContext(context, user.handle, user.name)
  await page.goto(`/b/${board}`)
  await waitForBoard(page)
  await expect(page.getByTestId('dev-identity-badge')).toHaveAttribute('data-user-id', user.id)
  return { user: user.handle, name: user.name, id: user.id, context, page }
}

/** Gives the canvas keyboard focus with a click on an empty spot (page coordinates). */
export async function focusCanvas(page: Page, at = { x: 900, y: 520 }) {
  const p = await toScreen(page, at)
  await page.mouse.click(p.x, p.y)
}

export const undo = (page: Page) => page.keyboard.press('ControlOrMeta+z')
export const redo = (page: Page) => page.keyboard.press('ControlOrMeta+Shift+z')

/** x and colour of a geo shape, or null once it is gone. */
export async function geoFacts(page: Page, id: string) {
  const s = await getShape(page, id)
  return s ? { x: s.x, color: s.props.color } : null
}

/** A relay for a page's board socket that can hold what the server sends until released. */
export interface ServerHold {
  hold(): void
  /** Delivers everything held, in order, and stops holding. */
  release(): void
  held(): number
}

/**
 * Routes `page`'s board sockets through Playwright (page.routeWebSocket): the page's messages go
 * straight to the server; the server's can be held back. Install before the board opens.
 */
export async function relayBoardSocket(page: Page): Promise<ServerHold> {
  let holding = false
  const queue: Array<() => void> = []
  await page.routeWebSocket(/\/connect\//, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      if (holding) queue.push(() => ws.send(m))
      else ws.send(m)
    })
  })
  return {
    hold: () => {
      holding = true
    },
    release: () => {
      holding = false
      for (const deliver of queue.splice(0)) deliver()
    },
    held: () => queue.length,
  }
}
