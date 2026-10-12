// Wave N (WS5, N5-1 review): a photo the REAL api refuses before it reads the body (the day's cap, set to 0 here, or
// the Origin check), sent by Chromium. No capture route is faked: the routes must be live (ws5-integration.patch
// takes them out of PENDING_ROUTES and 'ai.capture' out of PENDING_PALETTE_COMMAND_IDS).
//  - Straight to the api (no proxy): an upload of 1 MiB and of 3.5 MiB refused at once still gets its answer. The api
//    reads the rest of the body and drops it; when it closed the connection under the upload instead, Chromium gave
//    "Failed to fetch" for both (measured on this suite's stack, the review's minor issue).
//  - Through the web's own origin: the e2e stack's proxy (vite preview) loses such an answer itself past about 1 MiB
//    (whatever the api does), as another proxy on the way may (Render's rewrite is not checked here). So the capture
//    client asks again without the photo, which the api refuses the same way before reading anything: the dialog
//    shows the cap's words for a 2 MB photo, not "Can't reach Lobby".
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n5-capture-refusal --project=chromium --workers=1
import type { Page, Request } from '@playwright/test'
import { LOBBY_CLIENT_HEADER, LOBBY_CLIENT_REV } from '../../packages/contracts/src/client-rev.ts'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  createNote,
  expect,
  expectSaved,
  select,
  setViewport,
} from '../tests/support/canvas.ts'
import { API_URL } from '../tests/support/ports.ts'
import {
  AI_API_ENV_3H,
  aiButton,
  captureDialog,
  continueCaptureNotice,
  FAKE_OPENAI_PORT_3H,
  foreignRequests,
  openCaptureFromMenu,
} from './ai-kit.ts'
import { focusBoard } from './board-kit.ts'

const test = base.extend<object, { openai: FakeOpenAi }>({
  openai: [
    async ({ stack: _ }, use) => {
      const fake = await startFakeOpenAi(FAKE_OPENAI_PORT_3H)
      await use(fake)
      await fake.close()
    },
    { scope: 'worker' },
  ],
})

test.use({
  viewport: { width: 1440, height: 900 },
  apiEnv: { ...AI_API_ENV_3H, DRAFTROOM_AI_VISION: 'on', DRAFTROOM_AI_VISION_USER_DAILY: '0' },
})

const CAPPED = 'You’ve used your 0 photo captures for today. They reset at midnight UTC.'

async function aiReady(page: Page, note: string) {
  await select(page, [note])
  await expect(aiButton(page)).toBeVisible({ timeout: 20_000 })
  await select(page, [])
}

/** Posts raw bodies of `sizes` bytes to `path` as the capture client sends a photo; each one's answer or failure. */
function postSizes(page: Page, path: string, sizes: number[]) {
  return page.evaluate(
    async ({ path, sizes, header, rev }) => {
      const out: unknown[] = []
      for (const size of sizes) {
        try {
          const res = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'image/jpeg', accept: 'application/json', [header]: rev },
            body: new Blob([new Uint8Array(size).fill(7)], { type: 'image/jpeg' }),
            credentials: 'include',
            cache: 'no-store',
          })
          out.push({
            size,
            status: res.status,
            code: ((await res.json()) as { error?: { code?: string } }).error?.code,
          })
        } catch (e) {
          out.push({ size, failed: String(e) })
        }
      }
      return out
    },
    { path, sizes, header: LOBBY_CLIENT_HEADER, rev: String(LOBBY_CLIENT_REV) },
  )
}

