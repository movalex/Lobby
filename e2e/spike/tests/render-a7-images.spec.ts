import { expect, type Page, test } from '@playwright/test'
import { colorFor, type FilesServer, fixtureVersion, startFilesServer } from '../fixtures/files-server.ts'
import type { LabExtra, RenderApi } from '../fixtures/render-types.ts'
import { openSpike } from '../support/page.ts'
import { SPIKE_API_ORIGIN } from '../support/ports.ts'
import { watchPage } from '../support/watch.ts'

// A7 (docs/EXCALIDRAW-MIGRATION.md §8.2, E1 in §2.5.5): an image whose URL fails.
//  1. Excalidraw's own path: a file whose URL fails is marked `status: "error"` through newElementWith,
//     which bumps the element's version: a sync adapter would push it (1 op). It is never retried.
//  2. Lobby's loader (apps/web/src/canvas/files/loader.ts), status local-only: the same failure produces
//     0 element changes (0 ops); the loader retries, and the image appears once the URL works.
//  3. 30 images, 150 ms per response, 5 failing: never more than 6 fetches at once, visible first, 25
//     loaded, 0 ops.
// Pass (plan §8.2): 0 ops with Lobby's loader.

let files: FilesServer

test.beforeAll(async () => {
  files = await startFilesServer(Number(new URL(SPIKE_API_ORIGIN).port))
})
test.afterAll(async () => {
  await files?.close()
})
test.beforeEach(() => {
  files.failing.clear()
  files.delayMs = 0
  files.resetStats()
})

const body = (ver: string) => ver.slice(4)
const W = 320
const H = 200

/** Image elements (status 'saved', as the server stores them), applied like a server scene. */
async function applyImages(page: Page, items: { ver: string; x: number; y: number }[]) {
  await page.evaluate(
    ({ items, W, H }) => {
      const extra = window.__lobbySpike?.extra as unknown as LabExtra
      const els = extra.engine.convertToExcalidrawElements(
        items.map((it, i) => ({
          type: 'image',
          id: `img-${i}`,
          x: it.x,
          y: it.y,
          width: W,
          height: H,
          fileId: it.ver,
        })),
        { regenerateIds: false },
      )
      extra.probe.applyServer(els.map((e) => ({ ...e, status: 'saved' })))
    },
    { items, W, H },
  )
}

const state = (page: Page) =>
  page.evaluate(() => {
    const spike = window.__lobbySpike
    if (!spike?.api) throw new Error('no api')
    const extra = spike.extra as unknown as LabExtra
    const images = spike.api.getSceneElementsIncludingDeleted().filter((e) => e.type === 'image')
    return {
      ops: extra.probe.ops,
      unknown: [...extra.probe.unknown],
      drift: extra.probe.versionDrift(),
      onChange: extra.probe.onChangeCalls,
      images: images.map((e) => ({ id: e.id, version: e.version, status: e.status as string })),
    }
  })

const loaderInfo = (page: Page) =>
  page.evaluate(() => {
    const extra = window.__lobbySpike?.extra as unknown as LabExtra
    return { states: extra.loader().states(), stats: { ...extra.loader().stats } }
  })

/** RGB of the image's fill (away from the diagonal band, the border and the placeholder icon). */
const fillPixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).pixel(x, y),
    [x + 0.8 * W, y + 0.2 * H] as const,
  )

/** The browser logs every failed fetch ("Failed to load resource: … 404"): the failures are on purpose. */
const unexpectedErrors = (errors: string[]) =>
  errors.filter((e) => !/Failed to load resource: the server responded with a status of 404/.test(e))

const near = (a: number[] | null, b: readonly number[], tol = 12) =>
  !!a && b.every((c, i) => Math.abs((a[i] ?? -999) - c) <= tol)

/** Excalidraw's pending/error placeholder fill in the light theme (element drawImagePlaceholder). */
const PLACEHOLDER = [0xe7, 0xe7, 0xe7]

async function addFileAsExcalidrawWould(page: Page, ver: string) {
  await page.evaluate((ver) => {
    const spike = window.__lobbySpike
    const extra = spike?.extra as unknown as LabExtra
    ;((spike as { api: unknown }).api as RenderApi).addFiles([
      { id: ver, mimeType: 'image/png', dataURL: extra.fixtureUrl(ver, 'thumb'), created: Date.now() },
    ])
  }, ver)
}

