// present-export (docs/E2E-PLAN.md [present-export] + the two [integration] scenarios that ride on it):
// present mode (PRS-01: slides from frames, keys, skipped frames, hidden chrome/cursors/pins, Esc restores
// the board, live edits by a collaborator) and exports (PRS-05 PNG/SVG + copy as PNG, PRS-06 PDF, CSV).
//
// Exports are checked as FILES: the PNG signature, IHDR size, pHYs and a real pixel; the SVG root element
// and the image embedded in it; the PDF's pages, page sizes, bookmarks and page images (pdf-lib) and its
// text layer (pdf.js); the CSV's bytes. Where a request matters (originals, never the canvas previews)
// the network log is asserted. Collaborative behaviour uses two browser contexts, and server state is
// checked from another client or the API.

import type { Page } from '@playwright/test'
import { edit, getShape, read, waitForBoard, waitForValue } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'
import {
  type BoardSpec,
  camera,
  collectDownloads,
  commentPin,
  DERIVATIVE_PATH,
  downloadFrom,
  expectShapes,
  expectSlideOnScreen,
  expectStored,
  focusedTestId,
  isFileRequest,
  nextFrames,
  ORIGINAL_PATH,
  openInstrumented,
  type PresentEditor,
  parseCsv,
  pdfPageTexts,
  placeUploadedImage,
  postThread,
  presentUi,
  readClipboard,
  readPdf,
  readPng,
  roundCamera,
  screenPoint,
  seedBoard,
  shapeCentre,
  storedShapes,
  svgEmbeddedImages,
  svgRootName,
  trackRequests,
  visibleCount,
  watchTestId,
  writeClipboardText,
} from './support/present-export.ts'
import type { Users } from './support/users.ts'

const F = { intro: 'shape:pe-intro', backstage: 'shape:pe-backstage', plan: 'shape:pe-plan' }
const N = { intro: 'shape:pe-note-intro', plan: 'shape:pe-note-plan' }

/**
 * Three frames left to right; the middle one is marked "skip in presentation", so the deck is
 * Intro (1) and Plan (2). Notes are 200×200 (tldraw's note size).
 */
const DECK: BoardSpec = {
  frames: [
    { id: F.intro, name: 'Intro', x: 0, y: 0, w: 800, h: 600 },
    { id: F.backstage, name: 'Backstage', x: 1000, y: 0, w: 720, h: 540, skip: true },
    { id: F.plan, name: 'Plan', x: 2000, y: 0, w: 640, h: 480 },
  ],
  notes: [
    { id: N.intro, parentId: F.intro, x: 300, y: 200, text: 'Kickoff agenda' },
    { id: N.plan, parentId: F.plan, x: 220, y: 140, text: 'Launch checklist', color: 'blue' },
  ],
}

const boardTitle = async (users: Users, board: string) =>
  (await (await users.api('alice')).getBoard(board)).board.title

const html = (page: Page) => page.locator('html')

/** pHYs value for an N× PNG: N × 72 dpi in pixels per metre. */
const ppm = (scale: number) => Math.round((scale * 72) / 0.0254)

// ---- present mode ------------------------------------------------------------------------------------

