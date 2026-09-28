import { expect, type Page, test } from '@playwright/test'
import { colorFor, type FilesServer, fixtureVersion, startFilesServer } from '../fixtures/files-server.ts'
import type { EchoProbe, RenderEngine } from '../fixtures/render-types.ts'
import { openSpike } from '../support/page.ts'
import { SPIKE_API_ORIGIN } from '../support/ports.ts'
import { watchPage } from '../support/watch.ts'

// A11 (docs/EXCALIDRAW-MIGRATION.md §8.2, §4.6), part 1: a checkpoint preview drawn with exportToCanvas
// and Lobby's own pan and zoom (apps/web/src/canvas/preview/CheckpointPreview.ts), next to a live board,
// without a second <Excalidraw>. Pass: the preview works (pixel probes at scene positions through fit,
// drag-pan, wheel-pan and Ctrl+wheel zoom with the detail pass) and the live board is untouched.

interface PreviewExtra {
  probe: EchoProbe
  engine: RenderEngine
  openPreview(elements: unknown[], opts?: { maxPixels?: number }): Promise<Record<string, unknown>>
  preview: {
    camera: { x: number; y: number; zoom: number }
    stats: Record<string, number>
    sceneToView(x: number, y: number): { x: number; y: number }
    needsDetail(): boolean
  }
  previewPixel(x: number, y: number): number[] | null
  previewDark(r: { x: number; y: number; w: number; h: number }): number
  livePixel(x: number, y: number): number[] | null
}

let files: FilesServer
test.beforeAll(async () => {
  files = await startFilesServer(Number(new URL(SPIKE_API_ORIGIN).port))
})
test.afterAll(async () => {
  await files?.close()
})

const BLUE = [0x9f, 0xd4, 0xff]
const GREEN = [0xb8, 0xe9, 0x94]
const YELLOW = [0xff, 0xdf, 0x6b]
const near = (a: number[] | null, b: readonly number[], tol = 14) =>
  !!a && b.every((c, i) => Math.abs((a[i] ?? -999) - c) <= tol)
const ver = fixtureVersion(7, 'pv')

const x = (page: Page) =>
  page.evaluate(() => {
    const extra = window.__lobbySpike?.extra as unknown as PreviewExtra
    return {
      cam: extra.preview.camera,
      stats: { ...extra.preview.stats },
      needsDetail: extra.preview.needsDetail(),
    }
  })
const pp = (page: Page, sx: number, sy: number) =>
  page.evaluate(
    ([sx, sy]) => ((window.__lobbySpike as { extra: unknown }).extra as PreviewExtra).previewPixel(sx, sy),
    [sx, sy] as const,
  )

