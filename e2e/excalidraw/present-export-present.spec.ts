// present-export on the Excalidraw board page (wave 3e; the port of ../tests/present-export.spec.ts
// "present mode" and "integration": PRS-01): slides from frames, keys, skipped frames, hidden chrome,
// cursors and comment pins, Esc restores the board, live edits by a collaborator, and the event stream
// surviving an api restart (comments reach both pages). Every write goes through the page's
// canvas (the facade or the canvas transact), collaborators are second browser contexts, and server
// state is checked through the sync server's test snapshot.
//
// Differences from the tldraw spec, each from the new page (docs/research/excalidraw/wave3/3E.md):
//  - the fullscreen element is the board's canvas region (`[data-lobby-board-canvas]`), not `.tl-container`;
//  - "tools, menus, frame titles hidden" is the board page's focus mode (top bar, dock and host slots
//    are not rendered); the engine's frame outline and names are off while presenting (W5-24), so a slide is
//    its frame's exact rectangle;
//  - the selection bar is 3a's (in a host slot, hidden with every slot but the live region); the Tab
//    order has present-live's "Present to everyone" (3c);
//  - comment pins are the ported comments' (3c); a thread's anchor is the element's api ref (`shape:<id>`).
import type { Browser, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  canvasCall,
  clickItem,
  collaborators,
  createNote,
  editingId,
  expect,
  expectSaved,
  item,
  itemBounds,
  items,
  select,
  selection,
  test,
  tool,
  viewport,
  waitForCanvas,
  zoomToFit,
} from '../tests/support/canvas.ts'
import { serverSnapshot } from '../tests/support/excalidraw.ts'
import {
  commentPin,
  focusedTestId,
  nextFrames,
  postThread,
  trackRequests,
  visibleCount,
} from '../tests/support/present-export.ts'
import type { TestUser } from '../tests/support/users.ts'
import { focusBoard } from './board-kit.ts'
import {
  canUndo,
  type DeckSpec,
  expectItems,
  expectSlideOnScreen,
  focusMode,
  NOTE_FILL,
  pngPixels,
  presentUi,
  roundView,
  seedDeck,
  setPresent,
} from './present-kit.ts'

const F = { intro: 'pe-intro', backstage: 'pe-backstage', plan: 'pe-plan' }
const N = { intro: 'pe-note-intro', plan: 'pe-note-plan' }

/**
 * Three frames left to right; the middle one is marked "skip in presentation", so the deck is Intro (1)
 * and Plan (2). Notes are 200×200.
 */
const DECK: DeckSpec = {
  frames: [
    { id: F.intro, name: 'Intro', x: 0, y: 0, w: 800, h: 600 },
    { id: F.backstage, name: 'Backstage', x: 1000, y: 0, w: 720, h: 540, skip: true },
    { id: F.plan, name: 'Plan', x: 2000, y: 0, w: 640, h: 480 },
  ],
  notes: [
    { id: N.intro, frame: F.intro, x: 300, y: 200, text: 'Kickoff agenda' },
    { id: N.plan, frame: F.plan, x: 220, y: 140, text: 'Launch checklist', color: NOTE_FILL.blue },
  ],
}

const html = (page: Page) => page.locator('html')

/** The board page in a context of its own, with `beforeGoto` run before the first request. */
async function openTracked(
  browser: Browser,
  board: string,
  user: TestUser,
  beforeGoto: (page: Page) => void,
): Promise<{ page: Page; close(): Promise<void> }> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signInContext(context, user.handle, user.name)
  beforeGoto(page)
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  return { page, close: () => context.close() }
}

/** The host slots of the board's chrome: every slot but the live region, which stays in focus mode. */
const CHROME_SLOTS = '[data-lobby-slot]:not([data-lobby-slot="liveRegion"])'

