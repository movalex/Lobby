// Presence on the Excalidraw board page (ported from the tldraw suite's collab-lifecycle step 1 and the
// plan's presence-roles check, docs/EXCALIDRAW-MIGRATION.md §2.7, §6.3): the people list, named cursors
// where the other person's pointer is (every role, no tool selected), "X is typing" while someone holds
// a note's lease, what the other person has selected (W5-28), a marker on the canvas's edge for a person
// who is off screen (W5-32), and leaving.
import type { Page } from '@playwright/test'
import {
  type CanvasSession,
  createNote,
  expect,
  itemBounds,
  itemCenterOnScreen,
  items,
  sceneToScreen,
  screenToScene,
  select,
  selectNone,
  setTool,
  setViewport,
  startTextEditing,
  stopTextEditing,
  test,
  updateItem,
  viewport,
  waitForItem,
} from '../tests/support/canvas.ts'
import { openPhoneSession } from './a11y-kit.ts'
import { emptyCanvasPoint } from './board-kit.ts'

const avatar = (s: CanvasSession, of: CanvasSession) =>
  s.page.locator(`[data-testid="presence-user"][data-user-id="${of.id}"]`)
const cursorOf = (s: CanvasSession, of: CanvasSession) =>
  s.page.locator(`[data-testid="cursor"][data-uid="${of.id}"]`)

/** Moves `s`'s real pointer over empty canvas and returns the scene point it ended on. */
async function hover(s: CanvasSession, dx = 0, dy = 0) {
  const p = await emptyCanvasPoint(s.page)
  await s.page.mouse.move(p.x + dx - 20, p.y + dy - 10)
  await s.page.mouse.move(p.x + dx, p.y + dy, { steps: 4 })
  return screenToScene(s.page, { x: p.x + dx, y: p.y + dy })
}

/** Where `page` draws a cursor for the scene point `at` (its tip), in client pixels. */
async function expectCursorAt(page: Page, cursor: ReturnType<typeof cursorOf>, at: { x: number; y: number }) {
  const want = await sceneToScreen(page, at)
  await expect
    .poll(async () => {
      const box = await cursor.boundingBox()
      return box
        ? Math.max(Math.abs(box.x + 2 - want.x), Math.abs(box.y + 2 - want.y))
        : Number.POSITIVE_INFINITY
    })
    .toBeLessThan(4)
}

test('two people see one another: the people list, a named cursor where the pointer is, and "X is typing" while one types', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await expect(avatar(a, b)).toBeVisible()
  await expect(avatar(b, a)).toBeVisible()
  await expect(avatar(a, b)).toHaveAttribute('title', b.name)
  // nobody lists themselves
  await expect(avatar(a, a)).toHaveCount(0)

  const at = await hover(b)
  const cursor = cursorOf(a, b)
  await expect(cursor).toBeVisible()
  await expect(cursor).toContainText(b.name)
  await expectCursorAt(a.page, cursor, at)
  // it follows the pointer
  const next = await hover(b, -180, -90)
  await expectCursorAt(a.page, cursor, next)
  // a feature's cursor filter (present mode, "hide cursors") hides it until it stops filtering
  await a.page.evaluate(
    (sid) => {
      const r = (
        window as unknown as {
          __lobbyBoard?: {
            registries: { cursorVisible: { provide(fn: (sid: string) => boolean): () => void } }
          }
        }
      ).__lobbyBoard?.registries
      ;(window as unknown as { __unhide?: () => void }).__unhide = r?.cursorVisible.provide((s) => s !== sid)
    },
    await cursor.getAttribute('data-sid'),
  )
  await hover(b, -170, -80)
  await expect(cursor).toHaveCount(0)
  await a.page.evaluate(() => (window as unknown as { __unhide?: () => void }).__unhide?.())
  await hover(b, -160, -70)
  await expect(cursor).toBeVisible()

  const note = await createNote(a.page, { x: 140, y: 120, text: 'Hi' })
  await waitForItem(b.page, note)
  await startTextEditing(a.page, note)
  const badge = b.page.locator(`[data-testid="typing-badge"][data-lease="${note}"]`)
  await expect(badge).toContainText(`${a.name} is typing`)
  // this tab never badges its own lease
  await expect(a.page.locator(`[data-testid="typing-badge"][data-lease="${note}"]`)).toHaveCount(0)
  await stopTextEditing(a.page)
  await expect(badge).toHaveCount(0)
})