test('checkpoint preview: exportToCanvas bitmaps with Lobby pan and zoom; no second editor; live board untouched', async ({
  page,
}) => {
  const watch = watchPage(page)
  await openSpike(page, 'render-preview')
  // live board: three yellow notes
  const live = await page.evaluate(() => {
    const spike = window.__lobbySpike
    const extra = spike?.extra as unknown as PreviewExtra
    const els = extra.engine.convertToExcalidrawElements(
      [0, 1, 2].map((i) => ({
        type: 'stickynote',
        id: `live-${i}`,
        x: 40 + i * 220,
        y: 60,
        width: 200,
        height: 200,
        backgroundColor: '#ffdf6b',
        label: { text: `Live ${i}`, fontFamily: 6 },
      })),
      { regenerateIds: false },
    )
    extra.probe.applyServer(els.map((e) => ({ ...e, created: null })))
    const s = spike?.api?.getAppState()
    return { scroll: [s?.scrollX, s?.scrollY, s?.zoom.value], count: spike?.api?.getSceneElements().length }
  })

  // the checkpoint: a frame with a blue and a green note (labels), an image and a note far away
  const checkpoint = await page.evaluate((ver) => {
    const extra = window.__lobbySpike?.extra as unknown as PreviewExtra
    return extra.engine
      .convertToExcalidrawElements(
        [
          {
            type: 'stickynote',
            id: 'cp-blue',
            x: 100,
            y: 120,
            width: 200,
            height: 200,
            backgroundColor: '#9fd4ff',
            label: { text: 'Checkpoint blue note', fontFamily: 6 },
          },
          {
            type: 'stickynote',
            id: 'cp-green',
            x: 340,
            y: 120,
            width: 200,
            height: 200,
            backgroundColor: '#b8e994',
            label: { text: 'Green', fontFamily: 6 },
          },
          { type: 'image', id: 'cp-img', x: 100, y: 380, width: 320, height: 200, fileId: ver },
          {
            type: 'frame',
            id: 'cp-frame',
            x: 60,
            y: 80,
            width: 520,
            height: 540,
            name: 'Checkpoint frame',
            children: ['cp-blue', 'cp-green', 'cp-img'],
          },
          {
            type: 'stickynote',
            id: 'cp-far',
            x: 2600,
            y: 1700,
            width: 200,
            height: 200,
            backgroundColor: '#9fd4ff',
            label: { text: 'Far', fontFamily: 6 },
          },
        ],
        { regenerateIds: false },
      )
      .map((e) =>
        e.type === 'stickynote'
          ? { ...e, created: null }
          : e.type === 'image'
            ? { ...e, status: 'saved' }
            : e,
      )
  }, ver)

  const opened = await page.evaluate(
    (els) => ((window.__lobbySpike as { extra: unknown }).extra as PreviewExtra).openPreview(els),
    checkpoint,
  )
  const editors = await page.evaluate(() => ({
    excalidraw: document.querySelectorAll('.excalidraw').length,
    staticCanvases: document.querySelectorAll('canvas.excalidraw__canvas.static').length,
  }))
  expect(editors).toEqual({ excalidraw: 1, staticCanvases: 1 })

  // fit: the whole checkpoint in view
  const fit = await x(page)
  const fitPixels = {
    blue: await pp(page, 100 + 12, 120 + 12),
    green: await pp(page, 340 + 12, 120 + 12),
    image: await pp(page, 100 + 0.8 * 320, 380 + 0.2 * 200),
    far: await pp(page, 2600 + 12, 1700 + 12),
  }
  expect(near(fitPixels.blue, BLUE)).toBe(true)
  expect(near(fitPixels.green, GREEN)).toBe(true)
  expect(near(fitPixels.image, colorFor(ver.slice(4)))).toBe(true)
  expect(near(fitPixels.far, BLUE)).toBe(true)

  // drag-pan by (+150, +80) CSS px: the scene moves with the pointer
  const canvasBox = await page.getByTestId('checkpoint-preview-canvas').boundingBox()
  if (!canvasBox) throw new Error('no preview canvas')
  const blueViewBefore = await page.evaluate(() =>
    ((window.__lobbySpike as { extra: unknown }).extra as PreviewExtra).preview.sceneToView(200, 220),
  )
  const cx = canvasBox.x + canvasBox.width / 2
  const cy = canvasBox.y + canvasBox.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 150, cy + 80, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(100)
  const panned = await x(page)
  const blueViewAfter = await page.evaluate(() =>
    ((window.__lobbySpike as { extra: unknown }).extra as PreviewExtra).preview.sceneToView(200, 220),
  )
  expect(blueViewAfter.x).toBeCloseTo(blueViewBefore.x + 150, 0)
  expect(blueViewAfter.y).toBeCloseTo(blueViewBefore.y + 80, 0)
  expect(near(await pp(page, 100 + 12, 120 + 12), BLUE)).toBe(true)

  // Ctrl+wheel zoom in around the blue note (7 notches: x16 from fit), past the overview's resolution
  const blueScreen = { x: canvasBox.x + blueViewAfter.x, y: canvasBox.y + blueViewAfter.y }
  await page.mouse.move(blueScreen.x, blueScreen.y)
  await page.keyboard.down('Control')
  for (let i = 0; i < 7; i++) await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  const zoomedEarly = await x(page)
  const label = checkpoint.find((e) => e.type === 'text' && e.containerId === 'cp-blue')
  if (!label) throw new Error('no label')
  const labelBox = { x: label.x, y: label.y, w: label.width, h: label.height }
  const darkBeforeDetail = await page.evaluate(
    (r) => ((window.__lobbySpike as { extra: unknown }).extra as PreviewExtra).previewDark(r),
    labelBox,
  )
  await expect.poll(async () => (await x(page)).stats.detailRenders, { timeout: 5000 }).toBeGreaterThan(0)
  const zoomed = await x(page)
  const darkAfterDetail = await page.evaluate(
    (r) => ((window.__lobbySpike as { extra: unknown }).extra as PreviewExtra).previewDark(r),
    labelBox,
  )
  const zoomedPixels = { blue: await pp(page, 150, 150) }
  expect(zoomed.cam.zoom).toBeGreaterThan(fit.cam.zoom * 4)
  expect(zoomedEarly.needsDetail).toBe(true)
  expect(near(zoomedPixels.blue, BLUE)).toBe(true)
  expect(darkAfterDetail).toBeGreaterThan(50)

  // plain wheel pans
  const beforeWheel = await x(page)
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(50)
  const afterWheel = await x(page)
  expect(afterWheel.cam.y).toBeCloseTo(beforeWheel.cam.y + 200 / beforeWheel.cam.zoom, 1)

  // the live board did not change
  const liveAfter = await page.evaluate(() => {
    const spike = window.__lobbySpike
    const extra = spike?.extra as unknown as PreviewExtra
    const s = spike?.api?.getAppState()
    return {
      scroll: [s?.scrollX, s?.scrollY, s?.zoom.value],
      count: spike?.api?.getSceneElements().length,
      ops: extra.probe.ops,
      drift: extra.probe.versionDrift(),
      pixel: extra.livePixel(40 + 12, 60 + 12),
    }
  })
  expect(liveAfter.scroll).toEqual(live.scroll)
  expect(liveAfter.count).toBe(live.count)
  expect(liveAfter.ops).toEqual([])
  expect(liveAfter.drift).toEqual([])
  expect(near(liveAfter.pixel, YELLOW)).toBe(true)
  console.log(
    'A11-METRICS preview',
    JSON.stringify({
      opened,
      editors,
      fit: fit.cam,
      fitPixels,
      panned: panned.cam,
      zoomed: zoomed.cam,
      stats: zoomed.stats,
      darkBeforeDetail,
      darkAfterDetail,
      zoomedPixels,
      live: liveAfter,
      foreign: watch.foreignRequests().length,
      consoleErrors: watch.consoleErrors,
    }),
  )
  expect(watch.foreignRequests()).toEqual([])
  expect(watch.consoleErrors).toEqual([])
})

