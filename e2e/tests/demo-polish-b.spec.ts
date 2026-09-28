// demo-polish-b (round-2 demo walk of the Lobby tour): the board top bar keeps the title readable
// when the workshop chips appear (F4), disabled selects in the dark theme (F8), a video dropped on a
// Mood board slot (F9), what the Export dialog opens on (F14), a phone's first view of the tour (F15),
// console errors from taps on a phone (F18), and the F17 items in these areas (leaving Present, the
// invite page's "Not you?" link, the CSV wording).
import { join } from 'node:path'
import type { Browser, BrowserContext, ConsoleMessage, Page } from '@playwright/test'
import { signInContext } from './support/api.ts'
import { read, waitForBoard, waitForValue } from './support/board.ts'
import { waitForSaved } from './support/canvas-ux.ts'
import type { BoxLike, EditorLike, VecLike } from './support/editor.ts'
import { dropFiles, fileFromPath } from './support/files.ts'
import { expect, test } from './support/fixtures.ts'
import { FIXTURES_DIR } from './support/stack.ts'

/** The tldraw 5.4.2 Editor calls these tests make beyond EditorLike. */
interface PolishEditor extends EditorLike {
  getCurrentPageId(): string
  getZoomLevel(): number
  getCamera(): { x: number; y: number; z: number }
  getViewportPageBounds(): BoxLike & { center: VecLike }
  getViewportScreenBounds(): BoxLike
  zoomToBounds(b: BoxLike, opts?: { inset?: number; immediate?: boolean; targetZoom?: number }): PolishEditor
  zoomToFit(opts?: { immediate?: boolean }): PolishEditor
  stopCameraAnimation(): PolishEditor
  getContainer(): HTMLElement
}

/**
 * tldraw reads its canvas size on a 200 ms throttle: after a side panel opens or closes, camera math
 * uses the old size for a moment. Waits until the editor's viewport matches the canvas on screen.
 */
async function viewportSettled(page: Page) {
  await expect
    .poll(() =>
      read(page, (e) => {
        const x = e as unknown as PolishEditor
        const s = x.getViewportScreenBounds()
        const r = x.getContainer().getBoundingClientRect()
        return Math.abs(s.w - r.width) < 1 && Math.abs(s.h - r.height) < 1
      }),
    )
    .toBe(true)
}

interface Opened {
  context: BrowserContext
  page: Page
}

/** A new browser context signed in as `who`, on the board (alice with ?template= inserts the tour). */
async function openBoard(
  browser: Browser,
  board: string,
  who: { handle: string; name: string },
  opts: {
    viewport?: { width: number; height: number }
    colorScheme?: 'light' | 'dark'
    phone?: boolean
    template?: boolean
  } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1440, height: 900 },
    colorScheme: opts.colorScheme ?? 'light',
    ...(opts.phone ? { isMobile: true, hasTouch: true } : {}),
  })
  await signInContext(context, who.handle, who.name)
  const page = await context.newPage()
  await page.goto(`/b/${board}${opts.template ? '?template=lobby-tour' : ''}`)
  await waitForBoard(page)
  return { context, page }
}

interface TourFrame {
  id: string
  name: string
  b: BoxLike
}

/** The tour's six frames, left to right. */
async function tourFrames(page: Page): Promise<TourFrame[]> {
  await expect
    .poll(() => read(page, (e) => e.getCurrentPageShapes().filter((s) => s.type === 'frame').length))
    .toBe(6)
  return read(page, (e) =>
    e
      .getCurrentPageShapes()
      .filter((s) => s.type === 'frame')
      .map((s) => ({ id: s.id, name: String(s.props.name), b: e.getShapePageBounds(s.id) as BoxLike }))
      .sort((p, q) => p.b.x - q.b.x),
  )
}

const ALICE = { handle: 'alice', name: 'Alice Park' }

// ---- F4: the top bar ---------------------------------------------------------------------------------

