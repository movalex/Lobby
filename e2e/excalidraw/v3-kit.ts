// OWNER: WS4 (wave V, breakouts). Helpers for e2e/excalidraw/v3-*.spec.ts: people on one board with the breakouts web
// switch on (localStorage 'lobby.liveBreakouts' = '1' before any app script: a dev-auth build reads it,
// apps/web/src/features/live/flags.ts LIVE_FLAG_KEYS; the e2e stack runs the api with DRAFTROOM_BREAKOUTS on), each in
// its own browser context with the workshops kit's network log (the board events this page received), and the
// page's camera and follow state.
import type { Page, Request } from '@playwright/test'
import { type Api, type BoardRole, signInContext } from '../tests/support/api.ts'
import { canvasCall, test as canvasTest, viewport } from '../tests/support/canvas.ts'
import { expect } from '../tests/support/fixtures.ts'
import { API_URL, WEB_URL } from '../tests/support/ports.ts'
import { CanvasNetworkLog, waitForWorkshopBoard } from './workshops-kit.ts'

export { expect }

/** apps/web/src/features/live/flags.ts LIVE_FLAG_KEYS.breakouts (not imported: that module reads import.meta.env) */
export const BREAKOUTS_FLAG = 'lobby.liveBreakouts'

export const PHONE = {
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
}

export interface Person {
  readonly handle: string
  readonly name: string
  readonly id: string
  readonly page: Page
  readonly net: CanvasNetworkLog
  readonly api: Api
  /** requests this page made outside Lobby's own origins (the web and the api) */
  readonly foreign: string[]
}

export interface V3Fixtures {
  /** Opens the board as `handle` with `role` (alice owns it), the breakouts switch on. */
  person(handle: string, role?: BoardRole, opts?: { phone?: boolean }): Promise<Person>
}

export const test = canvasTest.extend<V3Fixtures>({
  person: async ({ browser, board, users }, use) => {
    const opened: { net: CanvasNetworkLog; close(): Promise<void> }[] = []
    await use(async (handle, role = 'editor', opts = {}) => {
      const user = await users.grant(board, handle, role)
      const context = await browser.newContext(opts.phone ? PHONE : {})
      await context.addInitScript((key) => {
        try {
          localStorage.setItem(key, '1')
        } catch {
          // a blocked store: the switch stays off and the spec fails on its first expectation
        }
      }, BREAKOUTS_FLAG)
      const page = await context.newPage()
      const own = new Set([new URL(WEB_URL).origin, new URL(API_URL).origin])
      const foreign: string[] = []
      page.on('request', (r: Request) => {
        const url = new URL(r.url())
        if (url.protocol === 'data:' || url.protocol === 'blob:') return
        if (!own.has(url.origin)) foreign.push(r.url())
      })
      const net = new CanvasNetworkLog()
      await net.attach(context, page)
      await signInContext(context, user.handle, user.name)
      await page.goto(`/b/${board}`)
      await expect(page.getByTestId('dev-identity-badge')).toHaveAttribute('data-user-id', user.id)
      await waitForWorkshopBoard(page)
      opened.push({ net, close: () => context.close() })
      return { handle, name: user.name, id: user.id, page, net, api: await users.api(handle), foreign }
    })
    await Promise.all(
      opened.map(async (o) => {
        await o.net.detach()
        await o.close()
      }),
    )
  },
})

/** The session this page follows (canvas.follow.current), or null. */
export const following = (page: Page) =>
  page.evaluate(() => {
    const c = (window as unknown as { __lobbyBoard: { canvas: { follow: { current(): string | null } } } })
      .__lobbyBoard.canvas
    try {
      return c.follow.current()
    } catch {
      return null
    }
  })

/** This page's own presence session id. */
export const sidOf = async (page: Page) => (await canvasCall(page, 'me'))?.sid ?? null

/** Whether this page's view is centred inside `frame` (scene coordinates). */
export async function viewCentredIn(page: Page, frame: { x: number; y: number; w: number; h: number }) {
  const v = await viewport(page)
  const cx = v.x + v.width / 2
  const cy = v.y + v.height / 2
  return cx >= frame.x && cx <= frame.x + frame.w && cy >= frame.y && cy <= frame.y + frame.h
}

/** The board events of `type` this page received. */
export const eventsOf = (p: Person, type: string) => p.net.eventsOf(type)

/** Opens the Breakouts panel from the Facilitate menu (the registered entry). */
export async function openBreakouts(page: Page) {
  const panel = page.getByTestId('breakouts-panel')
  if (await panel.isVisible()) return panel
  await page.getByTestId('facilitate-button').click()
  await expect(page.getByTestId('facilitate-menu')).toBeVisible()
  await page.getByTestId('breakouts-entry').click()
  await expect(panel).toBeVisible()
  return panel
}
