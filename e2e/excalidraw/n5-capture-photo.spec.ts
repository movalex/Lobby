// Wave N (WS5, N5-2, N5-3, N5-5): Capture the room from a photo on the Excalidraw board page, against the real api
// and sync (the capture routes answered by ai-kit.ts fakeCapture with its canned outputs: the api's own routes are
// tested in apps/api/test/features/ai/capture.test.ts).
//  - A file pick (a 3000 × 2000 phone JPEG with EXIF and GPS): the first use shows the notice with a Continue (no
//    checkbox); what is sent is a JPEG of at most 2048 px with no EXIF, GPS or comment left; the preview; Apply makes
//    the six notes in the wall's two groups as frames, every element with the ai provenance, no element holding an
//    image or a URL, and no request leaving Lobby's origins.
//  - The count in the dialog's footer is the answer's, and it goes down with the next capture; the notice is not
//    asked again.
//  - The board-image path: on a selected image, AI › Turn photo into a diagram reads that image by its id and lands a
//    native diagram beside it, every connector bound with ends the room derived.
//  - Guests and viewers never see the entry; vision off hides the photo part and keeps the transcript.
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n5-capture-photo --project=chromium --workers=1
import type { Page } from '@playwright/test'
import { type ElementsById, resnapArrow } from '../../packages/canvas-schema/src/engine/index.ts'
import { makePng } from '../spike-b/support/png.ts'
import { type FakeOpenAi, startFakeOpenAi } from '../tests/support/ai.ts'
import {
  test as base,
  type CanvasElement,
  canvasCall,
  createItem,
  createNote,
  expect,
  expectSaved,
  itemBounds,
  itemCenterOnScreen,
  items,
  select,
  setViewport,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import {
  AI_API_ENV_3H,
  aiButton,
  CANNED_CAPTURE,
  cannedCaptureResponse,
  captureDialog,
  continueCaptureNotice,
  FAKE_OPENAI_PORT_3H,
  fakeCapture,
  foreignRequests,
  jpegFacts,
  openCaptureFromMenu,
  phonePhoto,
  sceneHoldsNoImage,
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

test.use({ viewport: { width: 1440, height: 900 }, apiEnv: AI_API_ENV_3H })

type Arrow = CanvasElement & {
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
}
const aiMade = async (page: Page) =>
  (await items(page)).filter((e) => (e.customData as { lobby?: { ai?: unknown } } | undefined)?.lobby?.ai)

/** Waits until the AI status is read (the AI bar button shows on a selected note), then clears the selection. */
async function aiReady(page: Page, note: string) {
  await select(page, [note])
  await expect(aiButton(page)).toBeVisible({ timeout: 20_000 })
  await select(page, [])
}

test('N5-2/N5-3/N5-5: a picked photo, the first-use notice, a JPEG without EXIF, the preview, the notes as frames', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await setViewport(a.page, { x: -200, y: -200, zoom: 0.6 })
  const anchor = await createNote(a.page, { x: 0, y: 0, text: 'Wall photo goes here' })
  await expectSaved(a.page)
  await aiReady(a.page, anchor)
  const fake = await fakeCapture(a.page, { keepBodies: true })
  const photo = await phonePhoto(a.page)
  expect(jpegFacts(photo)).toMatchObject({ width: 3000, height: 2000 })
  expect(jpegFacts(photo).metadata.length).toBeGreaterThan(0)

  await test.step('the dialog: Take photo, Choose file, Auto/Notes/Diagram, the notice in its footer', async () => {
    await focusBoard(a.page)
    await openCaptureFromMenu(a.page)
    const d = captureDialog(a.page)
    await expect(d.getByTestId('capture-take-photo')).toHaveAttribute('capture', 'environment')
    await expect(d.getByTestId('capture-take-photo')).toHaveAttribute('accept', 'image/*')
    await expect(d.getByTestId('capture-mode-auto')).toBeChecked()
    await expect(d.getByTestId('capture-add-photo')).not.toBeChecked()
    await expect(d.getByTestId('capture-footer')).toHaveText(
      'Sends this photo to OpenAI to read the notes or diagram. Lobby doesn’t keep the photo unless you add it to the board.',
    )
    // no count before the first answer
    await expect(d.getByTestId('capture-quota')).toHaveCount(0)
    await d.getByTestId('capture-mode-notes').check()
  })

  await test.step('the first use asks with a Continue (no checkbox), then sends a downsized JPEG without EXIF', async () => {
    await captureDialog(a.page)
      .getByTestId('capture-choose-file')
      .setInputFiles({ name: 'wall.jpg', mimeType: 'image/jpeg', buffer: photo })
    const notice = a.page.getByTestId('capture-notice')
    await expect(notice).toBeVisible()
    await expect(notice.getByRole('checkbox')).toHaveCount(0)
    await expect(a.page.getByTestId('capture-notice-text')).toHaveText(
      'Sends this photo to OpenAI to read the notes or diagram. Lobby doesn’t keep the photo unless you add it to the board.',
    )
    expect(fake.calls).toHaveLength(0)
    await a.page.getByTestId('capture-notice-continue').click()
    await expect.poll(() => fake.calls.length).toBe(1)
    const call = fake.calls[0]
    if (!call?.body) throw new Error('no photo body')
    expect(call).toMatchObject({ kind: 'photo', mode: 'notes', contentType: 'image/jpeg', status: 200 })
    const sent = jpegFacts(call.body)
    expect(sent).toEqual({ width: 2048, height: 1365, metadata: [] })
    expect(call.body.toString('latin1')).not.toMatch(/Exif|51\.5072|studio/)
  })

  await test.step('the preview, then Apply: six notes in the wall’s two groups as frames, all AI-made', async () => {
    const panel = a.page.getByTestId('ai-preview-panel')
    await expect(panel).toBeVisible({ timeout: 20_000 })
    await expect(a.page.getByTestId('ai-preview-summary')).toHaveText(
      'Adds 6 notes in 2 groups; each group is a frame',
    )
    await expect(a.page.getByTestId('ai-preview-group')).toHaveText(['Keep (3)', 'Change (3)'])
    // nothing written before Apply
    expect(await aiMade(a.page)).toEqual([])
    await a.page.getByTestId('ai-preview-apply').click()
    await expect
      .poll(async () => (await aiMade(a.page)).filter((e) => e.type === 'stickynote').length)
      .toBe(6)
    await expectSaved(a.page)
    expect((await canvasCall(a.page, 'saveState')).lastReject).toBeNull()
    const made = await aiMade(a.page)
    const frames = made.filter((e) => e.type === 'frame')
    expect(frames.map((f) => (f as { name?: string }).name).sort()).toEqual(['Change', 'Keep'])
    const notes = made.filter((e) => e.type === 'stickynote')
    for (const n of notes) expect(frames.map((f) => f.id)).toContain(n.frameId)
    for (const e of made) expect(e.customData?.lobby?.ai).toMatchObject({ by: a.id })
    const texts = await Promise.all(notes.map((n) => canvasCall(a.page, 'text', n.id)))
    expect(texts.sort()).toEqual(
      CANNED_CAPTURE.notes.kind === 'notes' ? CANNED_CAPTURE.notes.notes.map((n) => n.text).sort() : [],
    )
    // nothing of the photo on the board: no image element, no data:, blob: or http in any element
    const all = await items(a.page)
    expect(all.filter((e) => e.type === 'image')).toEqual([])
    expect(sceneHoldsNoImage(all)).toEqual([])
    // the anchor note was not moved or covered
    const ab = await itemBounds(a.page, anchor)
    for (const f of frames) {
      const fb = await itemBounds(a.page, f.id)
      const overlap =
        ab &&
        fb &&
        ab.x < fb.x + fb.width &&
        fb.x < ab.x + ab.width &&
        ab.y < fb.y + fb.height &&
        fb.y < ab.y + ab.height
      expect(overlap, f.id).toBeFalsy()
    }
  })

  await test.step('the count is the answer’s and goes down with the next capture; the notice is not asked again', async () => {
    await focusBoard(a.page)
    await openCaptureFromMenu(a.page)
    await expect(captureDialog(a.page).getByTestId('capture-quota')).toHaveText('7 photo captures left today')
    fake.next(cannedCaptureResponse(CANNED_CAPTURE.notes, { photosLeftToday: 6 }))
    await captureDialog(a.page)
      .getByTestId('capture-choose-file')
      .setInputFiles({ name: 'wall-2.jpg', mimeType: 'image/jpeg', buffer: photo })
    await expect(a.page.getByTestId('ai-preview-panel')).toBeVisible({ timeout: 20_000 })
    await expect(a.page.getByTestId('capture-notice')).toHaveCount(0)
    await a.page.getByTestId('ai-preview-discard').click()
    expect(fake.calls).toHaveLength(2)
    await focusBoard(a.page)
    await openCaptureFromMenu(a.page)
    await expect(captureDialog(a.page).getByTestId('capture-quota')).toHaveText('6 photo captures left today')
    await captureDialog(a.page).getByTestId('capture-close').click()
    // the discarded one wrote nothing
    expect((await aiMade(a.page)).filter((e) => e.type === 'stickynote')).toHaveLength(6)
  })

  expect(foreign).toEqual([])
})

test('N5-2/N5-3: AI › Turn photo into a diagram on a selected image: read by its id, a native diagram beside it', async ({
  canvasSession,
  board,
  users,
}) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  const foreign = foreignRequests(a.page)
  const api = await users.api('alice')
  const bytes = makePng(640, 360, 3)
  const up = await api.request.post(`${WEB_URL}/api/boards/${board}/assets`, {
    headers: { origin: WEB_URL, 'content-type': 'image/png', 'x-file-name': 'whiteboard.png' },
    data: bytes,
  })
  expect(up.status(), await up.text()).toBeLessThan(300)
  const meta = (await up.json()) as { assetId: string; versionId: string; name?: string; sizeBytes?: number }
  const image = await createItem(a.page, 'image', {
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    fileId: meta.versionId,
    status: 'saved',
    customData: {
      lobby: {
        file: {
          assetId: meta.assetId,
          versionId: meta.versionId,
          kind: 'image',
          name: meta.name ?? 'whiteboard.png',
          mimeType: 'image/png',
          sizeBytes: meta.sizeBytes ?? bytes.length,
        },
      },
    },
  })
  await expectSaved(a.page)
  await setViewport(a.page, { x: -300, y: -300, zoom: 0.5 })
  const note = await createNote(a.page, { x: 500, y: 0, text: 'Status check' })
  await expectSaved(a.page)
  await aiReady(a.page, note)
  const fake = await fakeCapture(a.page)
  await select(a.page, [image])
  const at = await itemCenterOnScreen(a.page, image)
  await a.page.mouse.click(at.x, at.y, { button: 'right' })
  await a.page.getByRole('menuitem', { name: 'AI', exact: true }).click()
  await expect(a.page.getByRole('menuitem', { name: 'Turn photo into notes' })).toBeVisible()
  await a.page.getByRole('menuitem', { name: 'Turn photo into a diagram' }).click()
  // the first use's notice (a fresh browser): its Cancel sends nothing and leaves the way to start it in the dialog
  await expect(a.page.getByTestId('capture-notice')).toBeVisible()
  await a.page.getByTestId('capture-notice-cancel').click()
  await expect(captureDialog(a.page).getByTestId('capture-board-image-go')).toHaveText('Read the image')
  expect(fake.calls).toHaveLength(0)
  await captureDialog(a.page).getByTestId('capture-board-image-go').click()
  expect(await continueCaptureNotice(a.page)).toBe(true)
  await expect.poll(() => fake.calls.length).toBe(1)
  expect(fake.calls[0]).toMatchObject({
    kind: 'board-image',
    mode: 'diagram',
    contentType: 'application/json',
  })
  await expect(a.page.getByTestId('ai-preview-summary')).toHaveText('Adds 5 shapes and 5 connectors')
  await a.page.getByTestId('ai-preview-apply').click()
  const shapes = async () =>
    (await aiMade(a.page)).filter((e) => ['rectangle', 'diamond', 'ellipse'].includes(e.type)).length
  await expect.poll(shapes).toBe(5)
  await expectSaved(a.page)
  expect((await canvasCall(a.page, 'saveState')).lastReject).toBeNull()
  const all = await items(a.page)
  const map = new Map(all.map((e) => [e.id, e])) as unknown as ElementsById
  const arrows = all.filter((e) => e.type === 'arrow') as Arrow[]
  expect(arrows).toHaveLength(5)
  for (const arrow of arrows) {
    expect(arrow.startBinding?.elementId && arrow.endBinding?.elementId, arrow.id).toBeTruthy()
    expect(resnapArrow(arrow as never, map).changed, arrow.id).toBe(false)
  }
  // the plain line has no arrowhead
  expect(arrows.filter((x) => (x as { endArrowhead?: unknown }).endArrowhead === null)).toHaveLength(1)
  // beside the image (never on it), and in no frame
  const ib = await itemBounds(a.page, image)
  for (const e of (await aiMade(a.page)).filter((x) => x.type !== 'text')) {
    expect(e.frameId ?? null, e.id).toBeNull()
    const b = await itemBounds(a.page, e.id)
    const overlap =
      ib &&
      b &&
      ib.x < b.x + b.width &&
      b.x < ib.x + ib.width &&
      ib.y < b.y + b.height &&
      b.y < ib.y + ib.height
    expect(overlap, e.id).toBeFalsy()
  }
  expect(foreign).toEqual([])
})