/** A 2048 px JPEG of noise, so that the capture client's copy of it is still about 2 MB. */
async function heavyPhoto(page: Page): Promise<{ photo: Buffer; sentBytes: number }> {
  const { bytes, sentBytes } = await page.evaluate(async () => {
    // the capture client's own size (2048 px: re-encoded, not scaled), noise all over
    const w = 2048
    const h = 1365
    const c = new OffscreenCanvas(w, h)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.fillStyle = '#d9d4c7'
    ctx.fillRect(0, 0, w, h)
    const noise = ctx.createImageData(w, h)
    let seed = 7
    for (let i = 0; i < noise.data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      noise.data[i] = i % 4 === 3 ? 255 : (seed >> 8) & 0xff
    }
    ctx.putImageData(noise, 0, 0)
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
    // what the capture client sends of it (downsize.ts: 2048 px, JPEG 0.85, drawn on a canvas)
    const small = new OffscreenCanvas(2048, 1365)
    ;(small.getContext('2d') as OffscreenCanvasRenderingContext2D).drawImage(
      await createImageBitmap(blob),
      0,
      0,
      2048,
      1365,
    )
    const sent = await small.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    return { bytes: [...new Uint8Array(await blob.arrayBuffer())], sentBytes: sent.size }
  })
  return { photo: Buffer.from(bytes), sentBytes }
}

test('N5-1: a photo refused before its body is read: Chromium gets the answer straight from the api, and the dialog its words through a proxy', async ({
  canvasSession,
  board,
  openai,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await setViewport(a.page, { x: -200, y: -200, zoom: 0.6 })
  const anchor = await createNote(a.page, { x: 0, y: 0, text: 'Wall photo goes here' })
  await expectSaved(a.page)
  await aiReady(a.page, anchor)
  openai.reset()
  const path = `/api/boards/${board}/ai/capture/photo?mode=notes`

  await test.step('through the web origin, a body the proxy passes: the cap’s 429', async () => {
    expect(await postSizes(a.page, path, [1024, 256 * 1024])).toEqual([
      { size: 1024, status: 429, code: 'AI_CAPTURE_DAILY_CAP' },
      { size: 256 * 1024, status: 429, code: 'AI_CAPTURE_DAILY_CAP' },
    ])
  })

  await test.step('through the dialog, a 2 MB photo: the cap’s words in the dialog, asked again without the photo', async () => {
    const { photo, sentBytes } = await heavyPhoto(a.page)
    // well past what this stack's proxy passes, within the api's 4 MiB
    expect(sentBytes).toBeGreaterThan(1.5 * 1024 * 1024)
    expect(sentBytes).toBeLessThan(4 * 1024 * 1024)
    const posts: Request[] = []
    const onRequest = (r: Request) => {
      if (r.method() === 'POST' && r.url().includes('/ai/capture/photo')) posts.push(r)
    }
    a.page.on('request', onRequest)
    await focusBoard(a.page)
    await openCaptureFromMenu(a.page)
    await captureDialog(a.page)
      .getByTestId('capture-choose-file')
      .setInputFiles({ name: 'wall.jpg', mimeType: 'image/jpeg', buffer: photo })
    await continueCaptureNotice(a.page)
    await expect(captureDialog(a.page).getByTestId('capture-error')).toHaveText(CAPPED)
    await expect(a.page.getByTestId('ai-preview-panel')).toHaveCount(0)
    a.page.off('request', onRequest)
    // the upload, which the proxy lost (a network failure), then the same route without the photo: the 429
    expect(posts).toHaveLength(2)
    expect(posts[0]?.failure()).not.toBeNull()
    expect(posts[1]?.failure()).toBeNull()
    expect((await posts[1]?.response())?.status()).toBe(429)
  })

  await test.step('straight to the api (no proxy): 1 MiB and 3.5 MiB refused at once (the Origin check) still get their answer', async () => {
    await a.page.goto(`${API_URL}/healthz`)
    expect(await postSizes(a.page, `${API_URL}${path}`, [1024 * 1024, 3.5 * 1024 * 1024, 1024])).toEqual([
      { size: 1024 * 1024, status: 403, code: 'FORBIDDEN' },
      { size: 3.5 * 1024 * 1024, status: 403, code: 'FORBIDDEN' },
      { size: 1024, status: 403, code: 'FORBIDDEN' },
    ])
  })

  // nothing reached OpenAI, and no request left Lobby's origins
  expect(openai.requests).toHaveLength(0)
  expect(foreign).toEqual([])
})
