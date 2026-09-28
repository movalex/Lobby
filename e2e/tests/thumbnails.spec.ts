// Wave 3 "thumbnails" (docs/WAVE3-CONTRACTS.md): an editor's client captures the board for its dashboard
// card, and only people who can edit (never viewers, commenters or guests) can upload one. Everything is
// driven through the real UI and the real api; the server's answers are checked through the API too.
import { crc32, deflateSync } from 'node:zlib'
import type { APIRequestContext, Locator, Page, Request } from '@playwright/test'
import { edit, type Session } from './support/board.ts'
import { richText } from './support/editor.ts'
import { expect, test } from './support/fixtures.ts'
import { WEB_URL } from './support/ports.ts'
import { capture } from './support/screenshots.ts'
import { THEME_KEY } from './support/theme.ts'

const THUMB_MAX_BYTES = 200 * 1024
const captureState = (page: Page) => page.getByTestId('thumbnail-capture')
const card = (page: Page, boardId: string) =>
  page.locator(`[data-testid="board-card"][data-board-id="${boardId}"]`)

/** A few notes, a filled shape and some text: something a thumbnail has to show. */
async function drawSomething(page: Page, label: string) {
  await edit(
    page,
    (ed, a) => {
      ed.createShapes([
        { type: 'note', x: 0, y: 0, props: { color: 'yellow', richText: a.one } },
        { type: 'note', x: 260, y: 0, props: { color: 'orange', richText: a.two } },
        { type: 'note', x: 520, y: 40, props: { color: 'light-blue', richText: a.three } },
        {
          type: 'geo',
          x: 0,
          y: 280,
          props: { geo: 'rectangle', w: 760, h: 160, color: 'violet', fill: 'solid' },
        },
      ])
    },
    { one: richText(`${label} one`), two: richText('Two'), three: richText('Three') },
  )
}

/** The image as the browser decoded it, and how many distinct colours it has (not a blank rectangle). */
async function decoded(img: Locator) {
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
      timeout: 15_000,
    })
    .toBe(true)
  return img.evaluate(async (el: HTMLImageElement) => {
    await el.decode()
    const c = document.createElement('canvas')
    c.width = el.naturalWidth
    c.height = el.naturalHeight
    const g = c.getContext('2d')
    if (!g) throw new Error('no 2d context')
    g.drawImage(el, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    const colours = new Set<number>()
    for (let i = 0; i < d.length; i += 4)
      colours.add(((d[i] ?? 0) << 16) | ((d[i + 1] ?? 0) << 8) | (d[i + 2] ?? 0))
    return { width: el.naturalWidth, height: el.naturalHeight, colours: colours.size }
  })
}

/**
 * How much of the decoded image the drawing covers: the bounding box of the pixels that differ from the
 * top-left pixel (the canvas around the content), as fractions of the image's width and height.
 */
async function coverage(img: Locator) {
  await decoded(img)
  return img.evaluate(async (el: HTMLImageElement) => {
    await el.decode()
    const c = document.createElement('canvas')
    c.width = el.naturalWidth
    c.height = el.naturalHeight
    const g = c.getContext('2d')
    if (!g) throw new Error('no 2d context')
    g.drawImage(el, 0, 0)
    const d = g.getImageData(0, 0, c.width, c.height).data
    const bg = [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0]
    let minX = c.width
    let minY = c.height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        const diff = Math.max(
          Math.abs((d[i] ?? 0) - (bg[0] ?? 0)),
          Math.abs((d[i + 1] ?? 0) - (bg[1] ?? 0)),
          Math.abs((d[i + 2] ?? 0) - (bg[2] ?? 0)),
        )
        if (diff <= 16) continue
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    return maxX < 0 ? { w: 0, h: 0 } : { w: (maxX - minX + 1) / c.width, h: (maxY - minY + 1) / c.height }
  })
}