/** How much of the board title shows, against what 24 of its characters need in its own font. */
const titleRoom = (page: Page) =>
  page.evaluate(() => {
    const t = document.querySelector<HTMLElement>('[data-testid="board-title"]')
    const g = document.createElement('canvas').getContext('2d')
    if (!t || !g) return { enough: false, visible: 0, need: 0, full: false }
    const cs = getComputedStyle(t)
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    const text = t.textContent ?? ''
    const visible = t.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const full = t.scrollWidth <= t.clientWidth + 1
    const need = g.measureText(text.slice(0, 24)).width
    return { enough: full || visible >= need - 1, visible: Math.round(visible), need: Math.round(need), full }
  })

/** Anything in the bar that spills past its end (under the account badge) or makes it scroll. */
const barSpill = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('[data-testid="topbar"]')
    if (!bar) return ['no top bar']
    const account = document.querySelector('.dr-board__account')?.getBoundingClientRect()
    const limit = (account && account.width > 0 ? account.left : bar.getBoundingClientRect().right) + 0.5
    const out: string[] = []
    if (bar.scrollWidth > bar.clientWidth + 1)
      out.push(`the bar scrolls (${bar.scrollWidth} > ${bar.clientWidth})`)
    for (const el of Array.from(bar.children)) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.right > limit)
        out.push(`${el.className} ends at ${Math.round(r.right)} > ${Math.round(limit)}`)
    }
    return out
  })

/** Rendered width of a text element (0 when hidden or only kept for screen readers). */
const shownWidth = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(`[data-testid="topbar"] ${sel}`)
    return el ? el.getBoundingClientRect().width : 0
  }, selector)

test('F4 top bar: with every workshop chip up, the board title keeps about 24 characters at 1440, 1280 and 1024 px, and nothing spills out of the bar; at 390 px it keeps its phone minimum', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.api('alice')
  await alice.patchBoard(board, { title: 'Launch trailer workshop, round two' })
  const bob = await users.grant(board, 'bob')
  const carol = await users.grant(board, 'carol')
  const a = await openBoard(browser, board, ALICE, { template: true })
  const others: Opened[] = []
  const logged: string[] = []
  a.page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') logged.push(m.text())
  })
  a.page.on('pageerror', (e) => logged.push(String(e)))
  try {
    const frames = await tourFrames(a.page)

    await test.step('a quiet bar at 1440 px is not compacted: Present and Saved keep their words', async () => {
      await expect.poll(() => titleRoom(a.page)).toMatchObject({ full: true })
      expect(await shownWidth(a.page, '.dr-pe-present__label')).toBeGreaterThan(20)
      expect(await shownWidth(a.page, '.dr-save__label')).toBeGreaterThan(20)
    })

    // A live workshop: two more people, a workshop link, a running timer, a private brainstorm and a
    // raised hand.
    others.push(await openBoard(browser, board, bob), await openBoard(browser, board, carol))
    const pageId = await read(a.page, (e) =>
      (e as unknown as { getCurrentPageId(): string }).getCurrentPageId(),
    )
    const target = frames[1] as TourFrame
    const calls = [
      await alice.fetch('POST', `/api/boards/${board}/review-links`, { role: 'editor' }),
      await alice.fetch('POST', `/api/boards/${board}/timer`, { action: 'start', durationMs: 600_000 }),
      await alice.fetch('POST', `/api/boards/${board}/private-brainstorm`, {
        prompt: 'One more hook for the launch trailer?',
        anonymous: false,
        target: { frameId: target.id, pageId, x: target.b.x, y: target.b.y, w: target.b.w, h: target.b.h },
      }),
      await alice.fetch('POST', `/api/boards/${board}/hand`, { raised: true }),
    ]
    expect(calls.map((r) => r.status() < 300)).toEqual([true, true, true, true])
    await expect(a.page.getByTestId('share-badge')).toHaveAttribute('data-kind', 'link')
    await expect(a.page.getByTestId('timer-pill')).toHaveAttribute('data-state', 'running')
    await expect(a.page.getByTestId('pn-chip')).toBeAttached()
    await expect(a.page.getByTestId('hands-chip')).toBeAttached()
    await expect(a.page.getByTestId('presence-user')).toHaveCount(2)

    for (const width of [1440, 1280, 1024]) {
      await test.step(`${width} px: at least 24 characters of the title, nothing spills`, async () => {
        await a.page.setViewportSize({ width, height: 900 })
        await expect
          .poll(() => titleRoom(a.page), { message: `title at ${width} px` })
          .toMatchObject({ enough: true })
        expect(await barSpill(a.page)).toEqual([])
        // The chips are still there: in the bar, or (when even the compact bar is too full) in "⋯".
        for (const id of ['timer-pill', 'pn-chip', 'hands-chip', 'share-badge', 'present-button']) {
          await expect(a.page.getByTestId(id)).toHaveCount(1)
        }
      })
    }

    await test.step('tablet and back (the layout switches): still fitted, no React or observer errors', async () => {
      await a.page.setViewportSize({ width: 700, height: 900 })
      await expect(a.page.getByTestId('topbar')).toHaveAttribute('data-width', 'tablet')
      await a.page.setViewportSize({ width: 1024, height: 900 })
      await expect(a.page.getByTestId('topbar')).toHaveAttribute('data-width', 'wide')
      await expect.poll(() => titleRoom(a.page)).toMatchObject({ enough: true })
      expect(await barSpill(a.page)).toEqual([])
    })

    await test.step('back to 1440 px: the bar holds the chips again', async () => {
      await a.page.setViewportSize({ width: 1440, height: 900 })
      await expect.poll(() => titleRoom(a.page)).toMatchObject({ enough: true })
      await expect(a.page.getByTestId('topbar').getByTestId('pn-chip')).toBeVisible()
      await expect(a.page.getByTestId('topbar').getByTestId('timer-pill')).toBeVisible()
    })

    await test.step('390 px: the title keeps its phone minimum (96 px box) and the bar does not overflow', async () => {
      await a.page.setViewportSize({ width: 390, height: 844 })
      await expect.poll(() => titleRoom(a.page).then((r) => r.visible)).toBeGreaterThanOrEqual(80)
      expect(await barSpill(a.page)).toEqual([])
    })
    expect(logged.filter((t) => /flushSync|ResizeObserver|Maximum update depth/i.test(t))).toEqual([])
  } finally {
    await Promise.all([a, ...others].map((o) => o.context.close()))
  }
})