test.describe('present mode', () => {
  test('present: frames become slides without the skipped one, keys stop at both ends, and Esc restores the board and its camera', async ({
    session,
  }) => {
    const a = await session('alice')
    await seedBoard(a.page, DECK)
    await edit(a.page, (ed) => ed.zoomToFit())
    const before = await camera(a.page)
    const ui = presentUi(a.page)

    await ui.button.click()
    await expect(ui.overlay).toBeVisible()
    await expect(ui.counter).toHaveText('1 / 2')
    await expect(ui.title).toHaveText('Intro')
    await expectSlideOnScreen(a.page, F.intro)
    await expect(html(a.page)).toHaveAttribute('data-dr-presenting', 'true')
    // Full screen through the Fullscreen API (the board's editor container).
    await expect(ui.overlay).toHaveAttribute('data-mode', 'native')
    expect(
      await a.page.evaluate(() => document.fullscreenElement?.classList.contains('tl-container') ?? false),
    ).toBe(true)
    // Tools, menus, frame titles and the board's own top bar are gone.
    await expect(a.page.locator('.dr-topbar')).toBeHidden()
    await expect(a.page.locator('.tlui-layout')).toBeHidden()
    await expect.poll(() => visibleCount(a.page.locator('.tl-frame-heading'))).toBe(0)

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
    await expect(a.page.locator('.tlui-layout')).toBeVisible()
    await expect.poll(async () => roundCamera(await camera(a.page))).toEqual(roundCamera(before))
    // ...and it stays there once the delayed re-apply (after leaving fullscreen) has run.
    await nextFrames(a.page)
    await nextFrames(a.page)
    expect(roundCamera(await camera(a.page))).toEqual(roundCamera(before))
    expect(await a.page.evaluate(() => document.fullscreenElement === null)).toBe(true)
  })

  test("present: a collaborator's cursor disappears from the presenter's slides and comes back after present-exit", async ({
    session,
  }) => {
    const a = await session('alice')
    const b = await session('bob')
    await seedBoard(a.page, DECK)
    await expectShapes(b.page, [F.intro, F.plan, N.intro, N.plan])
    await edit(a.page, (ed) => ed.zoomToFit())
    await edit(b.page, (ed) => ed.zoomToFit())
    const cursors = a.page.locator('.tl-collaborator__cursor')
    const ui = presentUi(a.page)

    // B points inside Intro, above its note: on the slide A is about to show.
    const moveB = async (pageX: number) => {
      const p = await screenPoint(b.page, { x: pageX, y: 120 })
      await b.page.mouse.move(p.x, p.y, { steps: 4 })
    }
    const bCursorX = () =>
      read(
        a.page,
        (ed, name) => ed.getCollaborators().find((c) => c.userName === name)?.cursor?.x ?? null,
        b.name,
      )

    await moveB(400)
    await expect(cursors).toHaveCount(1)

    await ui.button.click()
    await expect(ui.counter).toHaveText('1 / 2')
    await expectSlideOnScreen(a.page, F.intro)
    await expect(cursors).toHaveCount(0)
    // B keeps moving inside the slide: A receives the presence, the cursor still does not render.
    await moveB(520)
    await expect.poll(async () => Math.abs(((await bCursorX()) ?? 0) - 520)).toBeLessThan(3)
    await expect(cursors).toHaveCount(0)

    await ui.exit.click()
    await expect(ui.overlay).toHaveCount(0)
    await expect(cursors).toHaveCount(1)
  })

  test("present: Ctrl+Alt+Enter starts at the selected note's frame, the slide list jumps, and leaving with the keyboard keeps the selection without editing", async ({
    session,
  }) => {
    const a = await session('alice')
    await seedBoard(a.page, DECK)
    await edit(a.page, (ed) => ed.zoomToFit())
    const ui = presentUi(a.page)
    const selectionState = () =>
      read(a.page, (ed) => ({ selected: ed.getSelectedShapeIds(), editing: ed.getEditingShapeId() }))

    // A user clicks the note in "Plan", slide 2 of the deck.
    const c = await shapeCentre(a.page, N.plan)
    await a.page.mouse.click(c.x, c.y)
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
    await edit(a.page, (ed, id) => ed.select(id), F.plan)
    await ui.button.click()
    await expect(ui.counter).toHaveText('2 / 2')
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    await edit(a.page, (ed, id) => ed.select(id), F.backstage)
    await ui.button.click()
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Plan')
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    expect(await selectionState()).toEqual({ selected: [F.backstage], editing: null })
  })

  test('present: board keys do nothing while presenting (n, Delete, Ctrl+Z, PageUp) and Tab cycles only through the presentation controls', async ({
    session,
    users,
    board,
  }) => {
    const a = await session('alice')
    const b = await session('bob')
    const EXTRA = 'shape:pe-extra'
    await seedBoard(a.page, DECK)
    // An undoable edit right before presenting: a leaked Ctrl+Z would remove this note, a leaked Delete
    // or PageUp (bring to front) would act on it once it is selected.
    await edit(
      a.page,
      (ed, id) => {
        ed.markHistoryStoppingPoint('pe-extra')
        ed.createShape({ id, type: 'note', x: 900, y: 800, props: { color: 'green' } })
      },
      EXTRA,
    )
    await expectShapes(b.page, [EXTRA])
    const facts = (page: Page) =>
      read(page, (ed) => {
        const pageId = (ed as unknown as PresentEditor).getCurrentPageId()
        return {
          count: ed.getCurrentPageShapes().length,
          order: ed.getSortedChildIdsForParent(pageId),
        }
      })
    const before = await facts(a.page)
    expect(await read(a.page, (ed) => ed.getCurrentToolId())).toBe('select')
    const ui = presentUi(a.page)

    await ui.button.click()
    await expect(ui.counter).toHaveText('1 / 2')
    // Give Delete and PageUp a target, as a selection left over on the board would.
    await edit(a.page, (ed, id) => ed.select(id), EXTRA)
    await a.page.keyboard.press('n')
    await a.page.keyboard.press('Delete')
    await a.page.keyboard.press('Control+z')
    await a.page.keyboard.press('ArrowRight')
    await expect(ui.counter).toHaveText('2 / 2')
    await a.page.keyboard.press('PageUp') // "previous slide" here, not "bring to front"
    await expect(ui.counter).toHaveText('1 / 2')
    await nextFrames(a.page)
    expect(await read(a.page, (ed) => ed.getCurrentToolId())).toBe('select')
    expect(await facts(a.page)).toEqual(before)
    expect(await getShape(a.page, EXTRA)).not.toBeNull()

    // Tab stays inside the presentation controls, in order, and wraps; Shift+Tab goes back.
    const seen: (string | null)[] = []
    for (let i = 0; i < 6; i++) {
      await a.page.keyboard.press('Tab')
      seen.push(await focusedTestId(a.page))
    }
    expect(seen).toEqual([
      'present-prev',
      'present-next',
      'present-grid-toggle',
      'present-invite', // wave 4 (present-live): alice may present to everyone
      'present-exit',
      'present-prev',
    ])
    await a.page.keyboard.press('Shift+Tab')
    expect(await focusedTestId(a.page)).toBe('present-exit')

    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    // The note's creation is still on the undo stack (the Ctrl+Z above never ran).
    expect(await read(a.page, (ed) => (ed as unknown as PresentEditor).getCanUndo())).toBe(true)
    // Nothing reached the room either: after a later edit of A's has arrived at B (ordered delivery),
    // B still holds the note and the same stacking order, and so does the server.
    await edit(a.page, (ed, id) => ed.updateShape({ id, type: 'note', props: { color: 'violet' } }), N.intro)
    await expect.poll(async () => (await getShape(b.page, N.intro))?.props.color).toBe('violet')
    expect(await facts(b.page)).toEqual(before)
    const stored = await storedShapes(await users.api('alice'), board)
    expect(stored.has(EXTRA)).toBe(true)
    expect(stored.size).toBe(before.count)
  })

  test('present: when a collaborator skips the slide being shown the counter adapts, and un-skipping keeps the presenter where they are', async ({
    session,
  }) => {
    const a = await session('alice')
    const b = await session('bob')
    await seedBoard(a.page, DECK)
    await expectShapes(b.page, [F.intro, F.plan])
    const ui = presentUi(a.page)
    const setSkip = (skip: boolean) =>
      edit(
        b.page,
        (ed, arg) => ed.updateShape({ id: arg.id, type: 'frame', meta: { presentationSkip: arg.skip } }),
        { id: F.plan, skip },
      )

    await ui.button.click()
    await a.page.keyboard.press('ArrowRight')
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Plan')

    await setSkip(true) // B, in the Frames panel's terms: "skip in presentation" on Plan
    await expect(ui.counter).toHaveText('1 / 1')
    await expect(ui.title).toHaveText('Intro')
    await expectSlideOnScreen(a.page, F.intro)

    await setSkip(false)
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
    session,
  }) => {
    const a = await session('alice')
    const b = await session('bob')
    // Plan is placed right of Intro but ordered first (meta.presentationIndex, what dragging rows writes).
    await seedBoard(a.page, {
      frames: [
        { id: F.intro, name: 'Intro', x: 0, y: 0, w: 800, h: 600, index: 1 },
        { id: F.plan, name: 'Plan', x: 2000, y: 0, w: 640, h: 480, index: 0 },
      ],
    })
    await expectShapes(b.page, [F.intro, F.plan])
    const ui = presentUi(a.page)

    await ui.button.click()
    await expect(ui.counter).toHaveText('1 / 2')
    await expect(ui.title).toHaveText('Plan')
    await expectSlideOnScreen(a.page, F.plan)
    await a.page.keyboard.press('ArrowRight')
    await expect(ui.counter).toHaveText('2 / 2')
    await expect(ui.title).toHaveText('Intro')

    // B moves Plan to the end while A shows Intro: A stays on Intro, which is now slide 1.
    await edit(
      b.page,
      (ed, id) => ed.updateShape({ id, type: 'frame', meta: { presentationIndex: 5 } }),
      F.plan,
    )
    await expect(ui.counter).toHaveText('1 / 2')
    await expect(ui.title).toHaveText('Intro')
    await expectSlideOnScreen(a.page, F.intro)
    await a.page.keyboard.press('ArrowRight')
    await expect(ui.title).toHaveText('Plan')
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
  })

  test('present: an empty board explains itself instead of opening, and a refused fullscreen presents inside the window', async ({
    session,
    users,
    board,
  }) => {
    const a = await session('alice')
    const ui = presentUi(a.page)
    const toast = a.page.getByTestId('present-empty-toast')

    await ui.button.click()
    await expect(toast).toContainText('Nothing to present yet')
    await expect(ui.overlay).toHaveCount(0)
    await expect(html(a.page)).not.toHaveAttribute('data-dr-presenting')

    await seedBoard(a.page, {
      frames: [{ id: F.intro, name: 'Intro', x: 0, y: 0, w: 800, h: 600, skip: true }],
    })
    await ui.button.click()
    await expect(toast).toContainText('Every frame is set to "skip in presentation"')
    await expect(ui.overlay).toHaveCount(0)

    // The browser refuses fullscreen (permissions policy, no user activation...). The page reloads with
    // that in place, once the server stores the frame.
    await expectStored(await users.api('alice'), board, [F.intro])
    await a.context.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('Permissions check failed'))
    })
    await a.page.reload()
    await waitForBoard(a.page)
    await expectShapes(a.page, [F.intro])
    await edit(
      a.page,
      (ed, id) => ed.updateShape({ id, type: 'frame', meta: { presentationSkip: false } }),
      F.intro,
    )
    await ui.button.click()
    await expect(ui.overlay).toHaveAttribute('data-mode', 'window')
    await expect(ui.counter).toHaveText('1 / 1')
    // The board covers the whole window instead.
    const viewport = a.page.viewportSize()
    await expect
      .poll(() => a.page.locator('.dr-board__editor').boundingBox())
      .toEqual({ x: 0, y: 0, width: viewport?.width, height: viewport?.height })
    await expectSlideOnScreen(a.page, F.intro)
    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
  })
})