test("a viewer's and a commenter's cursors reach an editor, with no tool selected", async ({
  canvasSession,
}) => {
  const editor = await canvasSession('alice')
  const viewer = await canvasSession('bob', { role: 'viewer' })
  const commenter = await canvasSession('carol', { role: 'commenter' })
  const v = await hover(viewer)
  const c = await hover(commenter, -250, -120)
  await expectCursorAt(editor.page, cursorOf(editor, viewer), v)
  await expectCursorAt(editor.page, cursorOf(editor, commenter), c)
  await expect(cursorOf(editor, viewer)).toContainText(viewer.name)
  await expect(avatar(editor, viewer)).toBeVisible()
  await expect(avatar(editor, commenter)).toBeVisible()
})

test('someone who closes the board leaves the people list, and their cursor goes', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await hover(b)
  await expect(cursorOf(a, b)).toBeVisible()
  await expect(avatar(a, b)).toBeVisible()
  await b.context.close()
  await expect(avatar(a, b)).toHaveCount(0, { timeout: 20_000 })
  await expect(cursorOf(a, b)).toHaveCount(0)
})

const selectionOf = (s: CanvasSession, of: CanvasSession) =>
  s.page.locator(`[data-testid="remote-selection"][data-uid="${of.id}"]`)

/** Where `page` draws element `id` (client px): its scene bounds through the camera. */
async function screenBox(page: Page, id: string) {
  const b = await itemBounds(page, id)
  if (!b) throw new Error(`no bounds for ${id}`)
  const tl = await sceneToScreen(page, { x: b.x, y: b.y })
  const br = await sceneToScreen(page, { x: b.x + b.width, y: b.y + b.height })
  return { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }
}

/** The outline sits 4 px outside the element on every side (chrome.tsx OUTLINE_PAD), within 3 px. */
async function expectAround(page: Page, outline: ReturnType<typeof selectionOf>, id: string) {
  await expect
    .poll(async () => {
      const [box, want] = await Promise.all([outline.boundingBox(), screenBox(page, id)])
      if (!box) return Number.POSITIVE_INFINITY
      return Math.max(
        Math.abs(box.x - (want.x - 4)),
        Math.abs(box.y - (want.y - 4)),
        Math.abs(box.width - (want.width + 8)),
        Math.abs(box.height - (want.height + 8)),
      )
    })
    .toBeLessThan(3)
}

type BoardWindow = {
  __lobbyBoard?: {
    session: { presenceHub: { dragOffsetOf(id: string): { x: number; y: number } | null } | null }
    canvas: {
      presence: { peers(): { sid: string }[] }
      settings: { set(p: { focusMode: boolean }): void }
    }
    registries: { cursorVisible: { provide(fn: (sid: string) => boolean): () => void } }
  }
  __unhide?: () => void
}

