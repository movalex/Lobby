// OWNER: WS5 (wave T). Helpers for the timeline specs (t5-*.spec.ts) on the Excalidraw board page: a session with the
// timeline switch on (the dev-auth localStorage key of features/planning/flags.ts, set before any app script runs),
// the cards and timeline frame made through the facade, and readers for the bars the overlay draws.
//
// The run's sync needs DRAFTROOM_PLANNING=on (the spec's `test.use({ syncEnv })`) for the room to say 14. Until WS1's
// room rules replace `planningPending`, the foundation sync refuses every planning key write: these specs need WS1's sync.
import type { Browser, Locator, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import type { CanvasSession } from '../tests/support/canvas.ts'
import {
  canvasCall,
  createItem,
  createNote,
  expect,
  item,
  updateItem,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import type { Users } from '../tests/support/users.ts'

export { expect }

export const TIMELINE_FLAG_KEY = 'lobby.planTimeline'
export const VECTOR_PDF_KEY = 'lobby.dev.vectorPdf'

/** `YYYY-MM-DD` of a local date. */
export const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The Monday of today's week (local). */
export function thisMonday(now: Date = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

/**
 * The timeline these specs draw: twelve weeks starting on the Monday two weeks ago, so today is inside it. `W(n)` is
 * the Monday of its week n (week 0 is the first); `day(n, k)` the k-th day after it.
 */
export function rangeOf(now: Date = new Date()) {
  const first = thisMonday(now)
  first.setDate(first.getDate() - 14)
  const at = (days: number) => {
    const d = new Date(first)
    d.setDate(d.getDate() + days)
    return iso(d)
  }
  return {
    start: at(0),
    end: at(12 * 7 - 1),
    week: (n: number) => at(7 * n),
    day: (n: number, k: number) => at(7 * n + k),
  }
}

/** A signed-in tab with the timeline switch on (and vector PDF pages offered). */
export async function openPlanningSession(
  browser: Browser,
  users: Users,
  board: string,
  handle: string,
  role: 'owner' | 'editor' | 'commenter' | 'viewer' = 'editor',
): Promise<CanvasSession> {
  const user = role === 'owner' ? await users.get(handle) : await users.grant(board, handle, role)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await context.addInitScript(
    ({ flag, vector }) => {
      try {
        localStorage.setItem(flag, '1')
        localStorage.setItem(vector, '1')
      } catch {
        // blocked store: the shipped values
      }
    },
    { flag: TIMELINE_FLAG_KEY, vector: VECTOR_PDF_KEY },
  )
  const page = await context.newPage()
  await signInContext(context, user.handle, user.name)
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  await expect
    .poll(async () => (await canvasCall(page, 'me'))?.uid, { message: 'the welcome names this user' })
    .toBe(user.id)
  return { user: user.handle, name: user.name, id: user.id, context, page }
}

export interface MadeCard {
  readonly id: string
  readonly title: string
}

/** A sticky note made a card (`card:status`, and the dates it has). */
export async function makeCard(
  page: Page,
  at: { x: number; y: number },
  title: string,
  fields: { status?: string; start?: string; due?: string; tag?: string },
): Promise<MadeCard> {
  const id = await createNote(page, { x: at.x, y: at.y, text: title })
  const lobby: Record<string, unknown> = { 'card:status': fields.status ?? 'todo' }
  if (fields.start) lobby['card:start'] = fields.start
  if (fields.due) lobby['card:due'] = fields.due
  await updateItem(page, id, { customData: { lobby } })
  return { id, title }
}

/** A timeline frame. */
export async function makeTimeline(
  page: Page,
  at: { x: number; y: number; width?: number; height?: number },
  value: Record<string, unknown>,
  name = 'Plan',
): Promise<string> {
  return createItem(page, 'frame', {
    x: at.x,
    y: at.y,
    width: at.width ?? 1400,
    height: at.height ?? 520,
    name,
    customData: { lobby: { timeline: value } },
  })
}

/** The stored dates of a card. */
export async function datesOf(page: Page, id: string): Promise<{ start: string | null; due: string | null }> {
  const el = await item(page, id)
  const lobby = (el?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}
  return {
    start: typeof lobby['card:start'] === 'string' ? (lobby['card:start'] as string) : null,
    due: typeof lobby['card:due'] === 'string' ? (lobby['card:due'] as string) : null,
  }
}

export const timelineOf = (page: Page, frameId: string): Locator =>
  page.locator(`[data-testid="timeline"][data-frame-id="${frameId}"]`)

export const barOf = (page: Page, cardId: string): Locator =>
  page.locator(`[data-testid="timeline-bar"][data-card-id="${cardId}"]`)

/** Brings the whole board into view (the bars are pointer-active only where they are on screen). */
export async function fitBoard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const f = (window as unknown as { lobbyCanvas?: { zoomToFit?: () => void } }).lobbyCanvas
    f?.zoomToFit?.()
  })
  await page.waitForTimeout(400)
}

/** Drags a bar's middle (or an edge: `grab` 'start' | 'end') by `dx` screen pixels. */
export async function dragBar(
  page: Page,
  cardId: string,
  dx: number,
  grab: 'move' | 'start' | 'end' = 'move',
): Promise<void> {
  const box = await barOf(page, cardId).boundingBox()
  if (!box) throw new Error(`no bar for ${cardId}`)
  const y = box.y + box.height / 2
  const x = grab === 'move' ? box.x + box.width / 2 : grab === 'start' ? box.x + 3 : box.x + box.width - 3
  await page.mouse.move(x, y)
  await page.mouse.down()
  const steps = 8
  for (let i = 1; i <= steps; i++) await page.mouse.move(x + (dx * i) / steps, y)
  await page.mouse.up()
}

/** One undo step of this tab's own history (the board page's dev handle; the keyboard path is pinned once in the spec). */
export async function undoNow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const b = (window as unknown as { __lobbyBoard?: { canvas: { history: { undo(): void } } } }).__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard (not the Excalidraw board page, or not a dev-auth build)')
    b.canvas.history.undo()
  })
}
