// M2-1 (wave M, W2, FTU-6): the top-centre stack. In a live meeting the cursor chips used to draw over the spotlight bar's
// "Hide", toasts stacked onto bars, the presenter was told about her own spotlight in the third person, and the
// "Paused following" pill wrapped onto two lines. Now one column at the canvas's top centre holds the invitation to a
// presentation, the spotlight bar, the follow pills, the coach's chip and the prompt, eight pixels apart, with the toasts
// under it; remote cursors and compass chips keep out of its way.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m2-meeting-overlays.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  expect as canvasExpect,
  sceneToScreen,
  screenToScene,
  setViewport,
  viewport,
} from '../tests/support/canvas.ts'
import { commentsApi, noteAt, pin, shapeAnchor, threadPopover } from './comments-kit.ts'
import { openTab } from './l6-kit.ts'
import { startPresenting } from './present-kit.ts'
import { expect, expectItemsEverywhere, post, seed, test } from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

interface Box {
  x: number
  y: number
  w: number
  h: number
}
const box = async (loc: ReturnType<Page['getByTestId']>): Promise<Box> => {
  const b = await loc.boundingBox()
  if (!b) throw new Error('not on screen')
  return { x: b.x, y: b.y, w: b.width, h: b.height }
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** What is in the top-centre stack and under it right now, in client pixels. */
const stackRects = (page: Page) =>
  page.evaluate(() => {
    const r = (el: Element) => {
      const b = el.getBoundingClientRect()
      return { x: b.x, y: b.y, w: b.width, h: b.height }
    }
    const stack = document.querySelector('[data-testid="top-centre-stack"]')
    return {
      stack: stack ? r(stack) : null,
      // top to bottom as drawn (the DOM order is the order the boxes arrived in; CSS `order` puts them in their slots)
      items: stack
        ? [...stack.children]
            .filter((c) => c.getBoundingClientRect().height > 0)
            .map((c) => ({ slot: c.getAttribute('data-slot'), ...r(c) }))
            .sort((p, q) => p.y - q.y)
        : [],
      toasts: [...document.querySelectorAll('.dr-notice')].map((n) => ({
        text: n.textContent ?? '',
        ...r(n),
      })),
    }
  })

/**
 * Moves `page`'s camera until scene point `scene` is at screen point `at`, reading back after each move. One
 * computed move is not enough: the camera can still be settling on its own (bob's once centred on the spotlit
 * note between the viewport read and the point read, and the move made from the two was 300 px off).
 */
const bringTo = async (page: Page, scene: { x: number; y: number }, at: { x: number; y: number }) => {
  await expect
    .poll(
      async () => {
        const now = await sceneToScreen(page, scene)
        const off = Math.hypot(now.x - at.x, now.y - at.y)
        if (off < 1) return 0
        const view = await viewport(page)
        await setViewport(page, {
          x: view.x + (now.x - at.x) / view.zoom,
          y: view.y + (now.y - at.y) / view.zoom,
        })
        return off
      },
      { intervals: [100, 250, 500] },
    )
    .toBe(0)
}

const startSpotlight = async (a: Parameters<typeof post>[0], board: string, id: string) => {
  const res = await post(a, `/api/boards/${board}/spotlight`, { refs: [`shape:${id}`], bringEveryone: false })
  expect(res.status(), await res.text()).toBe(200)
}

test('a remote cursor parked on the spotlight bar is hidden while it is there, and Hide is the thing under the pointer', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, { notes: [{ id: 'm2o-n', x: 300, y: 400, text: 'Spotlit' }] })
  await expectItemsEverywhere([b], ['m2o-n'])
  await startSpotlight(a, board, 'm2o-n')
  await expect(b.page.getByTestId('spotlight-bar')).toBeVisible()
  await expect(b.page.locator('[data-testid="top-centre-stack"] [data-testid="spotlight-bar"]')).toBeVisible()

  // Alice's pointer rests on empty canvas of her own (a pointer over her own bar is not on her board: she would send none);
  // Bob's camera is moved so that spot is under his Hide button: his view of her cursor is then on the bar
  const hide = b.page.getByTestId('spotlight-hide')
  const hb = await box(hide)
  const onBob = { x: hb.x + hb.w / 2, y: hb.y + hb.h / 2 }
  const spot = { x: 760, y: 640 }
  const scene = await screenToScene(a.page, spot)
  const cursor = b.page.locator(`[data-testid="cursor"][data-uid="${a.id}"]`)
  await a.page.mouse.move(spot.x, spot.y)
  await expect(cursor).toBeVisible()
  await expect(cursor).not.toHaveAttribute('data-obscured', /.*/)
  await bringTo(b.page, scene, onBob)

  await test.step('parked on the bar: hidden, and the button is what is under the point', async () => {
    await expect(cursor).toHaveAttribute('data-obscured', 'true')
    await expect(cursor).toBeHidden()
    const top = await b.page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return el?.closest('[data-testid]')?.getAttribute('data-testid') ?? null
    }, onBob)
    expect(top).toBe('spotlight-hide')
    // Hide is clickable where it is (nothing of the cursor is in front of it)
    await hide.click({ trial: true })
  })

  await test.step("a chip over the bar's text is hidden too, not only one over a button", async () => {
    const text = await box(b.page.getByTestId('spotlight-text'))
    await bringTo(b.page, scene, { x: text.x + text.w / 2, y: text.y + text.h / 2 })
    await expect(cursor).toHaveAttribute('data-obscured', 'true')
    await expect(cursor).toBeHidden()
  })

  await test.step('moved away, it is back', async () => {
    await a.page.mouse.move(spot.x + 200, spot.y + 100)
    await expect(cursor).toBeVisible()
    await expect(cursor).not.toHaveAttribute('data-obscured', /.*/)
  })
})