async function listedVersion(request: APIRequestContext, workspaceId: string, boardId: string) {
  const res = await request.get(`/api/workspaces/${workspaceId}/boards`)
  expect(res.status()).toBe(200)
  const boards = (await res.json()).boards as { id: string; thumbnailVersion?: string | null }[]
  return boards.find((b) => b.id === boardId)?.thumbnailVersion
}

/** Records the thumbnail uploads (PUT) a page makes. */
function recordUploads(page: Page): Request[] {
  const puts: Request[] = []
  page.on('request', (r) => {
    if (r.method() === 'PUT' && /\/api\/boards\/[^/]+\/thumbnail$/.test(new URL(r.url()).pathname))
      puts.push(r)
  })
  return puts
}

/** A small, real PNG (solid colour). */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.from(type, 'ascii')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head, data])) >>> 0)
    return Buffer.concat([len, head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3, 0x80)
  row[0] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const putThumbnail = (request: APIRequestContext, boardId: string, bytes: Buffer) =>
  request.fetch(`/api/boards/${boardId}/thumbnail`, {
    method: 'PUT',
    headers: { origin: WEB_URL, 'content-type': 'image/png' },
    data: bytes,
  })

async function backToDashboard(s: Session) {
  await s.page.getByRole('link', { name: 'Back to Dev Studio' }).click()
  await expect(s.page.getByTestId('dashboard')).toBeVisible()
}

test('thumbnails: an edited board shows its thumbnail on the dashboard card', async ({
  session,
  board,
  users,
}, testInfo) => {
  const alice = await session('alice')
  const { page } = alice
  const uploads = recordUploads(page)
  await expect(captureState(page)).toHaveAttribute('data-state', 'idle')

  await test.step('edit; a few seconds after the changes settle, the image is rendered (not yet sent)', async () => {
    await drawSomething(page, 'Launch plan')
    await expect(captureState(page)).toHaveAttribute('data-state', 'rendered', { timeout: 20_000 })
    // Four shapes: tldraw's own export (text included).
    await expect(captureState(page)).toHaveAttribute('data-renderer', 'detailed')
    const ms = Number(await captureState(page).getAttribute('data-render-ms'))
    testInfo.annotations.push({ type: 'render-ms', description: String(ms) })
    expect(uploads).toHaveLength(0)
  })

  const dashboard = await test.step('back to the dashboard: the card shows the board', async () => {
    await backToDashboard(alice)
    const img = card(page, board).getByTestId('board-thumbnail')
    await expect(img).toBeVisible({ timeout: 15_000 })
    expect(uploads).toHaveLength(1)
    const version = await img.getAttribute('data-version')
    expect(version).toMatch(/^[0-9a-f]{24}$/)
    const shown = await decoded(img)
    expect(shown.width).toBeLessThanOrEqual(480)
    expect(shown.height).toBeLessThanOrEqual(300)
    expect(shown.width / shown.height).toBeCloseTo(1.6, 1)
    expect(shown.colours, 'the thumbnail has content, not a blank rectangle').toBeGreaterThan(8)
    return { img, version: version ?? '' }
  })

  await test.step('the api stores a WebP under 200 KB, served with safe headers; lists carry the version', async () => {
    expect(await listedVersion(page.request, users.devStudioId, board)).toBe(dashboard.version)
    const res = await page.request.get(`/api/boards/${board}/thumbnail?v=${dashboard.version}`)
    expect(res.status()).toBe(200)
    const headers = res.headers()
    expect(headers['content-type']).toBe('image/webp')
    expect(headers['x-content-type-options']).toBe('nosniff')
    expect(headers['content-security-policy']).toMatch(/^sandbox\b/)
    expect(headers.etag).toBe(`"${dashboard.version}"`)
    expect(headers['cache-control']).toBe('private, max-age=2592000, immutable')
    const body = await res.body()
    expect(body.length).toBeLessThanOrEqual(THUMB_MAX_BYTES)
    expect(body.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(body.subarray(8, 12).toString('ascii')).toBe('WEBP')
  })

  await test.step('screenshots: light, dark and 390 px wide', async () => {
    await capture('thumbnails-card-light.png', card(page, board), testInfo)
    await page.evaluate(([key]) => localStorage.setItem(key as string, 'dark'), [THEME_KEY])
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const img = card(page, board).getByTestId('board-thumbnail')
    await expect(img).toHaveAttribute('data-version', dashboard.version)
    await decoded(img)
    // The card keeps the theme's own surfaces around the (light) board image.
    expect(await img.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(23, 26, 32)')
    await capture('thumbnails-card-dark.png', card(page, board), testInfo)
    await page.setViewportSize({ width: 390, height: 844 })
    await card(page, board).scrollIntoViewIfNeeded()
    const box = await card(page, board).boundingBox()
    expect(box?.width ?? 999).toBeLessThanOrEqual(390)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    await decoded(img)
    await capture('thumbnails-dashboard-390.png', page, testInfo)
  })
})

test('thumbnails: the open board sends its thumbnail once changes settle, and again when the tab is hidden', async ({
  session,
  board,
}) => {
  const alice = await session('alice')
  const { page } = alice
  const uploads = recordUploads(page)

  const first = await test.step('20 s after the last change, without leaving the board', async () => {
    await drawSomething(page, 'Settle')
    const edited = Date.now()
    const res = await page.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/boards/${board}/thumbnail`),
      { timeout: 45_000 },
    )
    expect(res.status()).toBe(200)
    expect(Date.now() - edited).toBeGreaterThanOrEqual(19_000)
    const version = ((await res.json()) as { thumbnail: { version: string } }).thumbnail.version
    await expect(captureState(page)).toHaveAttribute('data-state', 'uploaded')
    await expect(captureState(page)).toHaveAttribute('data-version', version)
    return { version, at: Date.now() }
  })

  await test.step('nothing changes: nothing more is sent', async () => {
    await page.waitForTimeout(5_000)
    expect(uploads).toHaveLength(1)
  })

  await test.step('a change, then at once the tab is hidden: rendered and sent right away', async () => {
    // The api takes one upload per board per 30 s; the client does not even try inside it.
    await page.waitForTimeout(Math.max(0, first.at + 31_000 - Date.now()))
    await edit(page, (ed) => {
      ed.createShape({
        type: 'geo',
        x: 900,
        y: 0,
        props: { geo: 'ellipse', w: 200, h: 200, color: 'red', fill: 'solid' },
      })
    })
    // Not rendered yet (that waits for 3 quiet seconds): hiding the tab renders it now.
    await expect(captureState(page)).toHaveAttribute('data-state', 'uploaded')
    const sent = page.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/boards/${board}/thumbnail`),
      { timeout: 10_000 },
    )
    const hiddenAt = Date.now()
    // Playwright cannot hide a page for real: report "hidden" the way the browser would.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const res = await sent
    expect(res.status()).toBe(200)
    expect(Date.now() - hiddenAt).toBeLessThan(10_000)
    const version = ((await res.json()) as { thumbnail: { version: string } }).thumbnail.version
    expect(version).not.toBe(first.version)
    const meta = await page.request.get(`/api/boards/${board}/thumbnail/meta`)
    expect(((await meta.json()) as { thumbnail: { version: string } }).thumbnail.version).toBe(version)
    expect(uploads).toHaveLength(2)
  })
})

test('thumbnails: a large board gets a simplified thumbnail without stalling the canvas', async ({
  session,
  board,
}, testInfo) => {
  const alice = await session('alice')
  const { page } = alice
  await edit(
    page,
    (ed, a) => {
      const shapes: Record<string, unknown>[] = [
        { type: 'frame', x: -80, y: -80, props: { w: 2600, h: 1300, name: 'Brainstorm' } },
      ]
      for (let i = 0; i < 200; i++)
        shapes.push({
          type: 'note',
          x: (i % 20) * 120,
          y: Math.floor(i / 20) * 120,
          props: { color: ['yellow', 'orange', 'green', 'light-blue'][i % 4], richText: a.text, size: 's' },
        })
      ed.createShapes(shapes)
    },
    { text: richText('An idea') },
  )
  // Long main-thread tasks from now on (creating 200 notes above is the canvas's own work).
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] }
    w.__longTasks = []
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration))
    }).observe({ type: 'longtask' })
  })
  await expect(captureState(page)).toHaveAttribute('data-state', 'rendered', { timeout: 20_000 })
  await expect(captureState(page)).toHaveAttribute('data-renderer', 'schematic')
  const ms = Number(await captureState(page).getAttribute('data-render-ms'))
  const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks)
  testInfo.annotations.push({
    type: 'render',
    description: `${ms} ms, long tasks ${JSON.stringify(longTasks)}`,
  })
  // The idle wait included; tldraw's own export of 200 notes blocks the page for most of a second.
  expect(ms).toBeLessThan(1500)
  expect(Math.max(0, ...longTasks)).toBeLessThan(250)

  const sent = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/boards/${board}/thumbnail`),
  )
  await alice.page.getByRole('link', { name: 'Back to Dev Studio' }).click()
  expect((await sent).status()).toBe(200)
  const img = card(page, board).getByTestId('board-thumbnail')
  await expect(img).toBeVisible({ timeout: 15_000 })
  const shown = await decoded(img)
  expect(shown.colours).toBeGreaterThan(8)
  await capture('thumbnails-large-board.png', card(page, board), testInfo)
})

test("thumbnails: viewers never upload, and the api refuses a viewer's upload", async ({
  session,
  board,
  users,
}) => {
  const alice = await users.api('alice')
  const owner = await putThumbnail(alice.request, board, png(48, 30))
  expect(owner.status()).toBe(200)

  const bob = await session('bob', { role: 'viewer' })
  const uploads = recordUploads(bob.page)
  await expect(captureState(bob.page)).toHaveAttribute('data-state', 'off')

  // The viewer's own requests: the image, yes; uploading or removing it, no.
  const got = await bob.page.request.get(`/api/boards/${board}/thumbnail`)
  expect(got.status()).toBe(200)
  expect(got.headers()['content-type']).toBe('image/png')
  const refused = await putThumbnail(bob.page.request, board, png(48, 30))
  expect(refused.status()).toBe(403)
  const removal = await bob.page.request.fetch(`/api/boards/${board}/thumbnail`, {
    method: 'DELETE',
    headers: { origin: WEB_URL },
  })
  expect(removal.status()).toBe(403)

  // Moving around the board as a viewer never makes the client try.
  await bob.page.mouse.move(400, 400)
  await bob.page.mouse.wheel(0, 300)
  await bob.page.waitForTimeout(4_000)
  expect(uploads).toHaveLength(0)

  // Someone who cannot view the board gets the same 404 as for a board that does not exist.
  const carol = await users.api('carol')
  const hidden = await carol.fetch('GET', `/api/boards/${board}/thumbnail`)
  const missing = await carol.fetch('GET', '/api/boards/b-0000000000/thumbnail')
  expect(hidden.status()).toBe(404)
  expect(await hidden.text()).toBe(await missing.text())
  expect((await putThumbnail(carol.request, board, png(4, 4))).status()).toBe(404)

  // The owner's upload is what everyone sees.
  const meta = await alice.fetch('GET', `/api/boards/${board}/thumbnail/meta`)
  expect(((await meta.json()) as { thumbnail: { width: number } }).thumbnail.width).toBe(48)
})

test('thumbnails (F11): a wide board of frames shows its first frame filling the card, not a thin strip', async ({
  session,
  board,
}, testInfo) => {
  const alice = await session('alice')
  const { page } = alice
  // Four slide-sized frames in a row (like the Lobby tour), each with a heading and a few notes: 6,880
  // page units wide and 1,000 tall. The whole row on a 16:10 card would be a band 23% of its height.
  await edit(
    page,
    (ed, a) => {
      const shapes: Record<string, unknown>[] = []
      const colors = ['yellow', 'orange', 'light-blue', 'violet']
      for (let i = 0; i < 4; i++) {
        const x = i * 1760
        shapes.push({ type: 'frame', x, y: 0, props: { w: 1600, h: 1000, name: `Slide ${i + 1}` } })
        shapes.push({
          type: 'geo',
          x: x + 80,
          y: 80,
          props: { geo: 'rectangle', w: 1440, h: 160, color: 'orange', fill: 'solid', richText: a.title },
        })
        for (let n = 0; n < 3; n++)
          shapes.push({
            type: 'note',
            x: x + 120 + n * 480,
            y: 420,
            props: { color: colors[(i + n) % 4], richText: a.note, scale: 1.6 },
          })
      }
      ed.createShapes(shapes)
    },
    { title: richText('A slide'), note: richText('An idea') },
  )
  await expect(captureState(page)).toHaveAttribute('data-state', 'rendered', { timeout: 20_000 })
  await backToDashboard(alice)
  const img = card(page, board).getByTestId('board-thumbnail')
  await expect(img).toBeVisible({ timeout: 15_000 })
  const shown = await decoded(img)
  expect([shown.width, shown.height]).toEqual([480, 300])
  const covered = await coverage(img)
  testInfo.annotations.push({ type: 'coverage', description: JSON.stringify(covered) })
  // The first frame fills the card (its outline and notes span most of it in both directions).
  expect(covered.h).toBeGreaterThan(0.8)
  expect(covered.w).toBeGreaterThan(0.8)
  await capture('thumbnails-wide-board-first-frame.png', card(page, board), testInfo)
})

test('thumbnails (F11): back to the dashboard 1.5 s after an edit, the card still gets the new picture', async ({
  session,
  board,
}) => {
  const alice = await session('alice')
  const { page } = alice
  const uploads = recordUploads(page)
  await drawSomething(page, 'Quick')
  // Well before the render that waits for 3 quiet seconds.
  await page.waitForTimeout(1_500)
  await expect(captureState(page)).not.toHaveAttribute('data-state', 'rendered')
  const sent = page.waitForResponse(
    (r) => r.request().method() === 'PUT' && r.url().endsWith(`/api/boards/${board}/thumbnail`),
    { timeout: 10_000 },
  )
  await backToDashboard(alice)
  expect((await sent).status()).toBe(200)
  const img = card(page, board).getByTestId('board-thumbnail')
  await expect(img).toBeVisible({ timeout: 10_000 })
  const shown = await decoded(img)
  expect(shown.colours, 'the thumbnail has content, not a blank rectangle').toBeGreaterThan(8)
  expect(uploads).toHaveLength(1)
  const meta = await page.request.get(`/api/boards/${board}/thumbnail/meta`)
  expect(((await meta.json()) as { thumbnail: { width: number } | null }).thumbnail?.width).toBe(480)
})

test('thumbnails (F11): the placeholder of a board without a thumbnail is dark on the dark theme', async ({
  session,
  board,
}, testInfo) => {
  const alice = await session('alice')
  const { page } = alice
  await backToDashboard(alice) // nothing on the board: no thumbnail, the card keeps its placeholder
  const placeholder = card(page, board).getByTestId('board-thumb-placeholder')
  await expect(placeholder).toBeVisible()
  /** Relative luminance (0 black .. 1 white) of the placeholder's background fill. */
  const luminance = () =>
    placeholder.locator('.dr-thumb__bg').evaluate((el) => {
      const fill = getComputedStyle(el).fill
      const nums = (fill.match(/[\d.]+/g) ?? []).map(Number)
      const [r = 0, g = 0, b = 0] = fill.startsWith('color(') ? nums.map((n) => n * 255) : nums
      const lin = (v: number) => {
        const s = v / 255
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    })
  expect(await luminance()).toBeGreaterThan(0.7) // the light pastel, unchanged
  await page.evaluate(([key]) => localStorage.setItem(key as string, 'dark'), [THEME_KEY])
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(placeholder).toBeVisible()
  expect(await luminance()).toBeLessThan(0.05)
  await capture('thumbnails-placeholder-dark.png', card(page, board), testInfo)
})