// ---- F8: disabled selects in the dark theme -------------------------------------------------------------

test('F8 a disabled select shows one chevron, not a tiled row, in dark and light (non-owner Share dialog)', async ({
  browser,
  board,
  users,
}) => {
  const bob = await users.grant(board, 'bob')
  for (const scheme of ['dark', 'light'] as const) {
    const b = await openBoard(browser, board, bob, { colorScheme: scheme })
    try {
      await b.page.getByTestId('share-button').click()
      const select = b.page.getByTestId('share-dialog').locator('select:disabled').first()
      await expect(select).toBeVisible()
      const bg = await select.evaluate((el) => {
        const cs = getComputedStyle(el)
        return {
          theme: document.documentElement.dataset.theme,
          image: cs.backgroundImage.startsWith('url('),
          repeat: cs.backgroundRepeat,
          size: cs.backgroundSize,
        }
      })
      expect(bg).toMatchObject({ theme: scheme, image: true, repeat: 'no-repeat' })
      expect(bg.size).toMatch(/^16px( auto)?$/) // one 16 px chevron, not tiles at the SVG's own size
    } finally {
      await b.context.close()
    }
  }
})

// ---- F9: a video on a Mood board slot ------------------------------------------------------------------

test('F9 a video dropped on a Mood board slot lands in that slot (fitted, just above it, in the frame) and the camera does not move', async ({
  browser,
  board,
}) => {
  const a = await openBoard(browser, board, ALICE, { template: true })
  try {
    const mood = (await tourFrames(a.page))[3] as TourFrame
    expect(mood.name).toBe('4 · Mood board')
    const slot = await read(
      a.page,
      (e, frameId) => {
        const x = e as unknown as PolishEditor
        x.selectNone()
        x.zoomToBounds(x.getShapePageBounds(frameId) as BoxLike, {
          inset: 48,
          immediate: true,
          targetZoom: 1,
        })
        const slots = x
          .getSortedChildIdsForParent(frameId)
          .map((id) => x.getShape(id))
          .filter((s) => s?.meta.draftroomSlot === 'image')
        const s = slots[1]
        const b = s ? x.getShapePageBounds(s.id) : undefined
        if (!s || !b) return null
        const c = x.pageToScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
        return { id: s.id, b: { x: b.x, y: b.y, w: b.w, h: b.h }, at: { x: c.x, y: c.y } }
      },
      mood.id,
    )
    if (!slot) throw new Error('no second image slot in the Mood board')
    const before = await read(a.page, (e) => (e as unknown as PolishEditor).getCamera())

    await dropFiles(
      a.page,
      [{ ...fileFromPath(join(FIXTURES_DIR, 'video.mp4')), name: 'teaser.mp4' }],
      slot.at,
    )
    const card = await waitForValue(
      () =>
        read(a.page, (e) => {
          const c = e.getCurrentPageShapes().find((s) => s.type === 'dr-file-card')
          const b = c ? e.getShapePageBounds(c.id) : undefined
          return c && b
            ? {
                id: c.id,
                parentId: c.parentId,
                b: { x: b.x, y: b.y, w: b.w, h: b.h },
                w: Number(c.props.w),
                h: Number(c.props.h),
              }
            : null
        }),
      { timeout: 30_000, message: 'the video card appears' },
    )
    expect(card.parentId).toBe(mood.id)
    // Inside the slot, fitted (it touches two opposite sides), the card's own shape kept.
    const tol = 0.5
    expect(card.b.x).toBeGreaterThanOrEqual(slot.b.x - tol)
    expect(card.b.y).toBeGreaterThanOrEqual(slot.b.y - tol)
    expect(card.b.x + card.b.w).toBeLessThanOrEqual(slot.b.x + slot.b.w + tol)
    expect(card.b.y + card.b.h).toBeLessThanOrEqual(slot.b.y + slot.b.h + tol)
    expect(Math.max(card.b.w / slot.b.w, card.b.h / slot.b.h)).toBeCloseTo(1, 2)
    expect(card.w / card.h).toBeCloseTo(360 / 276, 2)
    const order = await read(a.page, (e, id) => e.getSortedChildIdsForParent(id), mood.id)
    expect(order.indexOf(card.id)).toBe(order.indexOf(slot.id) + 1)
    await a.page.waitForTimeout(600) // an animated zoom-out would have started by now
    const after = await read(a.page, (e) => (e as unknown as PolishEditor).getCamera())
    expect({ x: after.x, y: after.y, z: after.z }).toEqual({ x: before.x, y: before.y, z: before.z })
  } finally {
    await a.context.close()
  }
})

