// Canvas and media polish, second round (review findings F7, F12, F8, F13/R11, R16): "Arrange as grid"
// centres items in uniform cells; a drop of images and files lands at one scale with the selection bar
// clear of every item; collaborators see an animated "Processing…" tile with the file name while the
// worker makes previews; thumbnails stay light and frame a very wide first frame from its left end;
// selecting a frame no longer shows a lone, unlabeled opacity slider.
//
// Unit coverage below the browser: apps/web/src/features/canvas-ux/arrange-grid.test.ts (uniform
// cells), apps/web/src/assets/drop-layout.test.ts (mixed drop, camera room for the bar),
// apps/web/src/assets/pending-images.test.ts (pending set, CSS escaping),
// apps/web/src/features/thumbnails/plan.test.ts (`frame` fit), canvas-ux/ui-defaults.test.ts (R16).
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { edit, fileCard, getShape, read, waitForValue } from './support/board.ts'
import { waitForCanvasUx, waitForSaved } from './support/canvas-ux.ts'
import type { BoxLike, ShapeLike } from './support/editor.ts'
import { allShapeIds, fileFromPath, insertPayloads, makeImages } from './support/files.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'
import { FIXTURES_DIR, REPO_ROOT } from './support/stack.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)
/** Local look-at copies of the screenshots (never committed). */
const SHOTS = join(REPO_ROOT, '.scratch/shots/canvas-2')

async function shot(name: string, target: Page | Locator) {
  mkdirSync(SHOTS, { recursive: true })
  await target.screenshot({ path: join(SHOTS, name) })
  await capture(name, target, test.info())
}

const overlap = (a: BoxLike, b: BoxLike) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const pageBounds = (page: Page, ids: readonly string[]) =>
  read(
    page,
    (ed, list) =>
      list.map((id) => {
        const b = ed.getShapePageBounds(id) as BoxLike
        return { id, x: b.x, y: b.y, w: b.w, h: b.h }
      }),
    [...ids],
  )

const box = async (l: Locator): Promise<BoxLike> => {
  const b = await l.boundingBox()
  if (!b) throw new Error('not rendered')
  return { x: b.x, y: b.y, w: b.width, h: b.height }
}

test('F7 Arrange as grid: mixed sizes land centred in their cells (shared column pitch and row centre lines)', async ({
  session,
}) => {
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  // Landscape, portrait and square "photos" and one card-sized box, scattered.
  const sizes: [number, number][] = [
    [170, 113],
    [113, 170],
    [360, 276],
    [170, 128],
    [128, 170],
    [170, 170],
    [170, 113],
    [113, 170],
    [170, 128],
  ]
  const ids = sizes.map((_, i) => `shape:f7-${i}`)
  await edit(
    a.page,
    (ed, list) => {
      ed.createShapes(
        list.map(([w, h], i) => ({
          id: `shape:f7-${i}`,
          type: 'geo',
          x: 200 + ((i * 397) % 900),
          y: 150 + ((i * 263) % 500),
          props: { w, h, geo: 'rectangle', fill: 'semi', color: i === 2 ? 'violet' : 'light-blue' },
        })),
      )
      ed.select(...list.map((_, i) => `shape:f7-${i}`))
      ;(ed as unknown as { zoomToSelection(): void }).zoomToSelection()
    },
    sizes,
  )
  await a.page.keyboard.press('Alt+Shift+G')
  /** Distinct values, merging those within half a unit. */
  const lines = (values: number[]) =>
    [...values].sort((p, q) => p - q).filter((v, i, s) => i === 0 || v - (s[i - 1] as number) > 0.5)
  const cx = (r: BoxLike) => r.x + r.w / 2
  const cy = (r: BoxLike) => r.y + r.h / 2
  const placed = await waitForValue(async () => {
    const b = await pageBounds(a.page, ids)
    return lines(b.map(cy)).length === 3 ? b : null
  })
  // 9 items in 3 × 3 uniform cells: three column centre lines, evenly spaced, and three row centre
  // lines; every item sits on one of each (before, items hugged their cell's top-left corner).
  const cols = lines(placed.map(cx))
  const rows = lines(placed.map(cy))
  expect(cols).toHaveLength(3)
  expect(rows).toHaveLength(3)
  const [c0, c1, c2] = cols as [number, number, number]
  const [r0, r1, r2] = rows as [number, number, number]
  // Columns share one pitch (the widest item plus the gap). Rows are as tall as their tallest item
  // (F2-06: a row of landscape photos is not spaced as if it held the tallest card), so the row pitch
  // may differ from row to row, but every row clears the one above it.
  expect(Math.abs(c1 - c0 - (c2 - c1))).toBeLessThan(0.5)
  expect(c1 - c0).toBeGreaterThanOrEqual(360)
  expect(r1).toBeGreaterThan(r0)
  expect(r2).toBeGreaterThan(r1)
  placed.forEach((p, i) => {
    for (const q of placed.slice(i + 1)) expect(overlap(p, q)).toBe(false)
  })
  await edit(a.page, (ed) => {
    ed.selectNone()
    ;(ed as unknown as { zoomToFit(): void }).zoomToFit()
  })
  await shot('f7-arranged-uniform-cells.png', a.page)
})

