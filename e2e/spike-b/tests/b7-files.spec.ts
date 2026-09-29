// B7 (docs/EXCALIDRAW-MIGRATION.md §8.3): an uploaded image and a file card, with no base64 stored. B7
// runs on the fs blob store (the stack's default): spike B never writes to the staging R2 bucket.
//
// | Case | Pass |
// | Upload an image and a PDF through /api; both browsers render them (pixel probe) | rendered in A and B |
// | The internal snapshot | no data:, no blob:, no signed URL; every fileId ^ver_; status 'saved' |
// | The file card | an image face with chips; double-click opens the PDF viewer; customData.lobby.file equals the api's record |
// | Network | only same-origin GET /files/… for bytes; no request to a foreign host |
// | Failure injection: B's derivative returns 404 | B shows Lobby's placeholder, retries, and pushes 0 ops |
// | Exports | PNG contains the image; the SVG export renders with the network off |
// | Mood board: 200 images | fetches never exceed 6 at once; memory and derivative upgrades reported |
//
// Two Chromium processes (A, B), one stack (SPIKE_B_PORT_BASE; O5's is 7910). Evidence:
// docs/research/excalidraw/spike-b/B7.md.
import { expect, type Request, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import { stackFromEnv } from '../support/ports.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import {
  centreOf,
  create,
  featuresReady,
  near,
  pdfBase64,
  saved,
  seen,
  solidPng,
  staticPixel,
} from './b7-b12-kit.ts'

test.describe.configure({ mode: 'serial' })

const RED: [number, number, number] = [220, 40, 40]
const PDF_BLUE = [51, 102, 230]
const PORTS = stackFromEnv()
const SAME_ORIGIN = new URL(PORTS.webUrl).origin
const MOOD = Number(process.env.SPIKE_B7_MOOD ?? 200)

let stack: SpikeBStack
let A: BrowserProcess
let B: BrowserProcess
let boardId: string
let image: { elementId: string; versionId: string; assetId: string }
let pdf: { elementId: string; versionId: string; assetId: string; pageCount: number | null }
const requests: { who: string; url: string; method: string; type: string }[] = []

const track = (who: string, r: Request) =>
  requests.push({ who, url: r.url(), method: r.method(), type: r.resourceType() })

test.beforeAll(async () => {
  stack = await harness.startStack({ base: PORTS.base })
  const alice = harness.devUser('b7-alice')
  const bob = harness.devUser('b7-bob')
  ;({ boardId } = await stack.createBoard({ owner: alice, members: [{ user: bob, role: 'editor' }] }))
  A = await harness.launchBrowser(stack, alice, { name: 'A' })
  B = await harness.launchBrowser(stack, bob, { name: 'B' })
  A.page.on('request', (r) => track('A', r))
  B.page.on('request', (r) => track('B', r))
  await A.openBoard(boardId)
  await B.openBoard(boardId)
  await featuresReady(A.page)
  await featuresReady(B.page)
})

test.afterAll(async () => {
  await B?.close()
  await A?.close()
  await stack?.stop()
})

test('upload an image and a PDF through /api; both browsers render them', async () => {
  const png = await solidPng(A.page, RED, 64, 48)
  image = (await A.page.evaluate(
    (b64) => window.lobbySpikeFeatures?.upload(b64, 'red.png', 'image/png', { at: { x: 200, y: 200 } }),
    png,
  )) as typeof image
  pdf = (await A.page.evaluate(
    (b64) =>
      window.lobbySpikeFeatures?.upload(b64, 'deck.pdf', 'application/pdf', { at: { x: 600, y: 260 } }),
    await pdfBase64(2),
  )) as typeof pdf
  expect(image.versionId).toMatch(/^ver_/)
  expect(pdf.versionId).toMatch(/^ver_/)
  await saved(A.page)
  await seen([B], image.elementId)
  await seen([B], pdf.elementId)
  for (const p of [A, B]) {
    const ic = await centreOf(p.page, image.elementId)
    await expect
      .poll(async () => near(await staticPixel(p.page, ic.x, ic.y), RED), { timeout: 60_000 })
      .toBe(true)
    // the PDF card's face: the worker's cover, blue away from the title text
    const c = await centreOf(p.page, pdf.elementId)
    await expect
      .poll(async () => near(await staticPixel(p.page, c.x, c.y + 60), PDF_BLUE, 40), { timeout: 60_000 })
      .toBe(true)
  }
})