test("W5-28: what alice has selected is outlined in her colour on bob's canvas, with her name; it follows the note and hides with her cursor", async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const note = await createNote(a.page, { x: 140, y: 120, text: 'Mine' })
  const other = await createNote(a.page, { x: 520, y: 120, text: 'Other' })
  await waitForItem(b.page, note)
  await waitForItem(b.page, other)
  await selectNone(a.page)
  const outline = selectionOf(b, a)
  await expect(outline).toHaveCount(0)

  await test.step('alice selects a note: bob sees it outlined, her name on it; her own canvas has none', async () => {
    await select(a.page, [note])
    await expect(outline).toHaveCount(1)
    await expect(outline).toHaveAttribute('data-ids', note)
    await expect(outline).toContainText(a.name)
    await expectAround(b.page, outline, note)
    const colour = await outline.evaluate((el) => getComputedStyle(el).borderTopColor)
    expect(colour).not.toBe('rgba(0, 0, 0, 0)')
    await expect(a.page.getByTestId('remote-selection')).toHaveCount(0)
  })

  await test.step('two notes: one outline each, her name on the first; the outline follows a move', async () => {
    await select(a.page, [note, other])
    await expect(outline).toHaveCount(2)
    await expect(outline.filter({ hasText: a.name })).toHaveCount(1)
    await select(a.page, [note])
    await expect(outline).toHaveCount(1)
    const before = await itemBounds(a.page, note)
    if (!before) throw new Error('no bounds')
    await updateItem(a.page, note, { x: before.x + 240, y: before.y + 60 })
    await expect
      .poll(async () => Math.round((await itemBounds(b.page, note))?.x ?? 0))
      .toBe(Math.round(before.x + 240))
    await expectAround(b.page, outline, note)
  })

  await test.step('"hide cursors" (a cursor filter) and focus mode hide it; it comes back with them', async () => {
    const sid = await b.page.evaluate(
      () => (window as unknown as BoardWindow).__lobbyBoard?.canvas.presence.peers()[0]?.sid ?? null,
    )
    expect(sid).not.toBeNull()
    await b.page.evaluate((hidden) => {
      const w = window as unknown as BoardWindow
      w.__unhide = w.__lobbyBoard?.registries.cursorVisible.provide((s) => s !== hidden)
    }, sid)
    await expect(outline).toHaveCount(0)
    await b.page.evaluate(() => (window as unknown as BoardWindow).__unhide?.())
    await expect(outline).toHaveCount(1)
    const focus = (on: boolean) =>
      b.page.evaluate((v) => {
        ;(window as unknown as BoardWindow).__lobbyBoard?.canvas.settings.set({ focusMode: v })
      }, on)
    await focus(true)
    await expect(outline).toHaveCount(0)
    await focus(false)
    await expect(outline).toHaveCount(1)
  })

  await test.step('alice drags the note: the outline moves with the live preview, then sits on the result', async () => {
    const start = await outline.boundingBox()
    if (!start) throw new Error('no outline')
    const zb = (await viewport(b.page)).zoom
    const from = await itemBounds(a.page, note)
    if (!from) throw new Error('no bounds')
    const c = await itemCenterOnScreen(a.page, note)
    await a.page.mouse.move(c.x, c.y)
    await a.page.mouse.down()
    await a.page.mouse.move(c.x + 160, c.y + 40, { steps: 8 })
    // still dragging: bob's outline is where his canvas previews the note (the relayed drag offset, through
    // his zoom), and it has moved right (the preview lags the first pointer step: the relay's offset starts
    // from where the note was at the drag's first frame)
    const offset = () =>
      b.page.evaluate(
        (id) =>
          (window as unknown as BoardWindow).__lobbyBoard?.session.presenceHub?.dragOffsetOf(id) ?? null,
        note,
      )
    await expect.poll(async () => (await offset())?.x ?? 0).toBeGreaterThan(100)
    await expect
      .poll(async () => {
        const [box, off] = await Promise.all([outline.boundingBox(), offset()])
        if (!box || !off) return Number.POSITIVE_INFINITY
        return Math.max(Math.abs(box.x - start.x - off.x * zb), Math.abs(box.y - start.y - off.y * zb))
      })
      .toBeLessThan(3)
    expect(from.x).toBeLessThan((await itemBounds(a.page, note))?.x ?? 0)
    await a.page.mouse.up()
    await expect
      .poll(async () => Math.round((await itemBounds(b.page, note))?.x ?? 0))
      .toBe(Math.round((await itemBounds(a.page, note))?.x ?? Number.NaN))
    await expectAround(b.page, outline, note)
  })

  await test.step('alice clears her selection: the outline goes', async () => {
    await selectNone(a.page)
    await expect(outline).toHaveCount(0)
  })
})