test('after a spotlight and a presentation end, the toasts sit under the bars, never over them; the presenter is told "You ended the spotlight."', async ({
  join,
  board,
}) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, {
    frames: [{ id: 'm2o-f', x: 0, y: 0, w: 800, h: 450, name: 'Slide' }],
    notes: [{ id: 'm2o-n2', x: 200, y: 600, text: 'Look here' }],
  })
  await expectItemsEverywhere([b], ['m2o-f', 'm2o-n2'])
  await startSpotlight(a, board, 'm2o-n2')
  await expect(b.page.getByTestId('spotlight-bar')).toBeVisible()
  await expect(a.page.getByTestId('spotlight-bar')).toBeVisible()

  await test.step('Alice presents to everyone: the invitation joins the spotlight bar in one column, 8 px apart', async () => {
    await startPresenting(a.page.getByTestId('present-button'), 'everyone')
    await expect(a.page.getByTestId('live-presenting')).toBeVisible()
    await expect(b.page.getByTestId('live-invite')).toBeVisible({ timeout: 5_000 })
    const col = await stackRects(b.page)
    expect(col.items.map((i) => i.slot)).toEqual(['invite', 'spotlight'])
    const [invite, bar] = col.items as [Box & { slot: string | null }, Box & { slot: string | null }]
    expect(overlaps(invite, bar)).toBe(false)
    expect(Math.round(bar.y - (invite.y + invite.h))).toBe(8)
    // one column: the same centre
    expect(Math.abs(invite.x + invite.w / 2 - (bar.x + bar.w / 2))).toBeLessThan(2)
  })

  await test.step("Bob follows, Alice ends it: Bob's toast is under the spotlight bar, with a gap, not over it", async () => {
    await b.page.getByTestId('live-join').click()
    await expect(b.page.getByTestId('live-following')).toBeVisible()
    await a.page.keyboard.press('Escape')
    const toast = b.page.locator('[data-testid="live-ended-toast"]')
    await expect(toast).toBeVisible({ timeout: 8_000 })
    await expect(toast).toHaveText(/Alice Park ended the presentation\./)
    await expect(b.page.getByTestId('spotlight-bar')).toBeVisible()
    await expect.poll(async () => (await stackRects(b.page)).toasts.length).toBeGreaterThan(0)
    const col = await stackRects(b.page)
    const bar = col.items.find((i) => i.slot === 'spotlight') as Box
    expect(bar).toBeTruthy()
    for (const t of col.toasts) {
      expect(overlaps(t, bar), `toast "${t.text}" over the bar`).toBe(false)
      expect(t.y, `toast "${t.text}" is under the bar`).toBeGreaterThanOrEqual(bar.y + bar.h)
    }
    expect(Math.round((col.toasts[0]?.y ?? 0) - (bar.y + bar.h))).toBeGreaterThanOrEqual(7)
  })

  await test.step('Alice ends the spotlight: she is told so in the second person, Bob in the third; both toasts clear the (now empty) stack', async () => {
    await a.page.getByTestId('spotlight-end').click()
    await expect(a.page.getByTestId('spotlight-ended-toast')).toHaveText('You ended the spotlight.')
    await expect(b.page.getByTestId('spotlight-ended-toast')).toHaveText('Alice Park ended the spotlight.')
    await expect(b.page.getByTestId('spotlight-bar')).toHaveCount(0)
    // every toast of Bob's is disjoint from every other
    const col = await stackRects(b.page)
    for (const [i, x] of col.toasts.entries())
      for (const y of col.toasts.slice(i + 1))
        expect(overlaps(x, y), `"${x.text}" over "${y.text}"`).toBe(false)
  })
})