// ---- image exports -------------------------------------------------------------------------------------

test.describe('image exports', () => {
  test('PNG and SVG export: a frame at 2× drawn from the original upload, a transparent selection, the whole board, and an SVG embedding the original', async ({
    session,
    users,
    board,
  }) => {
    const a = await session('alice')
    const title = await boardTitle(users, board)
    await seedBoard(a.page, DECK)
    await placeUploadedImage(a.page, F.intro, { x: 40, y: 330, w: 400, h: 225 })
    const files = trackRequests(a.page, isFileRequest)
    const dialog = a.page.getByTestId('export-dialog')

    await a.page.getByTestId('export-button').click()
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('export-frame').selectOption(F.intro)
    await expect(dialog.getByTestId('export-area-frame')).toBeChecked()
    await dialog.getByTestId('export-scale').selectOption('2')
    await expect(dialog.getByTestId('export-size-hint')).toHaveText('PNG ≈ 1,600 × 1,200 px')

    await test.step('frame PNG at 2×: exact size, opaque, marked 2×, from the original upload', async () => {
      const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(png.name).toBe(`${title} - Intro.png`)
      const info = readPng(png.bytes)
      expect({ w: info.width, h: info.height }).toEqual({ w: 1600, h: 1200 })
      expect(info.topLeft?.[3]).toBe(255)
      // One pHYs chunk (the PNG spec allows at most one) saying 2× of 72 dpi.
      expect(info.pixelsPerMetre).toEqual([ppm(2)])
      await expect(dialog.getByTestId('export-status')).toHaveText(`Downloaded “${title} - Intro.png”.`)
      // The export fetched the uploaded original, never a canvas preview.
      expect(files.paths()).toContainEqual(expect.stringMatching(ORIGINAL_PATH))
      expect(files.paths().filter((p) => !ORIGINAL_PATH.test(p))).toEqual([])
    })

    await test.step('frame SVG: an <svg> document with the original 1920×1080 PNG embedded', async () => {
      const svg = await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())
      expect(svg.name).toBe(`${title} - Intro.svg`)
      const text = svg.bytes.toString('utf8')
      expect(svgRootName(text)).toBe('svg')
      const embedded = svgEmbeddedImages(text)
      const png = embedded.find((e) => e.mime === 'image/png')
      expect(png, `embedded images: ${embedded.map((e) => e.mime).join(', ')}`).toBeDefined()
      const info = readPng(png?.bytes ?? Buffer.alloc(0))
      expect({ w: info.width, h: info.height }).toEqual({ w: 1920, h: 1080 })
      expect(embedded.some((e) => e.mime === 'image/webp')).toBe(false) // not the preview derivative
      expect(files.paths().filter((p) => DERIVATIVE_PATH.test(p))).toEqual([])
    })

    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await test.step('selection PNG: transparent where nothing is drawn, opaque without the option', async () => {
      // Two notes on a diagonal: the selection's top-left corner is empty board.
      await edit(a.page, (ed, ids) => ed.select(...ids), [N.intro, N.plan])
      const sel = await read(a.page, (ed) => (ed as unknown as PresentEditor).getSelectionPageBounds())
      await a.page.getByTestId('export-button').click()
      await expect(dialog.getByTestId('export-area-selection')).toBeChecked()
      await expect(dialog.getByTestId('export-scale')).toHaveValue('2') // remembered
      await dialog.getByTestId('export-transparent').check()
      const clear = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(clear.name).toBe(`${title} - selection.png`)
      const info = readPng(clear.bytes)
      expect(info.colorType).toBe(6) // RGBA
      expect(info.topLeft?.[3]).toBe(0)
      // 2× the selection: tldraw renders it with 32 px of padding and trims that back to what is drawn
      // (the notes' shadows reach a few px beyond their bounds).
      const selW = sel?.w ?? 0
      const selH = sel?.h ?? 0
      expect(info.width).toBeGreaterThanOrEqual(Math.floor(selW * 2))
      expect(info.width).toBeLessThanOrEqual(Math.ceil((selW + 64) * 2))
      expect(info.height).toBeGreaterThanOrEqual(Math.floor(selH * 2))
      expect(info.height).toBeLessThanOrEqual(Math.ceil((selH + 64) * 2))

      await dialog.getByTestId('export-transparent').uncheck()
      const opaque = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(readPng(opaque.bytes).topLeft?.[3]).toBe(255)
    })

    await test.step('whole board PNG at 1× and 4× sizes', async () => {
      const pageBounds = await read(a.page, (ed) => (ed as unknown as PresentEditor).getCurrentPageBounds())
      await dialog.getByTestId('export-area-board').check()
      await dialog.getByTestId('export-scale').selectOption('1')
      const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(png.name).toBe(`${title}.png`)
      const info = readPng(png.bytes)
      // The page's content plus at most tldraw's 32 px export padding on each side (frame titles sit in it).
      expect(info.width).toBeGreaterThanOrEqual(Math.floor(pageBounds?.w ?? 0))
      expect(info.width).toBeLessThanOrEqual(Math.ceil((pageBounds?.w ?? 0) + 64))
      expect(info.height).toBeGreaterThanOrEqual(Math.floor(pageBounds?.h ?? 0))
      expect(info.height).toBeLessThanOrEqual(Math.ceil((pageBounds?.h ?? 0) + 64))
      expect(info.pixelsPerMetre).toEqual([ppm(1)])

      // 4× of one frame: exact, marked 4×.
      await dialog.getByTestId('export-frame').selectOption(F.plan)
      await dialog.getByTestId('export-scale').selectOption('4')
      const big = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
      expect(big.name).toBe(`${title} - Plan.png`)
      const bigInfo = readPng(big.bytes)
      expect({ w: bigInfo.width, h: bigInfo.height }).toEqual({ w: 2560, h: 1920 })
      expect(bigInfo.pixelsPerMetre).toEqual([ppm(4)])
    })
    expect(files.paths().filter((p) => DERIVATIVE_PATH.test(p))).toEqual([])
  })

  test("context menu: tldraw's own Export as PNG and SVG go through the same pipeline (board-titled files, 2×, from the original upload)", async ({
    session,
    users,
    board,
  }) => {
    const a = await session('alice')
    const title = await boardTitle(users, board)
    await seedBoard(a.page, DECK)
    const imageId = await placeUploadedImage(a.page, F.intro, { x: 40, y: 330, w: 400, h: 225 })
    const files = trackRequests(a.page, isFileRequest)

    // Right-click the image (selects it and opens the context menu), then Export as → PNG.
    const c = await shapeCentre(a.page, imageId)
    const openExportAs = async () => {
      await a.page.mouse.click(c.x, c.y, { button: 'right' })
      await a.page.getByTestId('context-menu-sub.export-as-button').click()
    }
    await openExportAs()
    const png = await downloadFrom(a.page, () => a.page.getByTestId('context-menu.export-as-png').click())
    expect(png.name).toBe(`${title} - selection.png`)
    const info = readPng(png.bytes)
    // An image is its own export bounds (no padding): exactly 2× its 400×225 board size.
    expect({ w: info.width, h: info.height }).toEqual({ w: 800, h: 450 })
    expect(info.pixelsPerMetre).toEqual([ppm(2)])
    expect(files.paths()).toContainEqual(expect.stringMatching(ORIGINAL_PATH))
    expect(files.paths().filter((p) => !ORIGINAL_PATH.test(p))).toEqual([])

    await openExportAs()
    const svg = await downloadFrom(a.page, () => a.page.getByTestId('context-menu.export-as-svg').click())
    expect(svg.name).toBe(`${title} - selection.svg`)
    const text = svg.bytes.toString('utf8')
    expect(svgRootName(text)).toBe('svg')
    const embedded = svgEmbeddedImages(text).find((e) => e.mime === 'image/png')
    const original = readPng(embedded?.bytes ?? Buffer.alloc(0))
    expect({ w: original.width, h: original.height }).toEqual({ w: 1920, h: 1080 })
    expect(files.paths().filter((p) => DERIVATIVE_PATH.test(p))).toEqual([])
  })

  test('copy as PNG: Ctrl+Shift+C and the dialog button put an image/png of the selection on the clipboard', async ({
    session,
  }) => {
    const a = await session('alice')
    await a.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL })
    await seedBoard(a.page, DECK)
    await edit(a.page, (ed) => ed.zoomToFit())
    const clipboardPng = async () => {
      const clip = await waitForValue(async () => {
        const c = await readClipboard(a.page)
        return c.pngBase64 ? c : null
      })
      expect(clip.types).toContain('image/png')
      return readPng(Buffer.from(clip.pngBase64 ?? '', 'base64'))
    }

    // The user clicks a note and presses Ctrl+Shift+C.
    const c = await shapeCentre(a.page, N.plan)
    await a.page.mouse.click(c.x, c.y)
    await expect.poll(() => read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([N.plan])
    await writeClipboardText(a.page, 'not an image yet')
    await a.page.keyboard.press('Control+Shift+C')
    await expect(a.page.getByTestId('copy-png-toast')).toBeVisible()
    const note = await clipboardPng()
    // The note at 2× (200×200 board px), not the whole board.
    expect(note.width).toBeGreaterThanOrEqual(396)
    expect(note.width).toBeLessThanOrEqual(2 * (200 + 64))
    expect(note.height).toBeGreaterThanOrEqual(396)
    expect(note.height).toBeLessThanOrEqual(2 * (200 + 64))

    // The dialog's button, with a frame chosen.
    await writeClipboardText(a.page, 'not an image yet')
    await a.page.getByTestId('export-button').click()
    const dialog = a.page.getByTestId('export-dialog')
    await dialog.getByTestId('export-frame').selectOption(F.intro)
    await dialog.getByTestId('export-copy-png').click()
    await expect(dialog.getByTestId('export-status')).toHaveText('Copied as PNG. Paste it into any app.')
    const frame = await clipboardPng()
    expect({ w: frame.width, h: frame.height }).toEqual({ w: 1600, h: 1200 })
  })
})

