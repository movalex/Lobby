// sample-board (docs/WAVE3-CONTRACTS.md §2): the "Lobby tour" demo board. Created from the dashboard
// (the empty dashboard's "Start with the sample board" and the gallery's sample card), it opens with
// six named frames left to right in presentation order, every label fits the shape tldraw measured it
// in, nothing overlaps, and Present walks the six frames. Server state is checked from a second tab and
// through the API, not only in the tab that inserted the tour.
import type { Page } from '@playwright/test'
import { Api } from './support/api.ts'
import { edit, read, waitForBoard } from './support/board.ts'
import {
  frameNames,
  freshHandle,
  openDashboard,
  personalWorkspace,
  signedInContext,
} from './support/dashboard-share.ts'
import type { BindingLike, BoxLike } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { expectSlideOnScreen, nextFrames, presentUi } from './support/present-export.ts'
import { expectCanvas } from './support/theme.ts'

/** tldraw 5.4.2 Editor methods this spec needs beyond support/editor.ts. */
interface TourEditor {
  zoomToBounds(b: BoxLike, opts?: { inset?: number; animation?: { duration: number } }): unknown
  getBindingsToShape(id: string, type: string): BindingLike[]
  getZoomLevel(): number
}

const SECTIONS = [
  '1 · Welcome',
  '2 · Brainstorm',
  '3 · Plan',
  '4 · Mood board',
  '5 · Retro',
  '6 · Tips and shortcuts',
]

/** The page's frames, left to right: id, name and page bounds. */
const framesLeftToRight = (page: Page) =>
  read(page, (ed) =>
    ed
      .getCurrentPageShapes()
      .filter((s) => s.type === 'frame')
      .map((s) => ({
        id: s.id,
        name: String(s.props.name),
        parentId: s.parentId,
        b: ed.getShapePageBounds(s.id),
      }))
      .sort((a, b) => (a.b?.x ?? 0) - (b.b?.x ?? 0)),
  )

/**
 * What tldraw itself measured when the shapes were created (NoteShapeUtil / GeoShapeUtil
 * onBeforeCreate): any label that did not fit got growY or a smaller font. Plus the real rendered
 * page bounds: every shape inside its frame, no two solid shapes of a frame overlapping, and every
 * arrow bound at both ends.
 */
const layoutProblems = (page: Page) =>
  read(page, (ed) => {
    const problems: string[] = []
    const shapes = ed.getCurrentPageShapes()
    const label = (s: (typeof shapes)[number]) => {
      const rt = s.props.richText as { content?: Array<{ content?: Array<{ text?: string }> }> } | undefined
      return (rt?.content ?? []).map((p) => (p.content ?? []).map((n) => n.text ?? '').join('')).join(' / ')
    }
    const inside = (o: { x: number; y: number; w: number; h: number }, i: typeof o) =>
      i.x >= o.x - 0.5 && i.y >= o.y - 0.5 && i.x + i.w <= o.x + o.w + 0.5 && i.y + i.h <= o.y + o.h + 0.5
    for (const s of shapes) {
      if ((s.type === 'note' || s.type === 'geo') && s.props.growY !== 0)
        problems.push(`${s.type} "${label(s)}" grew by ${s.props.growY}`)
      if (s.type === 'note' && s.props.fontSizeAdjustment !== 1)
        problems.push(`note "${label(s)}" shrank its font to ${s.props.fontSizeAdjustment}`)
      if (s.type === 'frame' || s.type === 'arrow') continue
      const parent = ed.getShape(s.parentId)
      const b = ed.getShapePageBounds(s.id)
      const pb = parent ? ed.getShapePageBounds(parent.id) : undefined
      if (parent?.type !== 'frame' || !b || !pb || !inside(pb, b))
        problems.push(`${s.type} "${label(s)}" is not inside its frame`)
    }
    for (const f of shapes.filter((s) => s.type === 'frame')) {
      const kids = shapes
        .filter((s) => s.parentId === f.id && s.type !== 'arrow')
        .map((s) => ({ s, b: ed.getShapePageBounds(s.id) }))
      kids.forEach(({ s: sa, b: a }, i) => {
        for (const { s: sb, b } of kids.slice(i + 1)) {
          if (!a || !b) continue
          const overlap =
            a.x + a.w - 0.5 > b.x && b.x + b.w - 0.5 > a.x && a.y + a.h - 0.5 > b.y && b.y + b.h - 0.5 > a.y
          if (overlap) problems.push(`"${label(sa)}" overlaps "${label(sb)}" in ${String(f.props.name)}`)
        }
      })
    }
    for (const a of shapes.filter((s) => s.type === 'arrow')) {
      const bindings = ed.getBindingsFromShape(a.id, 'arrow')
      const targets = bindings.map((x) => ed.getShape(x.toId)).filter((t) => t && t.type !== 'arrow')
      if (bindings.length !== 2 || targets.length !== 2)
        problems.push(`arrow ${a.id} is not bound at both ends`)
    }
    return problems
  })