const markerOf = (s: CanvasSession, of: CanvasSession) =>
  s.page.locator(`[data-testid="edge-marker"][data-uid="${of.id}"]`)

type FollowWindow = {
  __lobbyBoard?: {
    canvas: {
      follow: { current(): string | null; stop(): void }
      presence: { peers(): { sid: string; uid: string; point: { x: number; y: number } | null }[] }
      settings: { set(p: { focusMode: boolean }): void }
    }
    registries: { cursorVisible: { provide(fn: (sid: string) => boolean): () => void } }
  }
  __unhideMarker?: () => void
}

/** Where `of`'s pointer is on `s`'s side: the point the room has streamed to her (scene px), or null. */
const peerPoint = (s: CanvasSession, of: CanvasSession) =>
  s.page.evaluate(
    (uid) =>
      (window as unknown as FollowWindow).__lobbyBoard?.canvas.presence.peers().find((p) => p.uid === uid)
        ?.point ?? null,
    of.id,
  )

/** The camera once it has stopped moving (an animated camera move is on its way until two reads agree). */
async function restingViewport(page: Page) {
  let last = await viewport(page)
  await expect
    .poll(async () => {
      const now = await viewport(page)
      const same = now.x === last.x && now.y === last.y && now.zoom === last.zoom
      last = now
      return same
    })
    .toBe(true)
  return last
}

/** The canvas region's client rectangle. */
async function canvasBox(page: Page) {
  const box = await page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!box) throw new Error('no board canvas')
  return box
}