test("Excalidraw's own path: a failing URL marks the image status error, bumps its version, never retries", async ({
  page,
}) => {
  const watch = watchPage(page)
  const ver = fixtureVersion(1, 'ex')
  files.failing.add(body(ver))
  await openSpike(page, 'render-lab')
  await applyImages(page, [{ ver, x: 100, y: 100 }])
  const before = await state(page)
  expect(before.images.map((i) => i.status)).toEqual(['saved'])

  // What Excalidraw's own paths do (insert, paste, restore): hand the engine a file, here one whose URL
  // fails, and let updateImageCache load it.
  await addFileAsExcalidrawWould(page, ver)
  await expect.poll(async () => (await state(page)).images[0]?.status).toBe('error')
  const after = await state(page)
  expect(after.ops).toHaveLength(1)
  expect(after.ops[0]?.fields).toEqual(['status'])
  expect(after.ops[0]?.to ?? 0).toBeGreaterThan(after.ops[0]?.from ?? 0)
  // the version moved from the applied copy (the probe counted it in onChange, so no unseen drift)
  expect(after.images[0]?.version).toBe(after.ops[0]?.to)
  expect(after.images[0]?.version).toBeGreaterThan(before.images[0]?.version ?? Number.POSITIVE_INFINITY)

  // Never retried: the URL starts working and the same file is added again: nothing is requested.
  const requestsAtError = files.stats.perVersion.get(body(ver)) ?? 0
  files.failing.clear()
  await addFileAsExcalidrawWould(page, ver)
  await page.waitForTimeout(3000)
  const final = await state(page)
  expect(final.images[0]?.status).toBe('error')
  expect(files.stats.perVersion.get(body(ver)) ?? 0).toBe(requestsAtError)
  console.log(
    'A7-METRICS own-path',
    JSON.stringify({
      op: after.ops[0],
      requestsAtError,
      requestsAfterReAdd: files.stats.perVersion.get(body(ver)) ?? 0,
      statusAfterUrlFixed: final.images[0]?.status,
      foreign: watch.foreignRequests().length,
    }),
  )
  expect(watch.foreignRequests()).toEqual([])
})

test("Lobby's loader: the same failure changes no element (0 ops); it retries and the image appears once the URL works", async ({
  page,
}) => {
  const watch = watchPage(page)
  const ver = fixtureVersion(2, 'lb')
  files.failing.add(body(ver))
  await openSpike(page, 'render-lab')
  await applyImages(page, [{ ver, x: 100, y: 100 }])
  const t0 = Date.now()
  await page.evaluate(() => {
    const spike = window.__lobbySpike
    const extra = spike?.extra as unknown as LabExtra
    extra.loader().syncScene(spike?.api?.getSceneElements() ?? [])
  })
  // Attempts at about 0, 1, 3 and 7 s (retries after 1, 2 and 4 s).
  await expect
    .poll(() => files.stats.perVersion.get(body(ver)) ?? 0, { timeout: 12_000 })
    .toBeGreaterThanOrEqual(4)
  const whileFailing = await state(page)
  const loaderFailing = await loaderInfo(page)
  expect(whileFailing.ops).toEqual([])
  expect(whileFailing.drift).toEqual([])
  expect(whileFailing.unknown).toEqual([])
  expect(whileFailing.images[0]?.status).toBe('saved')
  expect(loaderFailing.states.loaded).toBe(0)
  expect(loaderFailing.stats.failures).toBeGreaterThanOrEqual(4)
  const placeholder = await fillPixel(page, 100, 100)
  expect(near(placeholder, PLACEHOLDER, 6)).toBe(true)

  // The URL starts working: the next retry (8 s after the fourth attempt) loads it.
  files.failing.clear()
  await expect.poll(async () => (await loaderInfo(page)).states.loaded, { timeout: 20_000 }).toBe(1)
  const loadedAfterMs = Date.now() - t0
  await expect.poll(async () => near(await fillPixel(page, 100, 100), colorFor(body(ver)))).toBe(true)
  const loaded = await state(page)
  expect(loaded.ops).toEqual([])
  expect(loaded.drift).toEqual([])
  expect(loaded.images[0]?.status).toBe('saved')
  const dataUrls = await page.evaluate(() =>
    Object.values(((window.__lobbySpike as { api: unknown }).api as RenderApi).getFiles()).map((f) =>
      f.dataURL.slice(0, 5),
    ),
  )
  expect(dataUrls).toEqual(['blob:'])
  console.log(
    'A7-METRICS loader-failure',
    JSON.stringify({
      loaderWhileFailing: loaderFailing,
      requestsTotal: files.stats.perVersion.get(body(ver)),
      loadedAfterMs,
      ops: loaded.ops.length,
      drift: loaded.drift.length,
      onChangeCalls: loaded.onChange,
      placeholder,
      foreign: watch.foreignRequests().length,
      consoleErrors: watch.consoleErrors.length,
    }),
  )
  expect(watch.foreignRequests()).toEqual([])
  expect(unexpectedErrors(watch.consoleErrors)).toEqual([])
})