/**
 * F1: with the gallery scrolled to the top (as it opens), "Create from …" is on screen and nothing
 * covers it: the dialog keeps it pinned to its bottom edge.
 */
async function expectCreateOnScreen(page: Page) {
  const hit = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="create-board-submit"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    return {
      top: r.top,
      bottom: r.bottom,
      right: r.right,
      vw: innerWidth,
      vh: innerHeight,
      hit: !!el && b.contains(el),
    }
  })
  expect(hit, 'the create button exists').not.toBeNull()
  expect(hit?.top).toBeGreaterThanOrEqual(0)
  expect(hit?.bottom).toBeLessThanOrEqual(hit?.vh ?? 0)
  expect(hit?.right).toBeLessThanOrEqual(hit?.vw ?? 0)
  expect(hit?.hit, 'the create button is not covered').toBe(true)
}

/** The tour is on the board: six frames, in order, in one row, nothing broken. */
async function expectTour(page: Page) {
  await expect.poll(() => frameNames(page)).toEqual([...SECTIONS].sort())
  const frames = await framesLeftToRight(page)
  expect(frames.map((f) => f.name)).toEqual(SECTIONS)
  expect(new Set(frames.map((f) => Math.round(f.b?.y ?? -1))).size).toBe(1)
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i]?.b
    const b = frames[i + 1]?.b
    expect(a && b && a.x + a.w < b.x).toBe(true)
  }
  expect(await layoutProblems(page)).toEqual([])
  return frames
}