test('W5-32: a person who is off screen has a chip on the canvas edge pointing to them; a click goes to them, Shift-click follows; it hides with their cursor and in focus mode', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const at = await hover(b)
  await expect(cursorOf(a, b)).toBeVisible()
  const marker = markerOf(a, b)

  await test.step("bob is on alice's screen: his cursor, no marker", async () => {
    await expect(marker).toHaveCount(0)
  })

  await test.step('alice pans so bob is far to the left: a chip on her left edge, in his colour, inside the canvas', async () => {
    const v = await viewport(a.page)
    await setViewport(a.page, { x: at.x + 6000, y: at.y - v.height / 2 })
    await expect(marker).toHaveCount(1)
    await expect(marker).toHaveAttribute('data-side', 'left')
    await expect(marker).toHaveAttribute('aria-label', `Go to ${b.name}, off screen to the left`)
    const [m, c] = await Promise.all([marker.boundingBox(), canvasBox(a.page)])
    if (!m) throw new Error('no marker box')
    expect(m.x).toBeGreaterThanOrEqual(c.x)
    expect(m.x).toBeLessThan(c.x + 40)
    expect(m.y).toBeGreaterThanOrEqual(c.y)
    expect(m.y + m.height).toBeLessThanOrEqual(c.y + c.height)
    expect(await marker.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
    await expect(marker).toContainText(/\S/)
    // alice has no pointer on the board, but her view is now far to the right of his: he gets a chip for her,
    // pointing at the middle of her view (a person whose pointer is off the canvas is "here" only while their
    // view overlaps his)
    await expect(markerOf(b, a)).toHaveAttribute('data-side', 'right')
  })

  await test.step('the chip is on the side bob is on: above her view, it moves to the top edge', async () => {
    const v = await viewport(a.page)
    await setViewport(a.page, { x: at.x - v.width / 2, y: at.y + 6000 })
    await expect(marker).toHaveAttribute('data-side', 'top')
    await setViewport(a.page, { x: at.x - v.width / 2, y: at.y - 6000 - v.height })
    await expect(marker).toHaveAttribute('data-side', 'bottom')
    await setViewport(a.page, { x: at.x + 6000, y: at.y - v.height / 2 })
    await expect(marker).toHaveAttribute('data-side', 'left')
  })

  await test.step('a click goes to bob: his pointer is on her screen and the chip is gone', async () => {
    // the chip goes to where bob's pointer is on her side. His mouse moved in steps and the stream is throttled,
    // so wait until she has the point it ended on: a click before that goes to a step on the way (this step
    // used to rest a few px off, about one run in fifty)
    await expect
      .poll(async () => {
        const p = await peerPoint(a, b)
        return p ? Math.max(Math.abs(p.x - at.x), Math.abs(p.y - at.y)) : Number.POSITIVE_INFINITY
      })
      .toBeLessThan(1)
    await marker.click()
    // the camera moves (animated) until bob's pointer is in the middle of her view
    await expect
      .poll(async () => {
        const [v, p] = await Promise.all([viewport(a.page), peerPoint(a, b)])
        if (!p) return Number.POSITIVE_INFINITY
        return Math.max(Math.abs(v.x + v.width / 2 - p.x), Math.abs(v.y + v.height / 2 - p.y))
      })
      .toBeLessThan(2)
    await expect(marker).toHaveCount(0)
    await expect(cursorOf(a, b)).toBeVisible()
  })

  await test.step("Shift-click follows him: alice's camera follows bob's", async () => {
    const v = await restingViewport(a.page)
    await setViewport(a.page, { x: v.x + 7000, y: v.y })
    await expect(marker).toHaveCount(1)
    await marker.click({ modifiers: ['Shift'] })
    await expect
      .poll(() =>
        a.page.evaluate(() => {
          const c = (window as unknown as FollowWindow).__lobbyBoard?.canvas
          const sid = c?.follow.current() ?? null
          return sid ? (c?.presence.peers().find((p) => p.sid === sid)?.uid ?? null) : null
        }),
      )
      .toBe(b.id)
    // following puts him on her screen
    await expect(marker).toHaveCount(0)
    await a.page.evaluate(() => (window as unknown as FollowWindow).__lobbyBoard?.canvas.follow.stop())
  })

  await test.step('"hide cursors" (a cursor filter) and focus mode hide it; it comes back with them', async () => {
    const v = await restingViewport(a.page)
    await setViewport(a.page, { x: v.x - 8000, y: v.y })
    await expect(marker).toHaveCount(1)
    const sid = await marker.getAttribute('data-sid')
    await a.page.evaluate((hidden) => {
      const w = window as unknown as FollowWindow
      w.__unhideMarker = w.__lobbyBoard?.registries.cursorVisible.provide((s) => s !== hidden)
    }, sid)
    await expect(marker).toHaveCount(0)
    await a.page.evaluate(() => (window as unknown as FollowWindow).__unhideMarker?.())
    await expect(marker).toHaveCount(1)
    const focus = (on: boolean) =>
      a.page.evaluate((flag) => {
        ;(window as unknown as FollowWindow).__lobbyBoard?.canvas.settings.set({ focusMode: flag })
      }, on)
    await focus(true)
    await expect(marker).toHaveCount(0)
    await focus(false)
    await expect(marker).toHaveCount(1)
  })

  await test.step('bob leaves: the chip goes', async () => {
    await b.context.close()
    await expect(marker).toHaveCount(0, { timeout: 20_000 })
  })
})

test('W5-32: on a phone a chip is a 44 px touch target that nothing covers, and a tap goes to the person', async ({
  browser,
  board,
  users,
  canvasSession,
}) => {
  const b = await canvasSession('bob')
  const at = await hover(b)
  const a = await openPhoneSession(browser, board, users, 'alice')
  try {
    await expect(cursorOf(a, b)).toHaveCount(1)
    const marker = markerOf(a, b)
    // bob works far to the left of the phone's view
    const v = await viewport(a.page)
    await setViewport(a.page, { x: at.x + 4000, y: at.y - v.height / 2 })
    await expect(marker).toHaveCount(1)
    const box = await marker.boundingBox()
    if (!box) throw new Error('no marker box')
    expect(box.width).toBeGreaterThanOrEqual(44)
    expect(box.height).toBeGreaterThanOrEqual(44)
    const canvas = await canvasBox(a.page)
    expect(box.x).toBeGreaterThanOrEqual(canvas.x)
    expect(box.x + box.width).toBeLessThanOrEqual(canvas.x + canvas.width)
    expect(box.y + box.height).toBeLessThanOrEqual(canvas.y + canvas.height)
    // nothing covers it: the topmost thing at its centre is the chip
    const topmost = await a.page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x as number, y as number)?.closest('[data-testid="edge-marker"]') !== null,
      [box.x + box.width / 2, box.y + box.height / 2],
    )
    expect(topmost).toBe(true)
    await marker.tap()
    await expect(marker).toHaveCount(0)
    await expect
      .poll(async () => {
        const now = await viewport(a.page)
        return at.x >= now.x && at.x <= now.x + now.width && at.y >= now.y && at.y <= now.y + now.height
      })
      .toBe(true)
  } finally {
    await a.context.close()
  }
})