test('F12 R16 a drop of images plus a PDF and a video lands at one scale, the selection bar clear of every item; a lone opacity slider is labelled and a frame gets none', async ({
  session,
}) => {
  test.setTimeout(150_000)
  const a = await session('alice')
  await waitForCanvasUx(a.page)
  const specs = Array.from({ length: 12 }, (_, i) => ({
    name: `mood-${String(i + 1).padStart(2, '0')}.jpg`,
    w: i % 3 === 1 ? 900 : 1400,
    h: i % 3 === 1 ? 1300 : 900,
  }))
  const images = await makeImages(a.page, specs)
  const before = new Set(await allShapeIds(a.page))
  await insertPayloads(a.page, [
    ...images,
    fileFromPath(fixture('document.pdf')),
    fileFromPath(fixture('video.mp4')),
  ])
  await expect(fileCard(a.page, 'document.pdf')).toBeVisible({ timeout: 30_000 })
  await expect(fileCard(a.page, 'video.mp4')).toBeVisible({ timeout: 30_000 })
  const created = await waitForValue(async () => {
    const shapes = await read(a.page, (ed) =>
      ed.getCurrentPageShapes().map((s: ShapeLike) => ({ id: s.id, type: s.type })),
    )
    const fresh = shapes.filter((s) => !before.has(s.id))
    return fresh.filter((s) => s.type === 'image').length === 12 &&
      fresh.filter((s) => s.type === 'dr-file-card').length === 2
      ? fresh
      : null
  })
  const imageIds = created.filter((s) => s.type === 'image').map((s) => s.id)
  const cardIds = created.filter((s) => s.type === 'dr-file-card').map((s) => s.id)

  await test.step('one scale: every image and card has the same longest side', async () => {
    const all = await pageBounds(a.page, [...imageIds, ...cardIds])
    const sides = all.map((r) => Math.max(r.w, r.h))
    expect(Math.max(...sides) / Math.min(...sides)).toBeLessThan(1.02)
  })

  await test.step('the whole drop is selected, and the selection bar covers none of it', async () => {
    await expect
      .poll(() => read(a.page, (ed) => ed.getSelectedShapeIds().length))
      .toBe(imageIds.length + cardIds.length)
    await a.page.waitForTimeout(800) // the camera move after the drop
    const bar = await box(a.page.getByTestId('selection-bar'))
    for (const name of ['document.pdf', 'video.mp4']) {
      expect(overlap(bar, await box(fileCard(a.page, name)))).toBe(false)
    }
    for (const id of imageIds) {
      expect(overlap(bar, await box(a.page.locator(`.tl-shape[data-shape-id="${id}"]`)))).toBe(false)
    }
    await shot('f12-mixed-drop-selected.png', a.page)
  })

  await test.step('R16: one image selected: the style panel labels its only control "Opacity"', async () => {
    await edit(a.page, (ed, id) => ed.select(id), imageIds[0])
    await expect(a.page.getByTestId('style.opacity')).toBeVisible()
    await expect(a.page.getByTestId('style-opacity-label')).toHaveText('Opacity')
    await shot('r16-image-opacity-labelled.png', a.page)
  })

  await test.step('R16: a frame selected: no lone slider in the corner', async () => {
    await edit(a.page, (ed) => {
      ed.createShapes([
        { id: 'shape:r16-frame', type: 'frame', x: -2000, y: -2000, props: { w: 800, h: 500 } },
      ])
      ed.select('shape:r16-frame')
      ;(ed as unknown as { zoomToSelection(): void }).zoomToSelection()
    })
    await expect(a.page.getByTestId('selection-bar')).toBeVisible()
    await expect(a.page.getByTestId('style.opacity')).toHaveCount(0)
    await expect(a.page.locator('.tlui-style-panel')).toHaveCount(0)
    await shot('r16-frame-selected-no-slider.png', a.page)
    // A note still gets its panel (colours, then opacity, no extra label).
    await edit(a.page, (ed) => {
      ed.createShapes([{ id: 'shape:r16-note', type: 'note', x: -1900, y: -1900 }])
      ed.select('shape:r16-note')
    })
    await expect(a.page.getByTestId('style.opacity')).toBeVisible()
    await expect(a.page.getByTestId('style-opacity-label')).toHaveCount(0)
  })
})