test('checkpoint preview of the heavy board (20 frames, 4,500 notes with labels, 200 images): overview, fit, zoom-in detail', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const watch = watchPage(page)
  // the heavy scene, built by the heavy page (render-heavy.tsx) and kept on the fixture server
  await openSpike(page, 'render-heavy')
  const built = await page.evaluate(() =>
    (
      (window.__lobbySpike as { extra: unknown }).extra as {
        generate(s: object): { json: string; count: number }
      }
    ).generate({ frames: 20, notes: 4500, images: 200 }),
  )
  files.put('heavy-preview.json', built.json, 'application/json')
  await openSpike(page, 'render-preview')
  const opened = await page.evaluate(async () => {
    const extra = (window.__lobbySpike as { extra: unknown }).extra as PreviewExtra
    const els = (await (await fetch('/files/__spike/heavy-preview.json')).json()) as unknown[]
    const t0 = performance.now()
    const stats = await extra.openPreview(els)
    return { stats, totalMs: Math.round(performance.now() - t0), count: els.length }
  })
  const fit = await x(page)
  // a note of frame 0 (perf-n0-0 at frame 0's grid origin): its fill colour at fit
  const note0 = await page.evaluate(async () => {
    const els = (await (await fetch('/files/__spike/heavy-preview.json')).json()) as {
      id: string
      x: number
      y: number
      backgroundColor: string
    }[]
    const n = els.find((e) => e.id === 'perf-n0-0')
    return n ? { x: n.x, y: n.y, color: n.backgroundColor } : null
  })
  if (!note0) throw new Error('no perf-n0-0')
  const hex = note0.color.replace('#', '')
  const want = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  const fitPixel = await pp(page, note0.x + 100, note0.y + 30)
  // zoom to 1 on that note, wait for the detail pass
  await page.evaluate((n) => {
    const extra = (window.__lobbySpike as { extra: unknown }).extra as PreviewExtra & {
      preview: { setCamera(c: { x: number; y: number; zoom: number }): void }
    }
    extra.preview.setCamera({ x: n.x - 40, y: n.y - 40, zoom: 1 })
  }, note0)
  await expect.poll(async () => (await x(page)).stats.detailRenders, { timeout: 20_000 }).toBeGreaterThan(0)
  const zoomed = await x(page)
  const zoomPixel = await pp(page, note0.x + 100, note0.y + 30)
  console.log(
    'A11-METRICS heavy-preview',
    JSON.stringify({
      opened,
      fit: fit.cam,
      fitPixel,
      zoomed: zoomed.cam,
      stats: zoomed.stats,
      zoomPixel,
      want,
    }),
  )
  expect(opened.count).toBe(built.count)
  expect(near(fitPixel, want, 30)).toBe(true)
  expect(near(zoomPixel, want)).toBe(true)
  expect(watch.foreignRequests()).toEqual([])
})