test('N5-2/N5-5: viewers and name-only guests never see the entry; vision off hides photos, keeps transcripts', async ({
  canvasSession,
  board,
  browser,
  users,
}) => {
  const a = await canvasSession('alice')
  const note = await createNote(a.page, { x: 0, y: 0, text: 'Hello' })
  await expectSaved(a.page)
  await aiReady(a.page, note)

  await test.step('a viewer: no Capture the room', async () => {
    const v = await canvasSession('victor', { role: 'viewer' })
    await focusBoard(v.page)
    const box = await v.page.locator('[data-lobby-board-canvas]').boundingBox()
    if (!box) throw new Error('no canvas')
    await v.page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.6, { button: 'right' })
    await expect(v.page.getByTestId('context-menu-root')).toBeVisible()
    const ai = v.page.getByRole('menuitem', { name: 'AI', exact: true })
    if (await ai.count()) await ai.click()
    await expect(v.page.getByRole('menuitem', { name: 'Capture the room…' })).toHaveCount(0)
  })

  await test.step('a name-only guest: no AI at all', async () => {
    const aliceApi = await users.api('alice')
    const made = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
      role: 'editor',
      allowGuests: true,
      expiresInHours: 3,
    })
    expect(made.status()).toBe(201)
    const link = ((await made.json()) as { url: string }).url
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
    try {
      const g = await context.newPage()
      await g.goto(link)
      await g.getByTestId('invite-guest-name').fill('Sam')
      await g.getByTestId('invite-guest-join').click()
      await expect(g).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
      await waitForCanvas(g)
      expect(await canvasCall(g, 'readOnly')).toBe(false)
      await g.waitForTimeout(800)
      const box = await g.locator('[data-lobby-board-canvas]').boundingBox()
      if (!box) throw new Error('no canvas')
      await g.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.6, { button: 'right' })
      await expect(g.getByTestId('context-menu-root')).toBeVisible()
      await expect(g.getByRole('menuitem', { name: 'AI', exact: true })).toHaveCount(0)
      await expect(g.getByRole('menuitem', { name: 'Capture the room…' })).toHaveCount(0)
      await expect(g.getByTestId('capture-dialog')).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  await test.step('vision off: the photo answer’s 404 hides photos; the transcript tab still works', async () => {
    const fake = await fakeCapture(a.page, { vision: false })
    await focusBoard(a.page)
    await openCaptureFromMenu(a.page)
    const photo = await phonePhoto(a.page, 800, 600)
    await captureDialog(a.page)
      .getByTestId('capture-choose-file')
      .setInputFiles({ name: 'wall.jpg', mimeType: 'image/jpeg', buffer: photo })
    await continueCaptureNotice(a.page)
    await expect(captureDialog(a.page).getByTestId('capture-error')).toHaveText(
      'Photo capture is turned off for Lobby right now. You can still capture a meeting transcript.',
    )
    await expect(captureDialog(a.page).getByTestId('capture-photo-off')).toBeVisible()
    await captureDialog(a.page).getByTestId('capture-tab-transcript').click()
    await captureDialog(a.page).getByTestId('capture-transcript-text').fill('Ana: We ship on Friday.')
    await captureDialog(a.page).getByTestId('capture-transcript-go').click()
    await continueCaptureNotice(a.page)
    await expect(a.page.getByTestId('ai-preview-panel')).toBeVisible({ timeout: 20_000 })
    await a.page.getByTestId('ai-preview-discard').click()
    expect(fake.calls.map((c) => [c.kind, c.status])).toEqual([
      ['photo', 404],
      ['transcript', 200],
    ])
  })
})