/** What a phone's chip could sit on, and what could sit on it, in client px, with a hit test at each centre. */
type CoverGeometry = {
  chip: { x: number; y: number; w: number; h: number } | null
  toggle: { x: number; y: number; w: number; h: number } | null
  sheet: { x: number; y: number; w: number; h: number } | null
  bar: { x: number; y: number; w: number; h: number } | null
  /** the chip is what a tap at its centre would hit */
  chipOnTop: boolean
  /** a tap at the centre of each of the toggle's, the sheet's and the bar's buttons hits that control */
  toggleReachable: boolean
  barReachable: boolean
}

const coverGeometry = (page: Page): Promise<CoverGeometry> =>
  page.evaluate(() => {
    const rect = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null
    }
    const chipEl = document.querySelector('[data-testid="edge-marker"]')
    const toggleEl = document.querySelector('[data-testid="phone-sheet-open"]')
    const barEl = document.querySelector('[data-testid="selection-bar"]')
    const chip = rect(chipEl)
    const topAt = (r: { x: number; y: number; w: number; h: number }) =>
      document.elementFromPoint(r.x + r.w / 2, r.y + r.h / 2)
    const barButtons = barEl ? [...barEl.querySelectorAll('button')] : []
    return {
      chip,
      toggle: rect(toggleEl),
      sheet: rect(document.querySelector('[data-testid="phone-sheet"]')),
      bar: rect(barEl),
      chipOnTop: !!chip && topAt(chip)?.closest('[data-testid="edge-marker"]') === chipEl,
      toggleReachable:
        !toggleEl || topAt(rect(toggleEl) ?? { x: 0, y: 0, w: 0, h: 0 })?.closest('button') === toggleEl,
      barReachable: barButtons.every((button) => {
        const r = rect(button)
        return !r || topAt(r)?.closest('button') === button
      }),
    }
  })