test('F8 a collaborator watching an upload sees an animated "Processing…" tile with the file name, then the preview', async ({
  session,
  stack,
}) => {
  test.setTimeout(150_000)
  const a = await session('alice')
  const b = await session('bob')
  await Promise.all([waitForCanvasUx(a.page), waitForCanvasUx(b.page)])
  const images = await makeImages(a.page, [
    { name: 'halden-hero.jpg', w: 1600, h: 1000 },
    { name: 'autumn-leaves-portrait.jpg', w: 900, h: 1300 },
  ])
  await stack.worker.kill() // previews cannot be made until the worker is back
  const before = new Set(await allShapeIds(a.page))
  await insertPayloads(a.page, images)
  const ids = await waitForValue(async () => {
    const now = [...(await allShapeIds(a.page))].filter((id) => !before.has(id))
    return now.length === 2 ? now : null
  })
  for (const id of ids) await expect.poll(() => getShape(b.page, id).then((s) => s !== null)).toBe(true)
  await edit(
    b.page,
    (ed, list) => {
      const e = ed as unknown as {
        select(...ids: string[]): void
        zoomToSelection(): void
        selectNone(): void
      }
      e.select(...list)
      e.zoomToSelection()
      e.selectNone()
    },
    ids,
  )

  const tile = (id: string) => b.page.locator(`.tl-shape[data-shape-id="${id}"] .tl-image-container`)
  const pseudo = (id: string, which: '::before' | '::after') =>
    tile(id).evaluate((el, w) => {
      const s = getComputedStyle(el, w)
      return { content: s.content, animation: getComputedStyle(el).animationName }
    }, which)

  await test.step('bob: each empty tile says Processing… with its own file name, over a shimmer', async () => {
    const names = await read(
      b.page,
      (ed, list) =>
        list.map((id) => {
          const s = ed.getShape(id) as ShapeLike
          const e = ed as unknown as { getAsset(id: string): { props: { name: string } } }
          return String(e.getAsset(s.props.assetId as string).props.name)
        }),
      ids,
    )
    expect([...names].sort()).toEqual(['autumn-leaves-portrait.jpg', 'halden-hero.jpg'])
    for (const [i, id] of ids.entries()) {
      await expect.poll(() => pseudo(id, '::before').then((p) => p.content)).toBe('"Processing…"')
      await expect.poll(() => pseudo(id, '::after').then((p) => p.content)).toBe(`"${names[i]}"`)
      expect((await pseudo(id, '::before')).animation).toBe('dr-pending-shimmer')
    }
    await shot('f8-bob-processing-tiles.png', b.page)
  })

  await stack.worker.start()
  await test.step('once previews exist, the tiles show them and the name rules are gone', async () => {
    for (const id of ids) {
      await expect(tile(id).locator('img')).toHaveCount(1, { timeout: 60_000 })
    }
    await expect(b.page.getByTestId('pending-image-names')).toHaveCount(0, { timeout: 30_000 })
    await shot('f8-bob-previews-arrived.png', b.page)
  })
})

test('F13 R11 the dashboard thumbnail of a Retrospective, made in dark mode, is light and shows the Check-in frame from its left end', async ({
  session,
  board,
}) => {
  test.setTimeout(150_000)
  const a = await session('alice')
  await a.page.evaluate(() => localStorage.setItem('draftroom:theme', 'dark'))
  await a.page.reload()
  await waitForCanvasUx(a.page)
  await expect(a.page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await a.page.getByTestId('tools.dr-templates').click()
  await a.page.locator('[data-testid="template-option"][data-template-id="retrospective"]').click()
  await expect(a.page.getByTestId('template-picker')).toHaveCount(0)
  await expect(a.page.getByTestId('thumbnail-capture')).toHaveAttribute('data-state', /rendered|sent/, {
    timeout: 30_000,
  })
  await waitForSaved(a.page)
  await a.page.getByRole('link', { name: 'Back to Dev Studio' }).click()
  const card = a.page.locator(`[data-testid="board-card"][data-board-id="${board}"]`)
  const img = card.locator('img').first()
  await expect(img).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
  const stats = await img.evaluate((i: HTMLImageElement) => {
    const c = document.createElement('canvas')
    c.width = i.naturalWidth
    c.height = i.naturalHeight
    const g = c.getContext('2d')
    if (!g) return null
    g.drawImage(i, 0, 0)
    const px = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))
    // Coloured (sticky-note) pixels in the left fifth of the image: the frame's first notes.
    const d = g.getImageData(0, 0, Math.floor(c.width / 5), c.height).data
    let coloured = 0
    for (let p = 0; p < d.length; p += 4) {
      const r = d[p] ?? 0
      const gg = d[p + 1] ?? 0
      const bb = d[p + 2] ?? 0
      if (Math.max(r, gg, bb) - Math.min(r, gg, bb) > 40) coloured++
    }
    return { corner: px(2, 2), coloured }
  })
  if (!stats) throw new Error('no canvas')
  // Light paper whatever the capturing person's theme (never a dark capture on some cards).
  for (const channel of stats.corner) expect(channel).toBeGreaterThan(200)
  expect(stats.coloured).toBeGreaterThan(200)
  await shot('f13-r11-dashboard-dark.png', a.page)
  await a.page.evaluate(() => localStorage.setItem('draftroom:theme', 'light'))
  await a.page.reload()
  await expect(card.locator('img').first()).toBeVisible({ timeout: 30_000 })
  await shot('f13-r11-dashboard-light.png', a.page)
})