test("Lobby's loader: 30 images, 5 failing, 150 ms responses: at most 6 fetches at once, visible first, 0 ops", async ({
  page,
}) => {
  const watch = watchPage(page)
  // the order in which the page starts its image fetches (the server's arrival order can differ)
  await page.addInitScript(() => {
    const log: string[] = []
    Object.defineProperty(window, '__fetchLog', { value: log })
    const orig = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/files/')) log.push(url)
      return orig(input, init)
    }
  })
  await openSpike(page, 'render-lab')
  // 5 rows of 6, rows 1,000 units apart: at zoom 1 only part of row 0 is on screen.
  const items = Array.from({ length: 30 }, (_, i) => ({
    ver: fixtureVersion(100 + i, 'cc'),
    x: (i % 6) * 360,
    y: Math.floor(i / 6) * 1000,
  }))
  const failing = [3, 11, 17, 22, 29]
  for (const i of failing) files.failing.add(body(items[i]?.ver ?? ''))
  files.delayMs = 150
  await applyImages(page, items)
  const visible = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const spike = window.__lobbySpike
        const api = spike?.api
        if (!api) throw new Error('no api')
        api.updateScene({ appState: { scrollX: 40, scrollY: 20, zoom: { value: 1 } } })
        requestAnimationFrame(() => {
          const extra = spike.extra as unknown as LabExtra
          const ids = extra.visibleFileIds()
          extra.loader().syncScene(api.getSceneElements(), new Set(ids))
          resolve(ids)
        })
      }),
  )
  expect(visible.length).toBeGreaterThan(0)
  expect(visible.length).toBeLessThan(6)
  await expect.poll(async () => (await loaderInfo(page)).states.loaded, { timeout: 25_000 }).toBe(25)
  const loader = await loaderInfo(page)
  const dispatched = await page.evaluate(() =>
    (window as unknown as { __fetchLog: string[] }).__fetchLog.slice(),
  )
  const order = dispatched.map((u) => /ver_([0-9A-Za-z]+)/.exec(u)?.[1] ?? '')
  const visibleBodies = new Set(visible.map(body))
  const firstRequests = order.slice(0, visible.length)
  const s = await state(page)
  console.log(
    'A7-METRICS concurrency',
    JSON.stringify({
      clientMaxInFlight: loader.stats.maxInFlight,
      serverMaxInFlight: files.stats.maxInFlight,
      visible: visible.length,
      firstRequestsVisible: firstRequests.filter((b) => visibleBodies.has(b)).length,
      loader,
      imageRequests: files.stats.imageRequests,
      ops: s.ops.length,
      drift: s.drift.length,
    }),
  )
  expect(loader.stats.maxInFlight).toBeLessThanOrEqual(6)
  expect(files.stats.maxInFlight).toBeLessThanOrEqual(6)
  expect(files.stats.maxInFlight).toBe(6) // the cap is reached: 30 queued, 150 ms each
  expect(firstRequests.every((b) => visibleBodies.has(b))).toBe(true)
  expect(s.ops).toEqual([])
  expect(s.drift).toEqual([])
  expect(s.images.every((i) => i.status === 'saved')).toBe(true)
  // pixels: two loaded images and one failing one (placeholder)
  await page.evaluate(() => {
    window.__lobbySpike?.api?.updateScene({ appState: { scrollX: 20, scrollY: 20, zoom: { value: 0.5 } } })
  })
  await page.waitForTimeout(400)
  for (const i of [0, 7]) {
    const it = items[i]
    if (!it) continue
    expect(near(await fillPixel(page, it.x, it.y), colorFor(body(it.ver))), `image ${i} painted`).toBe(true)
  }
  const bad = items[3]
  if (bad) expect(near(await fillPixel(page, bad.x, bad.y), PLACEHOLDER, 6)).toBe(true)
  expect(watch.foreignRequests()).toEqual([])
  expect(unexpectedErrors(watch.consoleErrors)).toEqual([])
})