test('the paused-following pill fits on one line at 390 px, inside the stack, with the long name cut short', async ({
  join,
  browser,
  board,
  users,
}) => {
  const a = await join('alice')
  const b = await openTab(browser, board, users, 'bob', {
    role: 'editor',
    options: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  })
  try {
    const sid = await a.page.evaluate(
      () =>
        (window as unknown as { __lobbyBoard?: { core: { sid: string | null } } }).__lobbyBoard?.core.sid ??
        null,
    )
    expect(sid).toBeTruthy()
    // Bob follows Alice and pauses it by moving the camera (a wheel on the canvas, as l6-follow-pause)
    await b.page.evaluate(
      (s) =>
        (
          window as unknown as { __lobbyBoard: { canvas: { follow: { start(sid: string): void } } } }
        ).__lobbyBoard.canvas.follow.start(s as string),
      sid,
    )
    await expect(b.page.getByTestId('following-label')).toBeVisible()
    // the phone's first-run hint ("Drag to look around the board") sits where the stack does: dismissed first
    const gotIt = b.page.getByRole('button', { name: 'Got it' })
    if (await gotIt.isVisible()) await gotIt.click()
    // a wheel pauses it
    const vp = b.page.viewportSize() ?? { width: 390, height: 844 }
    await b.page.mouse.move(vp.width / 2, vp.height / 2)
    await b.page.mouse.wheel(0, 240)
    const pill = b.page.getByTestId('follow-paused')
    await expect(pill).toBeVisible()
    const pb = await box(pill)
    // one line: its height is one line of 12.5 px text and the padding and border (about 33 px), not two
    expect(pb.h, 'a single line').toBeLessThan(40)
    expect(pb.x).toBeGreaterThanOrEqual(0)
    expect(pb.x + pb.w).toBeLessThanOrEqual(390)
    // the words stay on one line: the text and the name are not stacked
    const lines = await pill.evaluate((el) => {
      // the rows the words are on, by the middle of each piece of text (a 15 px "×" is not a second line)
      const middles = new Set<number>()
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!(n.textContent ?? '').trim()) continue
        const range = document.createRange()
        range.selectNodeContents(n)
        for (const r of range.getClientRects()) middles.add(Math.round((r.top + r.height / 2) / 8))
      }
      return middles.size
    })
    expect(lines).toBe(1)
    // it is in the stack, in the follow slot, at the phone's top (under the page's own controls)
    await expect(
      b.page.locator('[data-testid="top-centre-stack"] > [data-slot="follow"] [data-testid="follow-paused"]'),
    ).toBeVisible()
    const stack = await stackRects(b.page)
    expect(stack.stack?.y ?? 0).toBeGreaterThan(50)
  } finally {
    await b.context.close()
  }
})

test('an undo toast goes when a popover opens (it used to stay through them), and a newer one replaces it', async ({
  canvasSession,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  const note = await noteAt(a.page, 0, 0, 'Resolve me')
  const api = commentsApi(await users.api('alice'))
  const first = await api.createThread(board, shapeAnchor(note), 'First')
  const second = await api.createThread(board, shapeAnchor(note, 0.2, 0.2), 'Second')
  await canvasExpect(pin(a.page, first.id)).toBeVisible()
  const resolve = async (id: string) => {
    await pin(a.page, id).click()
    await threadPopover(a.page, id).getByTestId('thread-resolve').click()
  }
  const undoToast = a.page.locator('.dr-notice', { hasText: 'Thread resolved' })

  await test.step('resolving a second thread while the first toast is up: only the newer one offers Undo', async () => {
    await resolve(first.id)
    await expect(undoToast.getByRole('button', { name: 'Undo' })).toBeVisible()
    await resolve(second.id)
    await expect(undoToast).toHaveCount(1, { timeout: 2_000 })
    await expect(undoToast.getByRole('button', { name: 'Undo' })).toHaveCount(1)
  })

  await test.step('opening the board menu (a popover) takes the Undo toast down', async () => {
    await a.page.waitForTimeout(700) // past the grace: the toast did not come from the same gesture
    await a.page.getByTestId('main-menu.button').click()
    await expect(a.page.getByTestId('main-menu')).toBeVisible()
    await expect(undoToast).toHaveCount(0, { timeout: 2_000 })
    await a.page.keyboard.press('Escape')
  })
})