const boxesOverlap = (
  a: { x: number; y: number; w: number; h: number } | null,
  b: { x: number; y: number; w: number; h: number } | null,
) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('wave B follow-up 4: on a phone a chip keeps clear of the "Board actions" button, the open sheet and the floating selection bar', async ({
  browser,
  board,
  users,
  canvasSession,
}) => {
  const b = await canvasSession('bob')
  const at = await hover(b)
  const a = await openPhoneSession(browser, board, users, 'alice')
  try {
    await expect(cursorOf(a, b)).toHaveCount(1)
    const marker = markerOf(a, b)
    const box = await canvasBox(a.page)
    // where a chip's centre can be: 10 px in from the sides, 72 px up from the bottom (the toolbar's row), and a
    // finger-sized chip's 31 px reach
    const right = box.width - 10 - 31
    const bottom = box.height - 72 - 31
    /** alice looks so that bob is on the line from the canvas's middle through `to`, three times as far out */
    const lookToward = async (to: { x: number; y: number }) => {
      const c = { x: box.width / 2, y: box.height / 2 }
      const p = { x: c.x + 3 * (to.x - c.x), y: c.y + 3 * (to.y - c.y) }
      const want = { x: at.x - p.x, y: at.y - p.y, zoom: 1 }
      await setViewport(a.page, want)
      // wave K.1 (de-race): the engine applies a camera on its next render, and right after this page opened
      // (the whole test runs within about a second of it) a read could still return the previous one; the note
      // below is placed from the camera read back, so it landed off screen, with no bar to show (1 to 5 runs in
      // 20 failed with 'selection-bar' not found). Wait until the camera is the one asked for.
      await expect
        .poll(async () => {
          const v = await viewport(a.page)
          return Math.abs(v.x - want.x) < 0.5 && Math.abs(v.y - want.y) < 0.5 && v.zoom === 1
        })
        .toBe(true)
    }
    const toggle = a.page.getByTestId('phone-sheet-open')

    await test.step('the button: bob far to the lower right, where a chip would sit on "Board actions", gets a chip beside it', async () => {
      await lookToward({ x: right, y: bottom })
      await expect(marker).toHaveCount(1)
      await expect(toggle).toBeVisible()
      await expect
        .poll(async () => {
          const g = await coverGeometry(a.page)
          return !!g.chip && !boxesOverlap(g.chip, g.toggle) && g.chipOnTop && g.toggleReachable
        })
        .toBe(true)
      const g = await coverGeometry(a.page)
      expect(g.toggle).not.toBeNull()
      // and still on the canvas
      expect(g.chip && g.chip.x >= box.x && g.chip.x + g.chip.w <= box.x + box.width).toBe(true)
      expect(g.chip && g.chip.y >= box.y && g.chip.y + g.chip.h <= box.y + box.height).toBe(true)
    })

    await test.step('the open sheet: no chip is under it, and the button is still there to close it', async () => {
      await toggle.tap()
      await expect(a.page.getByTestId('phone-sheet')).toBeVisible()
      await expect
        .poll(async () => {
          const g = await coverGeometry(a.page)
          return (
            !!g.chip &&
            !!g.sheet &&
            !boxesOverlap(g.chip, g.sheet) &&
            !boxesOverlap(g.chip, g.toggle) &&
            g.chipOnTop
          )
        })
        .toBe(true)
      // bob straight below: the chip's usual place is under the sheet too
      await lookToward({ x: box.width / 2, y: bottom })
      await expect(marker).toHaveCount(1)
      await expect
        .poll(async () => {
          const g = await coverGeometry(a.page)
          return !!g.chip && !boxesOverlap(g.chip, g.sheet) && g.chipOnTop
        })
        .toBe(true)
      await a.page.getByTestId('phone-sheet-close').tap()
      await expect(a.page.getByTestId('phone-sheet')).toHaveCount(0)
    })

    await test.step('the floating selection bar: bob level with it on the right, the chip is not on its buttons and they are all reachable', async () => {
      await lookToward({ x: right, y: box.height / 2 - 31 })
      await expect(marker).toHaveCount(1)
      const v = await viewport(a.page)
      // a note whose bar (14 px under the note, about 40 px high) lands where the chip's place on the right edge is,
      // and sits at the right edge so the bar reaches it
      const chipY = box.height / 2 - 31
      const id = await createNote(a.page, {
        x: v.x + box.width - 160,
        y: v.y + chipY - 29 - 200,
        text: 'Bar',
      })
      await select(a.page, [id])
      const bar = a.page.getByTestId('selection-bar')
      await expect(bar).toBeVisible()
      await expect
        .poll(async () => {
          const g = await coverGeometry(a.page)
          return !!g.chip && !!g.bar && !boxesOverlap(g.chip, g.bar) && g.chipOnTop && g.barReachable
        })
        .toBe(true)
      // the bar really did reach the chip's usual place: it runs to the canvas's right end, level with it
      const g = await coverGeometry(a.page)
      expect(g.bar && g.bar.x + g.bar.w > box.x + right - 31).toBe(true)
      expect(g.bar && g.bar.y <= box.y + chipY && g.bar.y + g.bar.h >= box.y + chipY).toBe(true)
      // and the chip still goes to bob
      await marker.tap()
      await expect(marker).toHaveCount(0)
    })
  } finally {
    await a.context.close()
  }
})