test.describe('present mode', () => {
  test('present: frames become slides without the skipped one, keys stop at both ends, and Esc restores the board and its view', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await seedDeck(a.page, DECK)
    await zoomToFit(a.page)
    await nextFrames(a.page)
    const before = await viewport(a.page)
    const ui = presentUi(a.page)

    await ui.button.click()
    await expect(ui.overlay).toBeVisible()
    await expect(ui.counter).toHaveText('1 / 2')
    await expect(ui.title).toHaveText('Intro')
    await expectSlideOnScreen(a.page, F.intro)
    await expect(html(a.page)).toHaveAttribute('data-dr-presenting', 'true')
    // Full screen through the Fullscreen API (the board's canvas region, which holds the overlays).
    await expect(ui.overlay).toHaveAttribute('data-mode', 'native')
    expect(
      await a.page.evaluate(
        () => document.fullscreenElement?.hasAttribute('data-lobby-board-canvas') ?? false,
      ),
    ).toBe(true)
    // The board's chrome is gone: focus mode drops the top bar, the dock and the host slots.
    expect(await focusMode(a.page)).toBe(true)
    await expect(a.page.locator('.dr-topbar')).toBeHidden()
    await expect(a.page.locator('.dr-dock')).toHaveCount(0)
    // every host slot goes but the live region (2C keeps it in focus mode: announcements go on)
    await expect(a.page.locator(CHROME_SLOTS)).toHaveCount(0)

    await a.page.keyboard.press('ArrowRight')
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Plan') // Backstage (skipped) is never shown
    await expectSlideOnScreen(a.page, F.plan)

    // The last slide is the end: every "next" key stays there.
    for (const key of ['ArrowRight', 'Space', 'PageDown']) await a.page.keyboard.press(key)
    await nextFrames(a.page)
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Plan')

    await a.page.keyboard.press('PageUp')
    await expect(ui.counter).toHaveText('1 / 2')
    await expectSlideOnScreen(a.page, F.intro)
    await a.page.keyboard.press('ArrowLeft')
    await nextFrames(a.page)
    await expect(ui.counter).toHaveText('1 / 2')

    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    await expect(html(a.page)).not.toHaveAttribute('data-dr-presenting')
    await expect(a.page.locator('.dr-topbar')).toBeVisible()
    expect(await focusMode(a.page)).toBe(false)
    await expect.poll(async () => roundView(await viewport(a.page))).toEqual(roundView(before))
    // ...and it stays there once the delayed re-apply (after leaving fullscreen) has run.
    await nextFrames(a.page)
    await nextFrames(a.page)
    expect(roundView(await viewport(a.page))).toEqual(roundView(before))
    expect(await a.page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  })

  test('W5-24: a slide is its frame’s exact rectangle: no engine outline or name while presenting (the edge pixels show the slide, not a cover), and the board’s frame chrome comes back after', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await seedDeck(a.page, DECK)
    await zoomToFit(a.page)
    const frameRendering = () =>
      a.page.evaluate(
        () =>
          (
            window as unknown as {
              __lobbyBoard: {
                api: {
                  getAppState(): { frameRendering: Record<'enabled' | 'clip' | 'name' | 'outline', boolean> }
                }
              }
            }
          ).__lobbyBoard.api.getAppState().frameRendering,
      )
    const board = { enabled: true, clip: true, name: true, outline: true }
    expect(await frameRendering()).toEqual(board)
    const ui = presentUi(a.page)
    await ui.button.click()
    await expect(ui.counter).toHaveText('1 / 2')
    await expectSlideOnScreen(a.page, F.intro)
    await nextFrames(a.page)
    // the engine draws no outline and no frame name while presenting (the slide stays clipped to its frame)
    expect(await frameRendering()).toEqual({ enabled: true, clip: true, name: false, outline: false })

    // The frame's edges on screen (the slide fills the height, so its sides are inside the window).
    const f = await itemBounds(a.page, F.intro)
    if (!f) throw new Error('no frame')
    const tl = await canvasCall(a.page, 'sceneToScreen', { x: f.x, y: f.y })
    const br = await canvasCall(a.page, 'sceneToScreen', { x: f.x + f.width, y: f.y + f.height })
    const left = Math.floor(tl.x)
    const top = Math.floor(tl.y)
    const right = Math.ceil(br.x) - 1 // the last pixel column / row the frame reaches into
    const bottom = Math.ceil(br.y) - 1
    // a column left of the control bar (its shadow darkens the bottom edge under it)
    const sideX = left + Math.round((right - left) * 0.15)
    const midY = Math.round((tl.y + br.y) / 2)
    const inside: { x: number; y: number }[] = []
    const outside: { x: number; y: number }[] = []
    // pixels 1 to 4 in from each edge (the edge pixel itself may be anti-aliased) are the slide's own:
    // before, the surround's 2 px cover and its rounded corners ate them
    for (let d = 1; d <= 4; d++) {
      inside.push(
        { x: left + d, y: midY },
        { x: right - d, y: midY },
        { x: sideX, y: top + d },
        { x: sideX, y: bottom - d },
      )
      // the four corners, where the engine rounded its outline (8 px) and the cover its window (6 px)
      inside.push(
        { x: left + d, y: top + d },
        { x: right - d, y: top + d },
        { x: left + d, y: bottom - d },
        { x: right - d, y: bottom - d },
      )
    }
    // and just outside the frame the surround, left and right (the rows above and below the slide are the screen's edge)
    for (const d of [2, 3, 4]) outside.push({ x: left - d, y: midY }, { x: right + d, y: midY })
    const shot = await a.page.screenshot()
    const px = await pngPixels(a.page, shot, [...inside, ...outside])
    const lum = ([r, g, b]: number[]) => 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)
    const inPx = px.slice(0, inside.length)
    const outPx = px.slice(inside.length)
    const notSlide = inPx.map((p, i) => ({ at: inside[i], p })).filter(({ p }) => lum(p) < 240)
    expect(
      notSlide,
      `pixels inside the slide that are not the slide's white: ${JSON.stringify(notSlide)}`,
    ).toEqual([])
    const notSurround = outPx.map((p, i) => ({ at: outside[i], p })).filter(({ p }) => lum(p) > 60)
    expect(
      notSurround,
      `pixels outside the slide that are not the surround: ${JSON.stringify(notSurround)}`,
    ).toEqual([])

    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    // the board's frame outline and names are back
    await expect.poll(frameRendering).toEqual(board)
  })

  test('W5-47: leaving the presentation gives the keyboard back to the Present button it was opened from, and the presentation shows a focus ring', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await seedDeck(a.page, DECK)
    await zoomToFit(a.page)
    const ui = presentUi(a.page)
    const ring = () =>
      ui.overlay.evaluate((el) => {
        const s = getComputedStyle(el)
        return {
          focused: document.activeElement === el,
          style: s.outlineStyle,
          width: Number.parseFloat(s.outlineWidth),
        }
      })

    // Keyboard: focus the Present button, Enter; the presentation takes the focus and shows it.
    await ui.button.focus()
    await a.page.keyboard.press('Enter')
    await expect(ui.overlay).toBeVisible()
    await expect.poll(ring).toEqual({ focused: true, style: 'solid', width: 2 })
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    // The top bar (and its Present button) is rendered again after focus mode: the focus lands on it,
    // not on the canvas, and stays there.
    await expect(ui.button).toBeFocused()
    await nextFrames(a.page)
    await nextFrames(a.page)
    await expect(ui.button).toBeFocused()

    // With the mouse: click Present, then Exit; the focus goes back to Present too.
    await ui.button.click()
    await expect(ui.overlay).toBeVisible()
    await ui.exit.click()
    await expect(ui.overlay).toHaveCount(0)
    await expect(ui.button).toBeFocused()
    await nextFrames(a.page)
    await expect(ui.button).toBeFocused()
  })

  test("present: a collaborator's cursor disappears from the presenter's slides and comes back after present-exit", async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    const b = await canvasSession('bob')
    await seedDeck(a.page, DECK)
    await expectItems(b.page, [F.intro, F.plan, N.intro, N.plan])
    await zoomToFit(a.page)
    await zoomToFit(b.page)
    const cursors = a.page.locator('[data-testid="cursor"]')
    const ui = presentUi(a.page)

    // B points inside Intro, above its note: on the slide A is about to show.
    const moveB = async (sceneX: number) => {
      const p = await canvasCall(b.page, 'sceneToScreen', { x: sceneX, y: 120 })
      await b.page.mouse.move(p.x, p.y, { steps: 4 })
    }
    const bCursor = async () => {
      const peers = await a.page.evaluate(() =>
        (
          window as unknown as {
            __lobbyBoard?: {
              canvas: { presence: { peers(): { name: string; point: { x: number } | null }[] } }
            }
          }
        ).__lobbyBoard?.canvas.presence.peers(),
      )
      return peers?.find((p) => p.name === b.name)?.point?.x ?? null
    }

    await moveB(400)
    await expect(cursors).toHaveCount(1)

    await ui.button.click()
    await expect(ui.counter).toHaveText('1 / 2')
    await expectSlideOnScreen(a.page, F.intro)
    await expect(cursors).toHaveCount(0)
    // B keeps moving inside the slide: A receives the presence, the cursor still does not render.
    await moveB(520)
    await expect.poll(async () => Math.abs(((await bCursor()) ?? 0) - 520)).toBeLessThan(3)
    await expect(cursors).toHaveCount(0)

    await ui.exit.click()
    await expect(ui.overlay).toHaveCount(0)
    await expect(cursors).toHaveCount(1)
    expect((await collaborators(a.page)).length).toBeGreaterThan(0)
  })

  test("present: Ctrl+Alt+Enter starts at the selected note's frame, the slide list jumps, and leaving with the keyboard keeps the selection without editing", async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    await seedDeck(a.page, DECK)
    await zoomToFit(a.page)
    const ui = presentUi(a.page)
    const selectionState = async () => ({
      selected: await selection(a.page),
      editing: await editingId(a.page),
    })

    // A user clicks the note in "Plan", slide 2 of the deck.
    await clickItem(a.page, N.plan)
    await expect.poll(selectionState).toEqual({ selected: [N.plan], editing: null })

    await a.page.keyboard.press('Control+Alt+Enter')
    await expect(ui.overlay).toBeVisible()
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Plan')
    await expectSlideOnScreen(a.page, F.plan)

    // G opens the slide list on the current slide; picking another jumps there and closes it.
    await a.page.keyboard.press('g')
    await expect(ui.grid).toBeVisible()
    const options = ui.grid.locator('[data-slide-option]')
    await expect(options).toHaveCount(2)
    await expect(ui.grid.locator(`[data-slide-option="${F.plan}"]`)).toHaveAttribute('aria-current', 'true')
    await expect(ui.grid.locator(`[data-slide-option="${F.plan}"]`)).toBeFocused()
    await ui.grid.locator(`[data-slide-option="${F.intro}"]`).click()
    await expect(ui.grid).toHaveCount(0)
    await expect(ui.counter).toHaveText('1 / 2')
    await expectSlideOnScreen(a.page, F.intro)

    // Leave with the keyboard: Tab to "Exit", Enter. The Enter must not reach the board on its way up,
    // where it would start editing the note whose selection was just restored.
    for (let i = 0; i < 6 && (await focusedTestId(a.page)) !== 'present-exit'; i++) {
      await a.page.keyboard.press('Tab')
    }
    await expect(ui.exit).toBeFocused()
    await a.page.keyboard.press('Enter')
    await expect(ui.overlay).toHaveCount(0)
    await nextFrames(a.page)
    expect(await selectionState()).toEqual({ selected: [N.plan], editing: null })

    // A selected frame starts there too; a selected SKIPPED frame starts at the next slide.
    await select(a.page, [F.plan])
    await ui.button.click()
    await expect(ui.counter).toHaveText('2 / 2')
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    await select(a.page, [F.backstage])
    await ui.button.click()
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Plan')
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    expect(await selectionState()).toEqual({ selected: [F.backstage], editing: null })
  })

  test('present: board keys do nothing while presenting (n, Delete, Ctrl+Z, PageUp) and Tab cycles only through the presentation controls', async ({
    canvasSession,
    stack,
    board,
  }) => {
    const a = await canvasSession('alice')
    const b = await canvasSession('bob')
    await seedDeck(a.page, DECK)
    // An undoable edit right before presenting: a leaked Ctrl+Z would remove this note, a leaked Delete
    // or PageUp (bring to front) would act on it once it is selected.
    const EXTRA = await createNote(a.page, { x: 900, y: 800, color: NOTE_FILL.green })
    await expectSaved(a.page)
    await expectItems(b.page, [EXTRA])
    const facts = async (page: Page) => {
      const list = await items(page)
      return { count: list.length, order: list.map((e) => e.id) }
    }
    const before = await facts(a.page)
    expect(await tool(a.page)).toBe('select')
    const ui = presentUi(a.page)

    await ui.button.click()
    await expect(ui.counter).toHaveText('1 / 2')
    // Give Delete and PageUp a target, as a selection left over on the board would.
    await select(a.page, [EXTRA])
    await a.page.keyboard.press('n')
    await a.page.keyboard.press('Delete')
    await a.page.keyboard.press('Control+z')
    await a.page.keyboard.press('ArrowRight')
    await expect(ui.counter).toHaveText('2 / 2')
    await a.page.keyboard.press('PageUp') // "previous slide" here, not "bring to front"
    await expect(ui.counter).toHaveText('1 / 2')
    await nextFrames(a.page)
    expect(await tool(a.page)).toBe('select')
    expect(await facts(a.page)).toEqual(before)
    expect(await item(a.page, EXTRA)).not.toBeNull()

    // Tab stays inside the presentation controls, in order, and wraps; Shift+Tab goes back. "Present to
    // everyone" is present-live's (3c), in the chrome since the wave-3 integration, as on the tldraw page.
    const seen: (string | null)[] = []
    for (let i = 0; i < 6; i++) {
      await a.page.keyboard.press('Tab')
      seen.push(await focusedTestId(a.page))
    }
    expect(seen).toEqual([
      'present-prev',
      'present-next',
      'present-grid-toggle',
      'present-invite', // present-live (3c): alice may present to everyone
      'present-exit',
      'present-prev',
    ])
    await a.page.keyboard.press('Shift+Tab')
    expect(await focusedTestId(a.page)).toBe('present-exit')

    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    // The note's creation is still on the undo stack (the Ctrl+Z above never ran).
    expect(await canUndo(a.page)).toBe(true)
    // Nothing reached the room either: after a later edit of A's has arrived at B (ordered delivery),
    // B still holds the note and the same stacking order, and so does the server.
    await canvasCall(a.page, 'update', N.intro, { backgroundColor: NOTE_FILL.green })
    await expect.poll(async () => (await item(b.page, N.intro))?.backgroundColor).toBe(NOTE_FILL.green)
    expect(await facts(b.page)).toEqual(before)
    await expectSaved(a.page)
    const stored = await serverSnapshot(stack, board)
    const live = stored.elements.filter((e) => !e.isDeleted)
    expect(live.some((e) => e.id === EXTRA)).toBe(true)
    expect(live.length).toBe(before.count)
  })

  test('present: when a collaborator skips the slide being shown the counter adapts, and un-skipping keeps the presenter where they are', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    const b = await canvasSession('bob')
    await seedDeck(a.page, DECK)
    await expectItems(b.page, [F.intro, F.plan])
    const ui = presentUi(a.page)

    await ui.button.click()
    await a.page.keyboard.press('ArrowRight')
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Plan')

    await setPresent(b.page, F.plan, { skip: true }) // B, in the Frames panel's terms: "skip in presentation"
    await expect(ui.counter).toHaveText('1 / 1')
    await expect(ui.title).toHaveText('Intro')
    await expectSlideOnScreen(a.page, F.intro)

    await setPresent(b.page, F.plan, null)
    await expect(ui.counter).toHaveText('1 / 2')
    await nextFrames(a.page)
    await expect(ui.title).toHaveText('Intro') // not pulled back to Plan
    await expectSlideOnScreen(a.page, F.intro)
    await a.page.keyboard.press('ArrowRight')
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Plan')
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
  })

  test("present: slides follow the Frames panel's order, not the layout, and a collaborator's reorder keeps the presenter on the same frame", async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    const b = await canvasSession('bob')
    // Plan is placed right of Intro but ordered first (customData.lobby.present.index, what dragging rows writes).
    await seedDeck(a.page, {
      frames: [
        { id: F.intro, name: 'Intro', x: 0, y: 0, w: 800, h: 600, index: 1 },
        { id: F.plan, name: 'Plan', x: 2000, y: 0, w: 640, h: 480, index: 0 },
      ],
    })
    await expectItems(b.page, [F.intro, F.plan])
    const ui = presentUi(a.page)

    await ui.button.click()
    await expect(ui.counter).toHaveText('1 / 2')
    await expect(ui.title).toHaveText('Plan')
    await expectSlideOnScreen(a.page, F.plan)
    await a.page.keyboard.press('ArrowRight')
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Intro')

    // B moves Plan to the end while A shows Intro: A stays on Intro, which is now slide 1.
    await setPresent(b.page, F.plan, { index: 5 })
    await expect(ui.counter).toHaveText('1 / 2')
    await expect(ui.title).toHaveText('Intro')
    await expectSlideOnScreen(a.page, F.intro)
    await a.page.keyboard.press('ArrowRight')
    await expect(ui.title).toHaveText('Plan')
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
  })

  test('present: an empty board explains itself instead of opening, and a refused fullscreen presents inside the window', async ({
    canvasSession,
  }) => {
    const a = await canvasSession('alice')
    const ui = presentUi(a.page)
    const toast = a.page.getByTestId('present-empty-toast')

    await ui.button.click()
    await expect(toast).toContainText('Nothing to present yet')
    await expect(ui.overlay).toHaveCount(0)
    await expect(html(a.page)).not.toHaveAttribute('data-dr-presenting')

    await seedDeck(a.page, {
      frames: [{ id: F.intro, name: 'Intro', x: 0, y: 0, w: 800, h: 600, skip: true }],
    })
    await ui.button.click()
    await expect(toast).toContainText('Every frame is set to "skip in presentation"')
    await expect(ui.overlay).toHaveCount(0)

    // The browser refuses fullscreen (permissions policy, no user activation...). The page reloads with
    // that in place (the frame is stored: Saved).
    await a.context.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('Permissions check failed'))
    })
    await a.page.reload()
    await waitForCanvas(a.page)
    await expectItems(a.page, [F.intro])
    await setPresent(a.page, F.intro, null)
    await expectSaved(a.page)
    await ui.button.click()
    await expect(ui.overlay).toHaveAttribute('data-mode', 'window')
    await expect(ui.counter).toHaveText('1 / 1')
    // The board covers the whole window instead.
    const size = a.page.viewportSize()
    await expect
      .poll(() => a.page.locator('.dr-board__editor').boundingBox())
      .toEqual({ x: 0, y: 0, width: size?.width, height: size?.height })
    await expectSlideOnScreen(a.page, F.intro)
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
  })
})