test('the internal snapshot: no data:, blob: or signed URL; every fileId ^ver_; status saved', async () => {
  const snap = await harness.readSnapshot(stack, boardId)
  const text = JSON.stringify(snap.elements)
  expect(text).not.toMatch(/data:/)
  expect(text).not.toMatch(/blob:/)
  expect(text).not.toMatch(/X-Amz-|Signature=|\/files\//)
  const images = snap.elements.filter((e) => e.type === 'image') as { fileId?: string; status?: string }[]
  expect(images.length).toBeGreaterThanOrEqual(2)
  for (const e of images) {
    expect(e.fileId).toMatch(/^ver_[0-9A-Za-z]{10,40}(\.p[1-9][0-9]{0,3})?$/)
    expect(e.status ?? 'saved').toBe('saved')
  }
})

test('the file card: an image face with chips; double-click opens the PDF viewer; its facts equal the api record', async () => {
  await expect(B.page.locator(`[data-lobby-card-chip="${pdf.elementId}"]`)).toHaveAttribute(
    'data-kind',
    'pdf',
  )
  const facts = await B.page.evaluate(
    (id) => (window.lobbyCanvas?.get(id)?.customData?.lobby as { file?: unknown } | undefined)?.file,
    pdf.elementId,
  )
  const record = await B.page.evaluate(
    async ({ bid, ast, ver }) =>
      (await fetch(`/api/boards/${bid}/assets/${ast}/${ver}`, { cache: 'no-store' })).json(),
    { bid: boardId, ast: pdf.assetId, ver: pdf.versionId },
  )
  expect(facts).toEqual({
    assetId: record.assetId,
    versionId: record.versionId,
    kind: record.kind,
    name: record.name,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
  })
  const pushes = await harness.recordPushes(B.page)
  const c = await centreOf(B.page, pdf.elementId)
  await B.page.mouse.dblclick(c.x, c.y)
  await expect(B.page.locator('[data-lobby-pdf-viewer]')).toHaveAttribute(
    'data-lobby-pdf-viewer',
    pdf.versionId,
  )
  await expect(B.page.locator('[data-lobby-pdf-page]')).toHaveCount(2, { timeout: 30_000 })
  expect(await B.page.evaluate(() => window.lobbySpikeFeatures?.viewer())).toBe(pdf.versionId)
  await B.page.locator('[data-lobby-pdf-close]').click()
  // opening the card changed nothing (no cropping, no edit)
  expect(await pushes.count()).toBe(0)
})

test('network: bytes only from same-origin GET /files/…; no foreign host', async () => {
  const foreign = requests.filter((r) => {
    const u = new URL(r.url)
    return (
      (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:') &&
      u.origin !== SAME_ORIGIN
    )
  })
  expect(foreign).toEqual([])
  const bytes = requests.filter((r) => r.url.includes('/files/'))
  expect(bytes.length).toBeGreaterThan(0)
  for (const r of bytes) {
    expect(r.method).toBe('GET')
    expect(new URL(r.url).origin).toBe(SAME_ORIGIN)
  }
  // the canvas never loads a raster original (derivatives only, §2.10.3)
  expect(bytes.filter((r) => r.url.includes(`/${image.versionId}/original`))).toEqual([])
  console.log(
    'B7-METRICS network',
    JSON.stringify({ requests: requests.length, files: bytes.length, foreign: foreign.length }),
  )
})

test("failure injection: B's derivatives answer 404: placeholder, retries, 0 ops; then it loads", async () => {
  await B.page.route('**/files/*/*/d/**', (route) => route.fulfill({ status: 404, body: 'no' }))
  await B.openBoard(boardId)
  await featuresReady(B.page)
  const pushes = await harness.recordPushes(B.page)
  await expect(B.page.locator(`[data-lobby-image-placeholder="${image.elementId}"]`)).toBeVisible({
    timeout: 15_000,
  })
  await expect
    .poll(
      async () => (await B.page.evaluate(() => window.lobbySpikeFeatures?.loader()))?.stats.failures ?? 0,
      {
        timeout: 20_000,
      },
    )
    .toBeGreaterThanOrEqual(4) // 2 files × (first try + a retry at 1 s)
  const during = await B.page.evaluate(() => window.lobbySpikeFeatures?.loader())
  expect(during?.stats.retries).toBeGreaterThanOrEqual(2)
  expect(await pushes.count()).toBe(0)
  await B.page.unroute('**/files/*/*/d/**')
  const c = await centreOf(B.page, image.elementId)
  await expect
    .poll(async () => near(await staticPixel(B.page, c.x, c.y), RED), { timeout: 60_000 })
    .toBe(true)
  await expect(B.page.locator(`[data-lobby-image-placeholder="${image.elementId}"]`)).toHaveCount(0)
  expect(await pushes.count()).toBe(0)
  console.log(
    'B7-METRICS failure',
    JSON.stringify({
      during: during?.stats,
      after: (await B.page.evaluate(() => window.lobbySpikeFeatures?.loader()))?.stats,
    }),
  )
})

test('exports: the PNG contains the image; the SVG renders with the network off, with no eval', async ({
  browser,
}) => {
  // a text to exercise Lobby's @font-face (Nunito, family 6)
  const textId = await create(A.page, 'text', {
    x: 120,
    y: 420,
    text: 'Font check Äé',
    fontFamily: 6,
    fontSize: 28,
  })
  await saved(A.page)
  const png = await A.page.evaluate((id) => window.lobbySpikeFeatures?.exportPng([id]), image.elementId)
  expect(png?.bytes ?? 0).toBeGreaterThan(100)
  const pngCentre = await A.page.evaluate(async (url) => {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    ctx?.drawImage(img, 0, 0)
    return [...(ctx?.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data ?? [])]
  }, png?.dataUrl ?? '')
  expect(near(pngCentre, RED)).toBe(true)

  // count eval-like calls (new Function / eval) in the page while the SVG export runs
  await A.page.evaluate(() => {
    const w = window as unknown as {
      __evalCalls: number
      Function: FunctionConstructor
      eval: (s: string) => unknown
    }
    w.__evalCalls = 0
    const F = w.Function
    w.Function = new Proxy(F, {
      apply: (t, self, args) => {
        w.__evalCalls++
        return Reflect.apply(t, self, args)
      },
      construct: (t, args) => {
        w.__evalCalls++
        return Reflect.construct(t, args)
      },
    })
  })
  const before = requests.length
  const svg = await A.page.evaluate(({ ids }) => window.lobbySpikeFeatures?.exportSvg(ids), {
    ids: [image.elementId, textId],
  })
  const evalCalls = await A.page.evaluate(() => (window as unknown as { __evalCalls: number }).__evalCalls)
  expect(evalCalls).toBe(0)
  expect(requests.slice(before).filter((r) => /subset|chunk-Z5NKEFVG|esm\.sh/.test(r.url))).toEqual([])
  expect(svg?.text).toContain('@font-face')
  expect(svg?.text).toMatch(/data:font\/woff2;base64,/)
  expect(svg?.text).not.toMatch(/blob:|\/files\//)
  expect(svg?.embeddedFiles).toContain(image.versionId)

  // open it in a fresh context with every request aborted
  const ctx = await browser.newContext()
  const offline = await ctx.newPage()
  let attempted = 0
  await ctx.route('**/*', (route) => {
    attempted++
    return route.abort()
  })
  await offline.setContent(
    `<!doctype html><html><body style="margin:0;background:#fff">${svg?.text ?? ''}</body></html>`,
  )
  await offline.evaluate(() => document.fonts.ready)
  const fontsLoaded = await offline.evaluate(() =>
    [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')),
  )
  expect(fontsLoaded).toContain('Nunito')
  const box = await offline.locator('svg image').first().boundingBox()
  expect(box).not.toBeNull()
  const shot = await offline.screenshot({
    clip: {
      x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
      y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
      width: 1,
      height: 1,
    },
  })
  const rgb = await offline.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    const g = c.getContext('2d')
    g?.drawImage(img, 0, 0)
    return [...(g?.getImageData(0, 0, 1, 1).data ?? [])]
  }, shot.toString('base64'))
  expect(near(rgb, RED)).toBe(true)
  expect(attempted).toBe(0)
  await ctx.close()
  console.log(
    'B7-METRICS export',
    JSON.stringify({
      svgBytes: svg?.bytes,
      fonts: svg?.embeddedFonts.length,
      pngBytes: png?.bytes,
      evalCalls,
    }),
  )
})

test(`mood board: ${MOOD} images; fetches never exceed 6 at once; memory and derivative upgrades reported`, async () => {
  test.setTimeout(15 * 60_000)
  const png = await solidPng(A.page, [40, 160, 90], 32, 32)
  // two uploaders, each under the api's 120 uploads per minute and person
  const half = Math.ceil(MOOD / 2)
  const place = (p: BrowserProcess, from: number, to: number) =>
    p.page.evaluate(
      async ({ b64, from, to }) => {
        const ids: string[] = []
        for (let i = from; i < to; i++) {
          const r = await window.lobbySpikeFeatures?.upload(b64, `mood-${i}.png`, 'image/png', {
            at: { x: 1400 + (i % 20) * 90, y: 100 + Math.floor(i / 20) * 90 },
            waitMs: 0,
          })
          if (r) ids.push(r.elementId)
        }
        return ids
      },
      { b64: png, from, to },
    )
  const ids = [...(await place(A, 0, half)), ...(await place(B, half, MOOD))]
  expect(ids).toHaveLength(MOOD)
  await saved(A.page)
  await saved(B.page)

  // a third look: B reloads at a fit that shows the whole mood board; count /files/ fetches in flight
  let inFlight = 0
  let maxInFlight = 0
  const fileReq = (r: Request) => r.url().includes('/files/') && r.url().includes('/d/')
  B.page.on('request', (r) => {
    if (fileReq(r)) maxInFlight = Math.max(maxInFlight, ++inFlight)
  })
  const done = (r: Request) => {
    if (fileReq(r)) inFlight--
  }
  B.page.on('requestfinished', done)
  B.page.on('requestfailed', done)
  const t0 = Date.now()
  await B.openBoard(boardId)
  await featuresReady(B.page)
  await B.page.evaluate(() => window.lobbyCanvas?.zoomToFit())
  const heap0 = await B.page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  )
  await expect
    .poll(
      async () => (await B.page.evaluate(() => window.lobbySpikeFeatures?.loader()))?.states.loaded ?? 0,
      {
        timeout: 10 * 60_000,
        intervals: [1_000],
      },
    )
    .toBeGreaterThanOrEqual(MOOD + 2) // the mood board, the first image and the PDF card's face
  const loadMs = Date.now() - t0
  const loader = await B.page.evaluate(() => window.lobbySpikeFeatures?.loader())
  const heap1 = await B.page.evaluate(
    () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
  )
  expect(maxInFlight).toBeLessThanOrEqual(6)
  expect(loader?.stats.maxInFlight ?? 99).toBeLessThanOrEqual(6)
  console.log(
    'B7-METRICS mood',
    JSON.stringify({
      images: MOOD,
      loadMs,
      maxInFlightNetwork: maxInFlight,
      loader: loader?.stats,
      heapMB: [heap0, heap1].map((b) => Math.round((b / 1048576) * 10) / 10),
      derivativeUpgrades: 0, // opt-in until O2's adapter strips the @display suffix (E9)
    }),
  )
})