test('W5-32: the style panel does not hide a chip: with a tool picked, a chip for a person to the right or the upper right sits clear of it, on top and clickable', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  const at = await hover(b)
  await expect(cursorOf(a, b)).toBeVisible()
  const marker = markerOf(a, b)
  const panel = a.page.getByTestId('style.panel')

  /** Whether the chip is what a click at its centre would hit, and whether it is clear of the style panel. */
  const reachable = () =>
    a.page.evaluate(() => {
      const chip = document.querySelector('[data-testid="edge-marker"]')
      const panel = document.querySelector('[data-testid="style.panel"]')
      if (!chip) return { found: false, topmost: false, clear: false, panel: false }
      const c = chip.getBoundingClientRect()
      const hit = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2)
      const p = panel?.getBoundingClientRect()
      const overlaps = p
        ? c.left < p.right && c.right > p.left && c.top < p.bottom && c.bottom > p.top
        : false
      return {
        found: true,
        topmost: hit?.closest('[data-testid="edge-marker"]') === chip,
        clear: !overlaps,
        panel: !!p,
      }
    })

  await test.step('bob is far to her right and a tool is picked: the style panel is open and the chip is not under it', async () => {
    const v = await viewport(a.page)
    await setViewport(a.page, { x: at.x - 6000 - v.width, y: at.y - v.height / 2 })
    await expect(marker).toHaveCount(1)
    await expect(marker).toHaveAttribute('data-side', 'right')
    expect(await setTool(a.page, 'rectangle')).toBe(true)
    await expect(panel).toBeVisible()
    await expect.poll(reachable).toEqual({ found: true, topmost: true, clear: true, panel: true })
    // the label still says where he is
    await expect(marker).toHaveAttribute('aria-label', `Go to ${b.name}, off screen to the right`)
  })

  await test.step('bob is to her upper right: the chip stays clear of the panel, on top', async () => {
    const v = await viewport(a.page)
    await setViewport(a.page, { x: at.x - 6000 - v.width, y: at.y + 6000 })
    await expect(marker).toHaveCount(1)
    await expect.poll(reachable).toEqual({ found: true, topmost: true, clear: true, panel: true })
  })

  await test.step('the panel closes with the tool: the chip goes back to the middle of the edge', async () => {
    const v = await viewport(a.page)
    await setViewport(a.page, { x: at.x - 6000 - v.width, y: at.y - v.height / 2 })
    await expect(panel).toBeVisible()
    const withPanel = await marker.boundingBox()
    expect(await setTool(a.page, 'select')).toBe(true)
    await expect(panel).toHaveCount(0)
    await expect
      .poll(async () => {
        const [m, c] = await Promise.all([marker.boundingBox(), canvasBox(a.page)])
        return m ? Math.abs(m.y + m.height / 2 - (c.y + c.height / 2)) : Number.POSITIVE_INFINITY
      })
      .toBeLessThan(120)
    const [m] = await Promise.all([marker.boundingBox()])
    expect(m && withPanel && m.y < withPanel.y).toBe(true)
  })

  await test.step('with the panel open again, a click on the chip goes to bob (and draws nothing)', async () => {
    expect(await setTool(a.page, 'rectangle')).toBe(true)
    await expect(panel).toBeVisible()
    await expect.poll(reachable).toEqual({ found: true, topmost: true, clear: true, panel: true })
    const before = (await items(a.page)).length
    await expect
      .poll(async () => {
        const p = await peerPoint(a, b)
        return p ? Math.max(Math.abs(p.x - at.x), Math.abs(p.y - at.y)) : Number.POSITIVE_INFINITY
      })
      .toBeLessThan(1)
    await marker.click()
    await expect(marker).toHaveCount(0)
    await expect
      .poll(async () => {
        const now = await viewport(a.page)
        return at.x >= now.x && at.x <= now.x + now.width && at.y >= now.y && at.y <= now.y + now.height
      })
      .toBe(true)
    expect((await items(a.page)).length).toBe(before)
  })
})