// ---- F14: the Export dialog's first choice ---------------------------------------------------------------

test('F14 Export opens on what you are looking at (the frame in view, else the selection or the board) at 1×, with no size warning', async ({
  browser,
  board,
}) => {
  const a = await openBoard(browser, board, ALICE, { template: true })
  try {
    const frames = await tourFrames(a.page)
    const brainstorm = frames[1] as TourFrame
    const dialog = a.page.getByTestId('export-dialog')
    const open = async () => {
      await a.page.getByTestId('export-button').click()
      await expect(dialog).toBeVisible()
    }
    const close = async () => {
      await a.page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
    }

    await test.step('zoomed to a frame: that frame, 1×, no warning', async () => {
      await read(
        a.page,
        (e, id) => {
          const x = e as unknown as PolishEditor
          x.selectNone()
          x.zoomToBounds(x.getShapePageBounds(id) as BoxLike, { inset: 48, immediate: true, targetZoom: 1 })
          return null
        },
        brainstorm.id,
      )
      await open()
      await expect(dialog.getByTestId('export-area-frame')).toBeChecked()
      await expect(dialog.getByTestId('export-frame')).toHaveValue(brainstorm.id)
      await expect(dialog.getByTestId('export-scale')).toHaveValue('1')
      await expect(dialog.getByTestId('export-size-warning')).toHaveCount(0)
      // F17: the CSV columns are "color", and so is the text that describes them.
      await expect(dialog.getByText(/colour/)).toHaveCount(0)
      await expect(dialog.getByText(/type, frame, color and position/)).toBeVisible()
      await close()
    })

    await test.step('with a selection: the selection', async () => {
      await read(
        a.page,
        (e, id) => {
          const note = e.getSortedChildIdsForParent(id).find((c) => e.getShape(c)?.type === 'note')
          if (note) e.select(note)
          return note ?? null
        },
        brainstorm.id,
      )
      await open()
      await expect(dialog.getByTestId('export-area-selection')).toBeChecked()
      await expect(dialog.getByTestId('export-scale')).toHaveValue('1')
      await close()
    })

    await test.step('the whole tour in view: the whole board at 1×, no warning', async () => {
      await read(a.page, (e) => {
        const x = e as unknown as PolishEditor
        x.selectNone()
        x.zoomToFit({ immediate: true })
        return null
      })
      await open()
      await expect(dialog.getByTestId('export-area-board')).toBeChecked()
      await expect(dialog.getByTestId('export-scale')).toHaveValue('1')
      await expect(dialog.getByTestId('export-size-warning')).toHaveCount(0)
    })

    await test.step('a size the person picks is remembered, but never opens the dialog on a warning', async () => {
      await dialog.getByTestId('export-scale').selectOption('4')
      await expect(dialog.getByTestId('export-size-warning')).toBeVisible() // their own choice: say so
      await close()
      await open() // still the whole board: 4× (and 2×) would be too large, so 1×
      await expect(dialog.getByTestId('export-scale')).toHaveValue('1')
      await expect(dialog.getByTestId('export-size-warning')).toHaveCount(0)
      await close()
      await read(
        a.page,
        (e, id) => {
          ;(e as unknown as PolishEditor).zoomToBounds(e.getShapePageBounds(id) as BoxLike, {
            inset: 48,
            immediate: true,
            targetZoom: 1,
          })
          return null
        },
        brainstorm.id,
      )
      await open() // one frame at 4× fits: the remembered 4×
      await expect(dialog.getByTestId('export-area-frame')).toBeChecked()
      await expect(dialog.getByTestId('export-scale')).toHaveValue('4')
      await expect(dialog.getByTestId('export-size-warning')).toHaveCount(0)
      await close()
    })
  } finally {
    await a.context.close()
  }
})