// ---- PDF ---------------------------------------------------------------------------------------------

test.describe('PDF export', () => {
  /** Presentation order set explicitly (Plan first), unlike the frames' left-to-right layout. */
  const PDF_DECK: BoardSpec = {
    frames: [
      { id: F.intro, name: 'Intro', x: 0, y: 0, w: 800, h: 600, index: 1 },
      { id: F.backstage, name: 'Backstage', x: 1000, y: 0, w: 720, h: 540, skip: true },
      { id: F.plan, name: 'Plan', x: 2000, y: 0, w: 640, h: 480, index: 0 },
    ],
    notes: DECK.notes,
  }
  const ORIGINAL_ROUTE = /\/files\/ast_[0-9A-Za-z]+\/ver_[0-9A-Za-z]+\/original/

  test('PDF export: one frame-sized page per slide in presentation order, bookmarks and searchable text; skipped frames on request, selected frames alone, and cancel', async ({
    session,
    users,
    board,
  }) => {
    const a = await session('alice')
    const title = await boardTitle(users, board)
    await seedBoard(a.page, PDF_DECK)
    await placeUploadedImage(a.page, F.intro, { x: 40, y: 330, w: 400, h: 225 })
    const files = trackRequests(a.page, isFileRequest)
    const downloads = collectDownloads(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    const summary = dialog.getByTestId('export-pdf-summary')

    await a.page.getByTestId('export-button').click()
    await expect(summary).toHaveText('One page per frame, in presentation order (2 pages).')

    await test.step('cancel while a page is rendering: no file, "Export cancelled."', async () => {
      // Hold the original upload's download: the export then waits inside page 2 (Intro has the image).
      let release: () => void = () => {}
      const released = new Promise<void>((r) => {
        release = r
      })
      let requested: () => void = () => {}
      const wasRequested = new Promise<void>((r) => {
        requested = r
      })
      await a.page.route(ORIGINAL_ROUTE, async (route) => {
        requested()
        await released
        await route.continue()
      })
      await dialog.getByTestId('export-pdf').click()
      await wasRequested
      const progress = dialog.getByTestId('export-progress')
      await expect(progress).toHaveAttribute('max', '2')
      await expect(progress).toHaveAttribute('value', '1')
      await expect(dialog).toContainText('Rendering page 2 of 2…')
      await expect(dialog.getByTestId('export-pdf')).toBeDisabled()
      await dialog.getByTestId('export-cancel').click()
      release()
      await expect(dialog.getByTestId('export-status')).toHaveText('Export cancelled.')
      await expect(dialog.getByTestId('export-cancel')).toHaveCount(0)
      await expect(progress).toHaveCount(0)
      await expect(dialog.getByTestId('export-pdf')).toBeEnabled()
      expect(downloads).toEqual([])
      await a.page.unroute(ORIGINAL_ROUTE)
    })

    // Each page: the frame at 0.75 pt/px under a header band with its title (RETRO-05a): 28 pt tall on
    // pages this narrow (pdf-layout headerBandHeight).
    const BAND = 28
    await test.step('the deck: 2 pages in presentation order, frame × 0.75 pt + title band, bookmarks, text layer', async () => {
      const progress = await watchTestId(a.page, 'export-progress')
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      expect(pdf.name).toBe(`${title}.pdf`)
      expect((await progress()).length).toBeGreaterThan(0) // the progress bar showed during the export
      await expect(dialog.getByTestId('export-status')).toHaveText(`Downloaded “${title}.pdf” (2 pages).`)
      const info = await readPdf(pdf.bytes)
      expect(info.title).toBe(title)
      expect(info.pages.map((p) => [p.width, p.height])).toEqual([
        [480, 360 + BAND], // Plan 640×480
        [600, 450 + BAND], // Intro 800×600
      ])
      expect(info.outline).toEqual([
        { title: 'Plan', page: 0 },
        { title: 'Intro', page: 1 },
      ])
      // Each page is one image of its frame drawn at 3× (PRS-06 raster pages, see the dialog's note).
      expect(info.pages.map((p) => p.images)).toEqual([
        [{ width: 1920, height: 1440 }],
        [{ width: 2400, height: 1800 }],
      ])
      const texts = await pdfPageTexts(pdf.bytes)
      expect(texts).toHaveLength(2)
      expect(texts[0]).toContain('Launch checklist')
      expect(texts[0]).not.toContain('Kickoff agenda')
      expect(texts[1]).toContain('Kickoff agenda')
      // Each page starts with its frame's title (the header band).
      expect(texts[0]?.startsWith('Plan')).toBe(true)
      expect(texts[1]?.startsWith('Intro')).toBe(true)
      // The image on page 2 came from the original upload, never from a canvas preview.
      expect(files.paths()).toContainEqual(expect.stringMatching(ORIGINAL_PATH))
      expect(files.paths().filter((p) => DERIVATIVE_PATH.test(p))).toEqual([])
    })

    await test.step('with the skipped frame included: 3 pages, the skipped one last', async () => {
      await dialog.getByTestId('export-pdf-include-skipped').check()
      await expect(summary).toHaveText('One page per frame, in presentation order (3 pages).')
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      expect(pdf.name).toBe(`${title}.pdf`)
      const info = await readPdf(pdf.bytes)
      expect(info.pages.map((p) => [p.width, p.height])).toEqual([
        [480, 360 + BAND],
        [600, 450 + BAND],
        [540, 405 + BAND], // Backstage 720×540
      ])
      expect(info.outline.map((o) => o.title)).toEqual(['Plan', 'Intro', 'Backstage'])
    })

    await test.step('only the skipped frame selected: a 1-page "selected frames" PDF', async () => {
      await a.page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await edit(a.page, (ed, id) => ed.select(id), F.backstage)
      await a.page.getByTestId('export-button').click()
      await expect(summary).toHaveText('The selected frames, one page each (1 page).')
      await expect(dialog.getByTestId('export-pdf-include-skipped')).toHaveCount(0)
      const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
      expect(pdf.name).toBe(`${title} - selected frames.pdf`)
      const info = await readPdf(pdf.bytes)
      expect(info.pages.map((p) => [p.width, p.height])).toEqual([[540, 405 + BAND]])
      expect(info.outline).toEqual([{ title: 'Backstage', page: 0 }])
    })
    expect(downloads).toEqual([`${title}.pdf`, `${title}.pdf`, `${title} - selected frames.pdf`])
  })

  test('Ctrl+P opens the PDF export focused on Download PDF, Delete inside the dialog keeps the selected note, and a viewer can present and download CSV and PDF', async ({
    session,
    users,
    board,
  }) => {
    const a = await session('alice')
    const title = await boardTitle(users, board)
    await seedBoard(a.page, DECK)
    await edit(a.page, (ed) => ed.zoomToFit())
    const c = await shapeCentre(a.page, N.plan)
    await a.page.mouse.click(c.x, c.y)
    await expect.poll(() => read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([N.plan])

    const dialog = a.page.getByTestId('export-dialog')
    await a.page.keyboard.press('Control+p')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('export-pdf')).toBeFocused()
    await a.page.keyboard.press('Delete')
    await a.page.keyboard.press('Backspace')
    await dialog.getByTestId('export-csv').focus()
    await a.page.keyboard.press('Delete')
    await nextFrames(a.page)
    await expect(dialog).toBeVisible()
    expect(await getShape(a.page, N.plan)).not.toBeNull()
    expect(await read(a.page, (ed) => ed.getSelectedShapeIds())).toEqual([N.plan])
    await a.page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // A viewer (read-only canvas) loads the board from the server: the note was never deleted.
    const v = await session('carol', { role: 'viewer' })
    await expectShapes(v.page, [F.intro, F.backstage, F.plan, N.intro, N.plan])
    expect(await read(v.page, (ed) => ed.getIsReadonly())).toBe(true)

    // ...and can present (the shortcuts work on a read-only canvas too),
    const ui = presentUi(v.page)
    await v.page.keyboard.press('Control+Alt+Enter')
    await expect(ui.counter).toHaveText('1 / 2')
    await v.page.keyboard.press('ArrowRight')
    await expect(ui.counter).toHaveText('2 / 2')
    await v.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    await ui.button.click()
    await expect(ui.counter).toHaveText('1 / 2')
    await ui.exit.click()
    await expect(ui.overlay).toHaveCount(0)

    // ...and download the CSV and the PDF.
    const vDialog = v.page.getByTestId('export-dialog')
    await v.page.getByTestId('export-button').click()
    await expect(vDialog).toBeVisible()
    const csv = await downloadFrom(v.page, () => vDialog.getByTestId('export-csv').click())
    expect(csv.name).toBe(`${title}.csv`)
    expect([...csv.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const rows = parseCsv(csv.bytes.subarray(3).toString('utf8'))
    expect(rows[0]).toEqual(['id', 'type', 'text', 'frame', 'color', 'x', 'y', 'tags'])
    expect(rows.find((r) => r[0] === N.plan)?.slice(1, 4)).toEqual(['note', 'Launch checklist', 'Plan'])
    const pdf = await downloadFrom(v.page, () => vDialog.getByTestId('export-pdf').click())
    expect(pdf.name).toBe(`${title}.pdf`)
    const info = await readPdf(pdf.bytes)
    expect(info.outline.map((o) => o.title)).toEqual(['Intro', 'Plan'])
  })
})

// ---- CSV ---------------------------------------------------------------------------------------------

test.describe('CSV export', () => {
  test('CSV export: UTF-8 with a BOM, the documented header, formula-like text neutralized, and a selection exports only its rows', async ({
    session,
    users,
    board,
  }) => {
    const a = await session('alice')
    const title = await boardTitle(users, board)
    const ID = {
      frame: 'shape:csv-frame',
      formula: 'shape:csv-formula',
      plus: 'shape:csv-plus',
      at: 'shape:csv-at',
      plain: 'shape:csv-plain',
      loose: 'shape:csv-loose',
    }
    const FORMULA = '=HYPERLINK("http://evil.example","click me")'
    await seedBoard(a.page, {
      frames: [{ id: ID.frame, name: 'Research', x: 0, y: 0, w: 1000, h: 400 }],
      notes: [
        { id: ID.formula, parentId: ID.frame, x: 20, y: 60, text: FORMULA },
        { id: ID.plus, parentId: ID.frame, x: 260, y: 60, text: '+1 555 0100' },
        { id: ID.at, parentId: ID.frame, x: 500, y: 60, text: '@SUM(A1:A9)' },
        { id: ID.plain, parentId: ID.frame, x: 740, y: 60, text: 'Plain, with a comma' },
        { id: ID.loose, x: 0, y: 600, text: 'Outside every frame' },
      ],
    })
    const dialog = a.page.getByTestId('export-dialog')
    const exportCsv = async () => {
      await a.page.getByTestId('export-button').click()
      await expect(dialog).toBeVisible()
      const file = await downloadFrom(a.page, () => dialog.getByTestId('export-csv').click())
      const status = (await dialog.getByTestId('export-status').textContent()) ?? ''
      await a.page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      expect([...file.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      const text = file.bytes.subarray(3).toString('utf8')
      expect(text.startsWith('id,type,text,frame,color,x,y,tags\r\n')).toBe(true)
      return { name: file.name, status, rows: parseCsv(text) }
    }

    const all = await exportCsv()
    expect(all.name).toBe(`${title}.csv`)
    const byId = new Map(all.rows.slice(1).map((r) => [r[0], r]))
    expect([...byId.keys()].sort()).toEqual(Object.values(ID).sort())
    expect(all.status).toBe(`Downloaded “${title}.csv” (6 rows).`)
    // A spreadsheet would evaluate these; the export prefixes an apostrophe so they stay text.
    expect(byId.get(ID.formula)?.[2]).toBe(`'${FORMULA}`)
    expect(byId.get(ID.plus)?.[2]).toBe("'+1 555 0100")
    expect(byId.get(ID.at)?.[2]).toBe("'@SUM(A1:A9)")
    expect(byId.get(ID.plain)?.[2]).toBe('Plain, with a comma')
    // Notes carry the palette's name for their colour (stored 'yellow' is "Marigold"; R14).
    expect(byId.get(ID.formula)?.slice(1, 5)).toEqual(['note', `'${FORMULA}`, 'Research', 'Marigold'])
    expect(byId.get(ID.loose)?.slice(3, 7)).toEqual(['', 'Marigold', '0', '600'])
    expect(byId.get(ID.frame)?.slice(1, 4)).toEqual(['frame', 'Research', ''])

    // One note selected: only its row.
    await edit(a.page, (ed, id) => ed.select(id), ID.plain)
    const one = await exportCsv()
    expect(one.name).toBe(`${title} - selection.csv`)
    expect(one.rows.slice(1).map((r) => r[0])).toEqual([ID.plain])
    expect(one.status).toBe(`Downloaded “${title} - selection.csv” (1 row).`)

    // The frame selected: the frame and what it contains, not the loose note.
    await edit(a.page, (ed, id) => ed.select(id), ID.frame)
    const framed = await exportCsv()
    expect(
      framed.rows
        .slice(1)
        .map((r) => r[0])
        .sort(),
    ).toEqual([ID.frame, ID.formula, ID.plus, ID.at, ID.plain].sort())

    // Renamed in the top bar to a title no file system accepts as is: the next export is named after the
    // new title, made safe ("/" becomes "-", ":" and "*" go).
    await edit(a.page, (ed) => ed.selectNone())
    await a.page.getByTestId('board-title').click()
    await a.page.getByTestId('board-title-input').fill('Q3/Q4: launch* plan')
    await a.page.getByTestId('board-title-input').press('Enter')
    await expect(a.page.getByTestId('board-title')).toHaveText('Q3/Q4: launch* plan')
    await expect.poll(() => boardTitle(users, board)).toBe('Q3/Q4: launch* plan')
    const renamed = await exportCsv()
    expect(renamed.name).toBe('Q3-Q4 launch plan.csv')
  })
})

// ---- integration ---------------------------------------------------------------------------------------

test.describe('integration', () => {
  test('presentation is clean: comment pins, the selection bar and the top bar are hidden while presenting and come back after Esc', async ({
    session,
    users,
    board,
  }) => {
    const a = await session('alice')
    await seedBoard(a.page, DECK)
    await edit(a.page, (ed) => ed.zoomToFit())
    // An open (unresolved) thread in the corner of the note on slide 2, and that note selected (with the
    // selection bar): the presentation then starts on slide 2, right where the pin is.
    const thread = await postThread(await users.api('alice'), board, N.plan, 'Is this the right order?', {
      u: 0.85,
      v: 0.15,
    })
    const pin = commentPin(a.page, thread)
    await expect(pin).toBeVisible()
    const c = await shapeCentre(a.page, N.plan)
    await a.page.mouse.click(c.x, c.y)
    const selbar = a.page.locator('.dr-cux-selbar')
    await expect(selbar).toBeVisible()
    const ui = presentUi(a.page)

    await ui.button.click()
    await expect(ui.counter).toHaveText('2 / 2')
    await expectSlideOnScreen(a.page, F.plan) // the pinned note is on this slide
    await expect.poll(() => visibleCount(a.page.locator('[data-testid="comment-pin"]'))).toBe(0)
    await expect.poll(() => visibleCount(selbar)).toBe(0)
    await expect(a.page.locator('.dr-topbar')).toBeHidden()

    await a.page.keyboard.press('Escape')
    await expect(ui.overlay).toHaveCount(0)
    await expect(pin).toBeVisible()
    await expect(selbar).toBeVisible()
    await expect(a.page.locator('.dr-topbar')).toBeVisible()
  })

  test('event stream survives an API restart: after a SIGKILL of the api, comments reach both pages without a reload and each page keeps exactly one stream', async ({
    browser,
    board,
    users,
    stack,
  }) => {
    // Regression (found in the validation phase): an api that died mid-stream left the page's
    // EventSource attached to a dead response, because the same-origin proxy never ended a response
    // whose headers were already sent, and the api's heartbeat was an SSE comment the page cannot see.
    // Fixed twice over: the vite proxy now aborts such responses (apps/web/vite.config.ts), and the api
    // pings with a data event that the client's watchdog (features/events.ts) expects.
    const NOTE = 'shape:events-note'
    const eventsPath = `/api/boards/${board}/events`
    const alice = await users.get('alice')
    const bob = await users.grant(board, 'bob', 'editor')
    const streams: Record<string, ReturnType<typeof trackRequests>> = {}
    const open = (who: typeof alice) =>
      openInstrumented(browser, board, who, (page) => {
        streams[who.handle] = trackRequests(page, (u) => u.pathname === eventsPath)
      })
    const a = await open(alice)
    const b = await open(bob)
    try {
      const pending = () => [streams.alice?.pending(), streams.bob?.pending()]
      await expect.poll(pending).toEqual([1, 1])
      await seedBoard(a.page, { notes: [{ id: NOTE, x: 200, y: 200, text: 'Comment on me' }] })
      await expectShapes(b.page, [NOTE])
      await edit(a.page, (ed) => ed.zoomToFit())
      await edit(b.page, (ed) => ed.zoomToFit())
      // Marks the documents: still there at the end = no reload happened.
      for (const s of [a, b]) await s.page.evaluate(() => Object.assign(window, { __peNoReload: true }))
      const bobApi = await users.api('bob')
      const aliceApi = await users.api('alice')

      const t0 = await postThread(bobApi, board, NOTE, 'Before the restart')
      await expect(commentPin(a.page, t0)).toBeVisible()

      await stack.api.restart() // SIGKILL (TerminateProcess on Windows), then a fresh process
      // Posted as soon as the api is back: A shows it from the resumed stream or from the refetch that
      // follows every reconnect (onResync), whichever comes first.
      const t1 = await postThread(bobApi, board, NOTE, 'Right after the restart')

      // Each page notices the dead stream and opens a new one (the client retries with a 1 s..30 s
      // backoff; a restarted api answers within a few seconds).
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
      const t2 = await postThread(bobApi, board, NOTE, 'Live after the reconnect, from Bob')
      await expect(commentPin(a.page, t2)).toBeVisible()
      const t3 = await postThread(aliceApi, board, NOTE, 'Live after the reconnect, from Alice')
      await expect(commentPin(b.page, t3)).toBeVisible()
      expect(pending()).toEqual([1, 1])
      for (const s of [a, b]) {
        expect(
          await s.page.evaluate(() => (window as unknown as { __peNoReload?: boolean }).__peNoReload),
        ).toBe(true)
      }
    } finally {
      await Promise.all([a.context.close(), b.context.close()])
    }
  })
})