test('sample board: "Start with the sample board" on an empty dashboard opens the six-frame Lobby tour, saved on the server, and Present walks the frames in order', async ({
  browser,
}) => {
  const person = await signedInContext(browser, freshHandle('tour'), {
    viewport: { width: 1440, height: 900 },
  })
  const api = new Api(person.context.request)
  try {
    const { page } = person
    const workspaceId = personalWorkspace(person.me)
    await openDashboard(page, workspaceId)
    await expect(page.getByTestId('dashboard-empty')).toBeVisible()
    const start = page.getByTestId('start-sample-board')
    await expect(start).toHaveText('Start with the sample board')
    await expect(start).toHaveAccessibleName('Start with the sample board')

    await start.click()
    // The board page inserts the tour once, then drops ?template=.
    await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
    const boardId = new URL(page.url()).pathname.split('/')[2] ?? ''
    await waitForBoard(page)
    await expect(page.getByTestId('board-title')).toHaveText('Lobby tour')
    const frames = await expectTour(page)

    await test.step('a normal private board, with the tour stored on the server (a second tab loads it)', async () => {
      const { board } = await api.getBoard(boardId)
      expect(board).toMatchObject({ title: 'Lobby tour', visibility: 'private', workspaceId })
      const second = await person.context.newPage()
      try {
        await second.goto(`/b/${boardId}`)
        await waitForBoard(second)
        await expectTour(second)
        expect((await framesLeftToRight(second)).map((f) => f.id)).toEqual(frames.map((f) => f.id))
      } finally {
        await second.close()
      }
      // A reload does not insert it again.
      await page.reload()
      await waitForBoard(page)
      await expectTour(page)
    })

    await test.step('Present walks the six frames in order and stops at the last one', async () => {
      const ui = presentUi(page)
      await ui.button.click()
      await expect(ui.overlay).toBeVisible()
      for (let i = 0; i < SECTIONS.length; i++) {
        await expect(ui.counter).toHaveText(`${i + 1} / 6`)
        await expect(ui.title).toHaveText(SECTIONS[i] ?? '')
        await expectSlideOnScreen(page, frames[i]?.id ?? '')
        if (i + 1 < SECTIONS.length) await page.keyboard.press('ArrowRight')
      }
      await page.keyboard.press('ArrowRight')
      await nextFrames(page)
      await expect(ui.counter).toHaveText('6 / 6')
      await page.keyboard.press('Home')
      await expect(ui.counter).toHaveText('1 / 6')
      await page.keyboard.press('Escape')
      await expect(ui.overlay).toHaveCount(0)
    })

    await test.step('the Mood board is a direction (palette, type), with two reference slots (F10)', async () => {
      const mood = await read(
        page,
        (ed, id) =>
          ed
            .getSortedChildIdsForParent(id)
            .map((c) => ed.getShape(c))
            .filter((s) => s?.type === 'geo')
            .map((s) => ({
              slot: s?.meta.draftroomSlot === 'image',
              fill: s?.props.fill,
              color: s?.props.color,
            })),
        frames[3]?.id ?? '',
      )
      expect(mood.filter((g) => g.slot)).toHaveLength(2)
      const swatches = mood.filter((g) => g.fill === 'fill')
      expect(swatches.length).toBeGreaterThanOrEqual(4)
      expect(swatches[0]?.color).toBe('orange')
    })

    await test.step('drag the Story theme down (DEMO.md 1:00): it lands on empty canvas, its connector follows (F12)', async () => {
      const brainstorm = frames[1]?.id ?? ''
      await edit(
        page,
        (ed, id) => {
          ed.selectNone()
          const b = ed.getShapePageBounds(id)
          if (b) (ed as unknown as TourEditor).zoomToBounds(b, { inset: 24, animation: { duration: 0 } })
        },
        brainstorm,
      )
      const story = await read(
        page,
        (ed, id) => {
          const s = ed
            .getSortedChildIdsForParent(id)
            .map((c) => ed.getShape(c))
            .find((x) => {
              const rt = x?.props.richText as
                | { content?: Array<{ content?: Array<{ text?: string }> }> }
                | undefined
              const text = (rt?.content ?? [])
                .map((p) => (p.content ?? []).map((n) => n.text ?? '').join(''))
                .join('')
              return x?.type === 'geo' && text === 'Story'
            })
          if (!s) return null
          const b = ed.getShapePageBounds(s.id)
          if (!b) return null
          const c = ed.pageToScreen({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
          const more = ed as unknown as TourEditor
          const arrow = more.getBindingsToShape(s.id, 'arrow')[0]?.fromId ?? null
          return { id: s.id, y: b.y, cx: c.x, cy: c.y, zoom: more.getZoomLevel(), arrow }
        },
        brainstorm,
      )
      expect(story, 'the Story theme').not.toBeNull()
      if (!story) return
      expect(story.arrow, 'a connector ends on the Story theme').not.toBeNull()
      await page.mouse.move(story.cx, story.cy)
      await page.mouse.down()
      await page.mouse.move(story.cx, story.cy + 120 * story.zoom, { steps: 8 })
      await page.mouse.up()
      const after = await read(
        page,
        (ed, a) => ({
          y: ed.getShapePageBounds(a.id)?.y ?? null,
          bound: ed.getBindingsFromShape(a.arrow, 'arrow').some((b) => b.toId === a.id),
        }),
        { id: story.id, arrow: story.arrow ?? '' },
      )
      expect(after.y ?? 0).toBeGreaterThan(story.y + 100)
      expect(after.bound, 'the connector is still attached').toBe(true)
      // Nothing overlaps: the theme moved into the empty space under it.
      expect(await layoutProblems(page)).toEqual([])
    })

    await test.step('the dashboard lists it like any other board', async () => {
      await openDashboard(page, workspaceId)
      await expect(page.locator(`[data-testid="board-card"][data-board-id="${boardId}"]`)).toBeVisible()
      await expect(page.getByTestId('dashboard-empty')).toHaveCount(0)
    })
  } finally {
    await person.context.close()
  }
})

test('sample board: the gallery shows the Lobby tour first, outside the category chips, and creates it', async ({
  browser,
}) => {
  const person = await signedInContext(browser, freshHandle('tourg'))
  try {
    const { page } = person
    await openDashboard(page, personalWorkspace(person.me))
    await page.getByTestId('create-board').click()
    const gallery = page.getByTestId('template-gallery')
    const sample = gallery.getByTestId('template-sample')
    await expect(sample).toBeVisible()

    await test.step('first, above Blank board and the six templates (which are unchanged)', async () => {
      await expect(sample).toHaveAttribute('data-template-id', 'lobby-tour')
      await expect(sample).toHaveAttribute('aria-pressed', 'false')
      await expect(sample).toContainText('Lobby tour')
      await expect(sample).toContainText('Start here')
      await expect(gallery.getByTestId('template-card')).toHaveCount(6)
      await expect(
        gallery.locator('.dr-gallery__grid > li').first().getByTestId('template-blank'),
      ).toBeVisible()
      const s = await sample.boundingBox()
      const blank = await gallery.getByTestId('template-blank').boundingBox()
      expect(s && blank && s.y + s.height <= blank.y).toBe(true)
    })

    await test.step('no category chip lists it; "All" and a matching search do', async () => {
      for (const c of ['ideate', 'visual', 'plan', 'review']) {
        await page.locator(`[data-testid="template-category"][data-category="${c}"]`).click()
        await expect(sample).toHaveCount(0)
      }
      await page.locator('[data-testid="template-category"][data-category="all"]').click()
      await expect(sample).toBeVisible()
      await page.getByTestId('template-search').fill('sample')
      await expect(sample).toBeVisible()
      await expect(gallery.getByTestId('template-card')).toHaveCount(0)
      await expect(page.getByTestId('template-empty')).toHaveCount(0)
      await page.getByTestId('template-search').fill('panel')
      await expect(sample).toHaveCount(0)
      await page.getByTestId('template-search').fill('')
    })

    await test.step('at 1440 × 900, "Create from Lobby tour" is on screen as soon as the card is picked (F1)', async () => {
      await page.setViewportSize({ width: 1440, height: 900 })
      await sample.click()
      await expect(page.getByTestId('create-board-submit')).toHaveText('Create from Lobby tour')
      await expect(page.getByTestId('create-board-picked')).toHaveText('Lobby tour')
      await expectCreateOnScreen(page)
      // The gallery still scrolls under it, and the button stays put.
      await page.getByTestId('create-board-dialog').evaluate((d) => d.scrollTo({ top: 400 }))
      await expectCreateOnScreen(page)
      await page.getByTestId('create-board-dialog').evaluate((d) => d.scrollTo({ top: 0 }))
      await page.getByTestId('template-blank').click()
    })

    await test.step('selecting it names the six frames and creates the tour', async () => {
      await sample.click()
      await expect(sample).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('template-blank')).toHaveAttribute('aria-pressed', 'false')
      await expect(page.getByTestId('template-sections')).toHaveText(`Lobby tour: ${SECTIONS.join(' · ')}`)
      await expect(page.getByTestId('create-board-submit')).toHaveText('Create from Lobby tour')
      await page.getByTestId('create-board-submit').click()
      await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
      await waitForBoard(page)
      await expect(page.getByTestId('board-title')).toHaveText('Lobby tour')
      await expectTour(page)
    })
  } finally {
    await person.context.close()
  }
})

test('sample board: at 390 px in dark mode the empty dashboard and the gallery fit the screen, and the tour opens dark', async ({
  browser,
}) => {
  const handle = freshHandle('tourp')
  const person = await signedInContext(browser, handle, { viewport: { width: 390, height: 844 } })
  // Dark through the OS setting (the default theme choice is System).
  await person.page.emulateMedia({ colorScheme: 'dark' })
  try {
    const { page } = person
    const noSideScroll = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)
    await openDashboard(page, personalWorkspace(person.me))
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const start = page.getByTestId('start-sample-board')
    await start.scrollIntoViewIfNeeded()
    await expect(start).toBeVisible()
    const b = await start.boundingBox()
    expect(b && b.x >= 0 && b.x + b.width <= 390).toBe(true)
    expect(await noSideScroll()).toBe(true)

    await page.getByTestId('create-board').click()
    const sample = page.getByTestId('template-sample')
    await expect(sample).toBeVisible()
    const s = await sample.boundingBox()
    expect(s && s.x >= 0 && s.x + s.width <= 390).toBe(true)
    await expect(sample.locator('.dr-tcard__desc')).toBeVisible()
    expect(await noSideScroll()).toBe(true)
    // F1: picking it puts "Create from Lobby tour" on screen, pinned to the dialog's bottom edge.
    await sample.click()
    await expectCreateOnScreen(page)
    expect(await noSideScroll()).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('create-board-dialog')).toHaveCount(0)

    await start.click()
    await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
    await waitForBoard(page)
    await expectCanvas(page, 'dark')
    await expectTour(page)
  } finally {
    await person.context.close()
  }
})