// ---- F15 + F18: a phone ------------------------------------------------------------------------------------

test('F15 F18 phone: a first visit at 390 px shows the tour’s first frame across the screen (not a 5 % strip), and taps log no console errors', async ({
  browser,
  board,
  users,
}) => {
  const a = await openBoard(browser, board, ALICE, { template: true })
  await tourFrames(a.page)
  // Alone on the board, tldraw sends at most once a second: the tour must reach the server first.
  await waitForSaved(a.page)
  await a.context.close()
  const dave = await users.grant(board, 'dave')
  for (const scheme of ['light', 'dark'] as const) {
    const g = await openBoard(browser, board, dave, {
      viewport: { width: 390, height: 844 },
      colorScheme: scheme,
      phone: true,
    })
    const errors: string[] = []
    const onConsole = (m: ConsoleMessage) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text())
    }
    g.page.on('console', onConsole)
    try {
      const first = (await tourFrames(g.page))[0] as TourFrame
      expect(first.name).toBe('1 · Welcome')
      await test.step(`${scheme}: the first frame, fitted to the screen width`, async () => {
        await expect(g.page.getByTestId('canvas-ux-overlay')).toHaveAttribute(
          'data-start-view',
          'first-frame',
        )
        await g.page.waitForTimeout(400) // the dock rail settles
        const view = await read(g.page, (e) => {
          const x = e as unknown as PolishEditor
          const vp = x.getViewportPageBounds()
          return {
            z: x.getZoomLevel(),
            vp: { x: vp.x, y: vp.y, w: vp.w, h: vp.h },
            screen: x.getViewportScreenBounds(),
          }
        })
        const f = first.b
        expect(f.x).toBeGreaterThanOrEqual(view.vp.x)
        expect(f.y).toBeGreaterThanOrEqual(view.vp.y)
        expect(f.x + f.w).toBeLessThanOrEqual(view.vp.x + view.vp.w)
        expect(f.y + f.h).toBeLessThanOrEqual(view.vp.y + view.vp.h)
        expect((f.w * view.z) / view.screen.w).toBeGreaterThan(0.85)
      })

      await test.step(`${scheme}: taps on the canvas work and log nothing`, async () => {
        const note = await read(
          g.page,
          (e, frameId) => {
            const id = e.getSortedChildIdsForParent(frameId).find((c) => e.getShape(c)?.type === 'note')
            const b = id ? e.getShapePageBounds(id) : undefined
            return id && b ? { id, at: e.pageToScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 }) } : null
          },
          first.id,
        )
        if (!note) throw new Error('no note in the first frame')
        await g.page.touchscreen.tap(note.at.x, note.at.y)
        await expect.poll(() => read(g.page, (e) => e.getSelectedShapeIds())).toEqual([note.id])
        await g.page.touchscreen.tap(200, 700)
        await g.page.touchscreen.tap(120, 200)
        await g.page.waitForTimeout(300)
        expect(errors.filter((t) => /preventDefault/.test(t))).toEqual([])
      })
    } finally {
      g.page.off('console', onConsole)
      await g.context.close()
    }
  }
})