test.describe('integration', () => {
  test('presentation is clean: comment pins, the selection bar, the top bar and the host slots are hidden while presenting and come back after Esc; a viewer presents with the shortcuts', async ({
    canvasSession,
    users,
    board,
  }) => {
    const a = await canvasSession('alice')
    await seedDeck(a.page, DECK)
    await zoomToFit(a.page)
    // An open (unresolved) thread in the corner of the note on slide 2, and that note selected (with the
    // selection bar): the presentation then starts on slide 2, right where the pin is.
    const thread = await postThread(
      await users.api('alice'),
      board,
      `shape:${N.plan}`,
      'Is this the right order?',
      {
        u: 0.85,
        v: 0.15,
      },
    )
    const pin = commentPin(a.page, thread)
    await expect(pin).toBeVisible()
    await focusBoard(a.page)
    await clickItem(a.page, N.plan)
    const selbar = a.page.getByTestId('selection-bar')
    await expect.poll(() => visibleCount(selbar)).toBeGreaterThan(0)
    const ui = presentUi(a.page)

    await ui.button.click()
    await expect(ui.counter).toHaveText('2 / 2')
    await expectSlideOnScreen(a.page, F.plan) // the pinned note is on this slide
    await expect.poll(() => visibleCount(a.page.locator('[data-testid="comment-pin"]'))).toBe(0)
    await expect.poll(() => visibleCount(selbar)).toBe(0)
    await expect(a.page.locator('.dr-topbar')).toBeHidden()
    await expect.poll(() => visibleCount(a.page.locator(CHROME_SLOTS))).toBe(0)
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    await expect(pin).toBeVisible()
    await expect.poll(() => visibleCount(selbar)).toBeGreaterThan(0)
    await expect(a.page.locator('.dr-topbar')).toBeVisible()

    // A viewer (read-only canvas) presents too: the shortcuts work on a read-only canvas.
    const v = await canvasSession('carol', { role: 'viewer' })
    await expectItems(v.page, [F.intro, F.plan, N.intro, N.plan])
    expect(await canvasCall(v.page, 'readOnly')).toBe(true)
    const vu = presentUi(v.page)
    await focusBoard(v.page)
    await v.page.keyboard.press('Control+Alt+Enter')
    await expect(vu.counter).toHaveText('1 / 2')
    await v.page.keyboard.press('ArrowRight')
    await expect(vu.counter).toHaveText('2 / 2')
    await v.page.keyboard.press('Escape')
    await expect(vu.overlay).toHaveCount(0)
    await vu.button.click()
    await expect(vu.counter).toHaveText('1 / 2')
    await vu.exit.click()
    await expect(vu.overlay).toHaveCount(0)
  })

  test('event stream survives an API restart: after a SIGKILL of the api, comments reach both pages without a reload and each page keeps exactly one stream', async ({
    browser,
    board,
    users,
    stack,
  }) => {
    test.setTimeout(180_000)
    // Regression (the validation phase, tldraw page): an api that died mid-stream left the page's
    // EventSource attached to a dead response. The same-origin proxy aborts such responses and the
    // client's watchdog (features/events.ts) expects the api's data pings; the Excalidraw page shares both,
    // and its comment pins are the ported comments' (3c).
    const NOTE = 'pe-events-note'
    const eventsPath = `/api/boards/${board}/events`
    const alice = await users.get('alice')
    const bob = await users.grant(board, 'bob', 'editor')
    const streams: Record<string, ReturnType<typeof trackRequests>> = {}
    const open = (who: TestUser) =>
      openTracked(browser, board, who, (page) => {
        streams[who.handle] = trackRequests(page, (u) => u.pathname === eventsPath)
      })
    const a = await open(alice)
    const b = await open(bob)
    try {
      const pending = () => [streams.alice?.pending(), streams.bob?.pending()]
      await expect.poll(pending).toEqual([1, 1])
      await seedDeck(a.page, { notes: [{ id: NOTE, x: 200, y: 200, text: 'Comment on me' }] })
      await expectItems(b.page, [NOTE])
      await zoomToFit(a.page)
      await zoomToFit(b.page)
      // Marks the documents: still there at the end = no reload happened.
      for (const s of [a, b]) await s.page.evaluate(() => Object.assign(window, { __peNoReload: true }))
      const bobApi = await users.api('bob')
      const aliceApi = await users.api('alice')
      const ref = `shape:${NOTE}`

      const t0 = await postThread(bobApi, board, ref, 'Before the restart')
      await expect(commentPin(a.page, t0)).toBeVisible()

      await stack.api.restart() // SIGKILL (TerminateProcess on Windows), then a fresh process
      // Posted as soon as the api is back: A shows it from the resumed stream or from the refetch that
      // follows every reconnect, whichever comes first.
      const t1 = await postThread(bobApi, board, ref, 'Right after the restart')

      // Each page notices the dead stream and opens a new one (a 1 s..30 s backoff).
      await expect
        .poll(() => [streams.alice?.total() ?? 0, streams.bob?.total() ?? 0].every((n) => n > 1), {
          timeout: 30_000,
          message: 'each page opened a new /events stream after the api restart',
        })
        .toBe(true)
      await expect(commentPin(a.page, t1)).toBeVisible({ timeout: 30_000 })
      await expect(commentPin(b.page, t1)).toBeVisible({ timeout: 30_000 })
      // ...and holds exactly one open stream again.
      await expect.poll(pending, { timeout: 30_000 }).toEqual([1, 1])

      // Live, event-driven, both directions.
      const t2 = await postThread(bobApi, board, ref, 'Live after the reconnect, from Bob')
      await expect(commentPin(a.page, t2)).toBeVisible()
      const t3 = await postThread(aliceApi, board, ref, 'Live after the reconnect, from Alice')
      await expect(commentPin(b.page, t3)).toBeVisible()
      expect(pending()).toEqual([1, 1])
      for (const s of [a, b])
        expect(
          await s.page.evaluate(() => (window as unknown as { __peNoReload?: boolean }).__peNoReload),
        ).toBe(true)
    } finally {
      await Promise.all([a.close(), b.close()])
    }
  })
})
