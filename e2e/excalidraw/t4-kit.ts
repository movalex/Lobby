// OWNER: WS4 (wave T). What the t4 specs share: the planning switches turned on in a page (a dev-auth build reads
// localStorage PLANNING_FLAG_KEYS, features/planning/flags.ts), seeding Kanbans and cards through the page's own
// transact (every write through the sync engine and the room's planning rules), and reads of the stored keys.
import type { BrowserContext, Page } from '@playwright/test'
import { expectSaved, item } from '../tests/support/canvas.ts'
import { storedElement } from '../tests/support/excalidraw.ts'
import type { Stack } from '../tests/support/stack.ts'
import { reloadBoard, type WorkshopCanvasSession } from './workshops-kit.ts'

export * from './workshops-kit.ts'

/** The wave T switches of WS4 (cards, Kanban, the table), as a dev-auth page reads them. */
export const WS4_FLAGS: Readonly<Record<string, string>> = {
  'lobby.planCards': '1',
  'lobby.planKanban': '1',
  'lobby.planTable': '1',
}

/** Turns WS4's switches on for every page of `context` (from its next navigation). */
export async function planningOn(context: BrowserContext): Promise<void> {
  await context.addInitScript((flags: Record<string, string>) => {
    try {
      for (const [k, v] of Object.entries(flags)) localStorage.setItem(k, v)
    } catch {
      // a blocked store: the switches stay off and the spec fails on what it looks for
    }
  }, WS4_FLAGS)
}

/** A joined session with the switches on: the init script, then a reload, then the room's revision 14. */
export async function withPlanning(s: WorkshopCanvasSession): Promise<WorkshopCanvasSession> {
  await planningOn(s.context)
  await reloadBoard(s)
  await roomSays14(s.page)
  return s
}

/** Waits until the page's room announced contracts revision 14 (planning offered). */
export async function roomSays14(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __lobbyBoard?: { canvas: { room: { contractsRev(): number | null } } } }
      ).__lobbyBoard?.canvas.room.contractsRev() === 14,
    undefined,
    { timeout: 20_000 },
  )
}

export interface CardSeed {
  id: string
  kind?: 'note' | 'rectangle'
  x: number
  y: number
  w?: number
  h?: number
  text?: string
  frameId?: string
  lobby?: Record<string, unknown>
}

/**
 * Creates Kanban frames and cards in one transact (their keys in `customData`), waits for Saved, then puts the cards
 * that go into a frame there in a second transact (`setFrame` does not see an element made in the same step).
 */
export async function seedPlanning(
  page: Page,
  what: {
    kanbans?: {
      id: string
      x: number
      y: number
      w: number
      h: number
      name?: string
      value?: Record<string, unknown>
    }[]
    cards?: CardSeed[]
  },
): Promise<void> {
  await page.evaluate((w) => {
    type Tx = { create(kind: string, props: Record<string, unknown>): string }
    const b = (
      window as unknown as { __lobbyBoard: { canvas: { transact<T>(l: string, fn: (tx: Tx) => T): T } } }
    ).__lobbyBoard
    b.canvas.transact('e2e seed planning', (tx) => {
      for (const k of w.kanbans ?? [])
        tx.create('frame', {
          id: k.id,
          x: k.x,
          y: k.y,
          width: k.w,
          height: k.h,
          name: k.name ?? 'Kanban',
          customData: { lobby: { kanban: k.value ?? {} } },
        })
      for (const c of w.cards ?? []) {
        const customData = c.lobby ? { lobby: c.lobby } : undefined
        if ((c.kind ?? 'note') === 'note')
          tx.create('note', {
            id: c.id,
            x: c.x,
            y: c.y,
            ...(c.text !== undefined ? { text: c.text } : {}),
            ...(customData ? { customData } : {}),
          })
        else
          tx.create('rectangle', {
            id: c.id,
            x: c.x,
            y: c.y,
            width: c.w ?? 200,
            height: c.h ?? 120,
            backgroundColor: 'transparent',
            ...(customData ? { customData } : {}),
          })
      }
    })
  }, what)
  await expectSaved(page)
  const inFrames = (what.cards ?? []).filter((c) => c.frameId)
  if (!inFrames.length) return
  await page.evaluate((list) => {
    type Tx = { setFrame(ids: string[], frameId: string | null): void }
    const b = (
      window as unknown as { __lobbyBoard: { canvas: { transact(l: string, fn: (tx: Tx) => void): void } } }
    ).__lobbyBoard
    b.canvas.transact('e2e seed planning frames', (tx) => {
      for (const c of list) tx.setFrame([c.id], c.frameId as string)
    })
  }, inFrames)
  await expectSaved(page)
}

/** An element's `customData.lobby` in this page. */
export const lobbyIn = async (page: Page, id: string): Promise<Record<string, unknown>> =>
  ((await item(page, id))?.customData?.lobby ?? {}) as Record<string, unknown>

/** An element's `customData.lobby` as the server stores it. */
export const storedLobby = async (
  stack: Stack,
  board: string,
  id: string,
): Promise<Record<string, unknown>> =>
  ((await storedElement(stack, board, id))?.customData?.lobby ?? {}) as Record<string, unknown>

/** The card keys only (`card:*`), for comparing. */
export const cardKeys = (lobby: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(lobby).filter(([k]) => k.startsWith('card:')))

export const chips = (page: Page, id: string) =>
  page.locator(`[data-testid="card-chips"][data-element-id="${id}"]`)
export const popover = (page: Page) => page.getByTestId('card-popover')

/** Opens a card's popover from its chips. */
export async function openCard(page: Page, id: string) {
  await chips(page, id).click()
  await page.getByTestId('card-popover').waitFor()
}