// ---- F17: leaving Present, the invite page link ------------------------------------------------------------

test('F17 leaving Present puts the board back where it was, even when the canvas changed size meanwhile (a side panel closed)', async ({
  browser,
  board,
}) => {
  const a = await openBoard(browser, board, ALICE, { template: true })
  try {
    const brainstorm = (await tourFrames(a.page))[1] as TourFrame
    const view = () =>
      read(a.page, (e) => {
        const x = e as unknown as PolishEditor
        const c = x.getViewportPageBounds().center
        return { x: Math.round(c.x), y: Math.round(c.y), z: x.getZoomLevel() }
      })
    // The walk had a side panel open when Present started, and closed after it.
    await a.page.getByTestId('dock-tab-frames').click()
    await expect(a.page.getByTestId('dock-panel-frames')).toBeVisible()
    await viewportSettled(a.page)
    await read(
      a.page,
      (e, id) => {
        const x = e as unknown as PolishEditor
        x.selectNone()
        x.zoomToBounds(x.getShapePageBounds(id) as BoxLike, { inset: 48, immediate: true, targetZoom: 1 })
        return null
      },
      brainstorm.id,
    )
    const before = await view()
    await a.page.getByTestId('present-button').click()
    await expect(a.page.getByTestId('present-overlay')).toBeVisible()
    // The dock is hidden while presenting; its tab still closes the panel.
    await a.page.evaluate(() =>
      document.querySelector<HTMLElement>('[data-testid="dock-tab-frames"]')?.click(),
    )
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('present-overlay')).toHaveCount(0)
    await expect(a.page.getByTestId('dock-panel-frames')).toHaveCount(0)
    await viewportSettled(a.page) // the board's canvas is back (without the panel)
    await a.page.waitForTimeout(300) // and the restore that follows tldraw's resize has run
    const after = await view()
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
    expect(after.z).toBeCloseTo(before.z, 6)
  } finally {
    await a.context.close()
  }
})

test('F17 invite page: "Not you?" uses the app’s link style, not the browser’s default blue, in both themes', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.api('alice')
  const res = await alice.fetch('POST', `/api/boards/${board}/review-links`, { role: 'commenter' })
  expect(res.status()).toBe(201)
  const token = String(((await res.json()) as { url: string }).url.split('/').pop())
  for (const scheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 800 } })
    try {
      await signInContext(context, 'erin', 'Erin Walsh')
      const page = await context.newPage()
      await page.goto(`/invite/${encodeURIComponent(token)}`)
      const link = page.locator('.dr-invite-card__as a')
      await expect(link).toHaveText('Not you?')
      const colors = await link.evaluate((el) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(--dr-accent-ink)'
        document.body.append(probe)
        const want = getComputedStyle(probe).color
        probe.remove()
        return { got: getComputedStyle(el).color, want }
      })
      expect(colors.got).toBe(colors.want)
    } finally {
      await context.close()
    }
  }
})
