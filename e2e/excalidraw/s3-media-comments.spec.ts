// Wave S, WS3 (docs/WAVE-S-CONTRACTS.md §4): time-coded, page and spot comments in the review viewer, on real uploads
// through the api file routes and the preview worker, with the media comments switch on (s3-kit.ts):
//   - a video comment at a time: "Comment at 00:02.0", its scrubber marker, a click on the marker seeks there and
//     pauses; a second tab sees the marker live; the canvas popover's "Jump to 00:02.0" opens the viewer there;
//   - a PDF page comment shows on page 3 only (the viewer's page strip and the PDF viewer's thumbnails);
//   - an image spot, in the viewer and with the comment tool on the canvas (an asset anchor with the spot);
//   - the exports (CSV with formulas neutralised, the Premiere marker list, the EDL), downloaded and read;
//   - invalid anchors and spots are refused by the api (400 INVALID_ANCHOR) and nothing is stored.
// H.264 playback needs branded Chrome (as media-video.spec.ts): this file runs on the `chrome` channel.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- s3-
import { join } from 'node:path'
import {
  expect,
  itemBounds,
  sceneToScreen,
  select,
  selectNone,
  setTool,
  test,
} from '../tests/support/canvas.ts'
import { downloadFrom } from '../tests/support/present-export.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { cardItems, expectLoadedImage, fileCard, imageItems, insertFiles, newItems } from './media-kit.ts'
import {
  apiThreads,
  mediaCommentsOn,
  openReview,
  postInViewer,
  postThread,
  videoState,
  viewer,
} from './s3-kit.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)

test.use({ channel: 'chrome' })

async function readyCard(page: Parameters<typeof cardItems>[0], name: string) {
  await expect(fileCard(page, name)).toHaveAttribute('data-status', 'ready', { timeout: 60_000 })
  const card = (await cardItems(page)).find((c) => c.facts.name === name)
  if (!card) throw new Error(`no card ${name}`)
  return card
}

test('S3-1 a video comment at a time: its marker on the scrubber, a click seeks there, a second tab sees it, "Jump to" from the canvas', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'commenter' })
  await mediaCommentsOn(a)
  await mediaCommentsOn(b)
  await insertFiles(a.page, [fixture('video.mp4')])
  const card = await readyCard(a.page, 'video.mp4')
  await readyCard(b.page, 'video.mp4')

  await test.step('the second tab opens the viewer first (it will see the marker arrive)', async () => {
    await openReview(b.page, card.id)
    await expect(b.page.getByTestId('rv-video')).toBeVisible()
    await expect(b.page.getByTestId('rv-marker')).toHaveCount(0)
  })

  await test.step('alice steps to 2.05 s (two seconds, one frame at the probed 30 fps) and comments there', async () => {
    await openReview(a.page, card.id)
    const v = a.page.getByTestId('rv-video')
    await expect(v).toBeVisible()
    await expect.poll(async () => (await videoState(a.page)).ready, { timeout: 30_000 }).toBeGreaterThan(0)
    await a.page.getByTestId('rv-video-next-second').click()
    await a.page.getByTestId('rv-video-next-second').click()
    await a.page.getByTestId('rv-video-next-frame').click()
    // the probe's frame rate reached the viewer: hh:mm:ss:ff at 30 fps
    await expect(a.page.getByTestId('rv-video-time')).toContainText('00:00:02:01')
    const here = a.page.getByTestId('rv-comment-here')
    await expect(here).toHaveText('Comment at 00:02.0')
    await here.click()
    await expect(a.page.getByTestId('rv-composer-where')).toHaveText('New comment at 00:02.0')
    await postInViewer(a.page, 'Logo pops here')
    const row = a.page.getByTestId('rv-thread-row')
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('rv-thread-at')).toHaveText('00:02.0')
    const marker = a.page.getByTestId('rv-marker')
    await expect(marker).toHaveCount(1)
    const ms = Number(await marker.getAttribute('data-time-ms'))
    expect(Math.abs(ms - 2050)).toBeLessThanOrEqual(20)
    const [t] = (await apiThreads(a.page, board)).filter((x) => x.anchor.kind === 'asset')
    expect(t?.anchor).toMatchObject({ assetId: card.facts.assetId, versionId: card.facts.versionId })
    expect(Math.abs((t?.anchor.timeMs ?? 0) - 2050)).toBeLessThanOrEqual(20)
  })

  await test.step('a click on the marker seeks there (within 0.1 s) and pauses', async () => {
    await a.page.getByTestId('rv-video-next-second').click()
    await expect.poll(async () => (await videoState(a.page)).t).toBeGreaterThan(2.9)
    await a.page.getByTestId('rv-marker').click()
    await expect.poll(async () => Math.abs((await videoState(a.page)).t - 2.05)).toBeLessThan(0.1)
    expect((await videoState(a.page)).paused).toBe(true)
    await expect(a.page.getByTestId('rv-thread')).toBeVisible()
  })

  await test.step('the second tab sees the marker live, and its click seeks too', async () => {
    const marker = b.page.getByTestId('rv-marker')
    await expect(marker).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(async () => (await videoState(b.page)).ready, { timeout: 30_000 }).toBeGreaterThan(0)
    await marker.click()
    await expect.poll(async () => Math.abs((await videoState(b.page)).t - 2.05)).toBeLessThan(0.1)
    await expect(b.page.getByTestId('rv-thread')).toContainText('Logo pops here')
  })

  await test.step('from the canvas: the pin\'s popover says "Jump to 00:02.0" and opens the viewer there', async () => {
    await a.page.getByTestId('review-viewer-close').click()
    await expect(viewer(a.page)).toHaveCount(0)
    await selectNone(a.page)
    const [t] = await apiThreads(a.page, board)
    await a.page.locator(`[data-testid="comment-pin"][data-thread-id="${t?.id}"]`).click()
    const jump = a.page.getByTestId('thread-open-viewer')
    await expect(jump).toHaveText('Jump to 00:02.0')
    await jump.click()
    await expect(viewer(a.page)).toBeVisible()
    await expect(a.page.getByTestId('thread-popover')).toHaveCount(0)
    await expect
      .poll(async () => Math.abs((await videoState(a.page)).t - 2.05), { timeout: 20_000 })
      .toBeLessThan(0.1)
    await expect(a.page.getByTestId('rv-thread')).toBeVisible()
  })
})

test('S3-2 a PDF page comment shows on page 3 only, in the viewer strip and the PDF viewer', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(150_000)
  const a = await canvasSession('alice')
  await mediaCommentsOn(a)
  await insertFiles(a.page, [fixture('document.pdf')])
  const card = await readyCard(a.page, 'document.pdf')
  await openReview(a.page, card.id)
  await expect(a.page.getByTestId('rv-page-thumb')).toHaveCount(4)
  await a.page.locator('[data-testid="rv-page-thumb"][data-page="3"]').click()
  await expect(a.page.getByTestId('rv-page-counter')).toHaveText('Page 3 of 4')
  await a.page.getByTestId('rv-comment-here').click()
  await expect(a.page.getByTestId('rv-composer-where')).toHaveText('New comment on page 3')
  await postInViewer(a.page, 'Typo in the second paragraph')
  const markers = a.page.getByTestId('rv-page-marker')
  await expect(markers).toHaveCount(1)
  await expect(markers).toHaveAttribute('data-page', '3')
  await expect(markers).toHaveText('1')
  await expect(a.page.getByTestId('rv-thread-at')).toHaveText('p. 3')
  const stored = (await apiThreads(a.page, board)).find((t) => t.anchor.kind === 'asset')
  expect(stored?.anchor).toMatchObject({ page: 3, versionId: card.facts.versionId })
  expect(stored?.spot).toBeUndefined()
  // on page 1 the list still holds it, the page shows no spot pin
  await a.page.locator('[data-testid="rv-page-thumb"][data-page="1"]').click()
  await expect(a.page.getByTestId('rv-spot-pin')).toHaveCount(0)

  // the PDF viewer ("View pages") marks page 3 too
  await a.page.getByTestId('review-viewer-close').click()
  await select(a.page, [card.id])
  await fileCard(a.page, 'document.pdf').getByTestId('file-card-view-pages').click()
  await expect(a.page.getByTestId('pdf-viewer')).toBeVisible()
  const pv = a.page.getByTestId('pdf-viewer-marker')
  await expect(pv).toHaveCount(1)
  await expect(pv).toHaveAttribute('data-page', '3')
})

test('S3-3 an image spot: a pin where it was clicked in the viewer, and an asset anchor with its spot from the comment tool', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(150_000)
  const a = await canvasSession('alice')
  const b = await canvasSession('bob', { role: 'commenter' })
  await mediaCommentsOn(a)
  await mediaCommentsOn(b)
  const before = new Set((await imageItems(a.page)).map((i) => i.id))
  await insertFiles(a.page, [fixture('image.png')])
  const [img] = await newItems(a.page, imageItems, before, 1)
  if (!img) throw new Error('no image')
  await expectLoadedImage(a.page, img.id, board)

  await test.step('in the viewer: a click at (25 %, 50 %) of the picture comments on that spot', async () => {
    await openReview(a.page, img.id)
    const picture = a.page.getByTestId('rv-picture')
    await expect(picture).toBeVisible({ timeout: 30_000 })
    const box = await picture.boundingBox()
    if (!box) throw new Error('no picture box')
    await a.page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5)
    await expect(a.page.getByTestId('rv-draft-pin')).toBeVisible()
    await expect(a.page.getByTestId('rv-composer-where')).toHaveText('New comment on a spot')
    await postInViewer(a.page, 'Warmer here')
    const pin = a.page.getByTestId('rv-spot-pin')
    await expect(pin).toHaveCount(1)
    const [t] = (await apiThreads(a.page, board)).filter((x) => x.anchor.kind === 'asset')
    expect(t?.anchor).toMatchObject({
      kind: 'asset',
      assetId: img.facts.assetId,
      versionId: img.facts.versionId,
    })
    expect(t?.spot?.u).toBeCloseTo(0.25, 1)
    expect(t?.spot?.v).toBeCloseTo(0.5, 1)
    // the pin sits on the spot it names
    const p = await pin.boundingBox()
    if (!p) throw new Error('no pin box')
    expect(Math.abs(p.x - (box.x + box.width * 0.25))).toBeLessThan(3)
    expect(Math.abs(p.y + p.height - (box.y + box.height * 0.5))).toBeLessThan(3)
  })

  await test.step('a second tab sees the spot pin in its viewer', async () => {
    await openReview(b.page, img.id)
    await expect(b.page.getByTestId('rv-spot-pin')).toHaveCount(1, { timeout: 15_000 })
    await b.page.getByTestId('review-viewer-close').click()
  })

  await test.step('on the canvas, the comment tool on the image makes an asset anchor with the spot clicked', async () => {
    await a.page.getByTestId('review-viewer-close').click()
    await selectNone(a.page)
    const bounds = await itemBounds(a.page, img.id)
    if (!bounds) throw new Error('no image bounds')
    const at = await sceneToScreen(a.page, {
      x: bounds.x + bounds.width * 0.75,
      y: bounds.y + bounds.height * 0.25,
    })
    await setTool(a.page, 'comment')
    await a.page.mouse.click(at.x, at.y)
    const box = a.page.getByTestId('new-comment-popover').locator('textarea')
    await expect(box).toBeFocused()
    await box.fill('And the sky')
    await box.press('Enter')
    await expect
      .poll(async () => (await apiThreads(a.page, board)).filter((x) => x.anchor.kind === 'asset').length)
      .toBe(2)
    const sky = (await apiThreads(a.page, board)).find((x) => x.comments[0]?.body === 'And the sky')
    expect(sky?.anchor).toMatchObject({
      kind: 'asset',
      assetId: img.facts.assetId,
      versionId: img.facts.versionId,
    })
    expect(sky?.spot?.u).toBeCloseTo(0.75, 1)
    expect(sky?.spot?.v).toBeCloseTo(0.25, 1)
    // its pin on the canvas is drawn at that spot
    const pin = await a.page.locator(`[data-testid="comment-pin"][data-thread-id="${sky?.id}"]`).boundingBox()
    if (!pin) throw new Error('no canvas pin')
    expect(Math.abs(pin.x - at.x)).toBeLessThan(4)
    expect(Math.abs(pin.y + pin.height - at.y)).toBeLessThan(4)
  })
})

test('S3-4 export: the comments CSV (formulas neutralised), the Premiere marker list and the EDL, downloaded and read', async ({
  canvasSession,
}) => {
  test.setTimeout(150_000)
  const a = await canvasSession('alice')
  await mediaCommentsOn(a)
  await insertFiles(a.page, [fixture('video.mp4')])
  const card = await readyCard(a.page, 'video.mp4')
  await openReview(a.page, card.id)
  await expect.poll(async () => (await videoState(a.page)).ready, { timeout: 30_000 }).toBeGreaterThan(0)
  await a.page.getByTestId('rv-video-next-second').click()
  await a.page.getByTestId('rv-comment-here').click()
  await postInViewer(a.page, '=HYPERLINK("http://evil.invalid","x")')
  await a.page.getByTestId('rv-video-next-second').click()
  await a.page.getByTestId('rv-video-next-second').click()
  await a.page.getByTestId('rv-comment-here').click()
  await postInViewer(a.page, 'Music in, please')
  await expect(a.page.getByTestId('rv-marker')).toHaveCount(2)

  await a.page.getByTestId('rv-export').click()
  const csv = await downloadFrom(a.page, () => a.page.getByTestId('rv-export-csv').click())
  expect(csv.name).toBe('video - comments.csv')
  const rows = csv.bytes.toString('utf8').replace(/^﻿/, '').split('\r\n')
  expect(rows[0]).toBe('Thread,Version,Timecode,Page,Spot,Author,Status,Comment,Posted')
  expect(rows).toHaveLength(4) // header, two comments, the final line break
  const evil = rows.find((r) => r.includes('HYPERLINK')) ?? ''
  // the cell starts with an apostrophe (never a formula), quoted for its quotes and comma
  expect(evil).toContain(`"'=HYPERLINK(""http://evil.invalid"",""x"")"`)
  expect(evil).toContain(',00:00:01:00,')
  expect(rows.some((r) => r.includes(',00:00:03:00,') && r.includes('Music in, please'))).toBe(true)

  await a.page.getByTestId('rv-export').click()
  const markers = await downloadFrom(a.page, () => a.page.getByTestId('rv-export-markers').click())
  expect(markers.name).toBe('video - markers.csv')
  const m = markers.bytes.toString('utf8').replace(/^﻿/, '').split('\r\n')
  expect(m[0]).toBe('Marker Name,Description,In,Out,Duration,Marker Type')
  expect(m[1]).toMatch(
    /^[^,]+,"'=HYPERLINK\(""http:\/\/evil\.invalid"",""x""\)",00:00:01:00,00:00:01:00,00:00:00:00,Comment$/,
  )
  expect(m[2]).toMatch(/,"Music in, please",00:00:03:00,00:00:03:00,00:00:00:00,Comment$/)

  await a.page.getByTestId('rv-export').click()
  const edl = await downloadFrom(a.page, () => a.page.getByTestId('rv-export-edl').click())
  expect(edl.name).toBe('video.edl')
  const e = edl.bytes.toString('utf8').split('\r\n')
  expect(e.slice(0, 2)).toEqual(['TITLE: video.mp4', 'FCM: NON-DROP FRAME'])
  expect(e).toContain('001  AX       V     C        00:00:01:00 00:00:01:01 00:00:01:00 00:00:01:01')
  expect(e).toContain('002  AX       V     C        00:00:03:00 00:00:03:01 00:00:03:00 00:00:03:01')
  expect(e.filter((l) => l.startsWith('* LOC: ')).length).toBe(2)
  expect(e.find((l) => l.startsWith('* LOC: 00:00:03:00'))).toContain('Music in, please')
})

test('S3-5 invalid anchors and spots are refused by the api (400 INVALID_ANCHOR); nothing is stored', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(150_000)
  const a = await canvasSession('alice')
  await insertFiles(a.page, [fixture('document.pdf'), fixture('video.mp4')])
  const pdf = await readyCard(a.page, 'document.pdf')
  const video = await readyCard(a.page, 'video.mp4')
  const on = (c: typeof pdf, at: Record<string, number> = {}) => ({
    kind: 'asset',
    shapeId: `shape:${c.id}`,
    assetId: c.facts.assetId,
    versionId: c.facts.versionId,
    ...at,
  })
  const refused = [
    { anchor: { kind: 'point', x: 1, y: 2 }, body: 'x', spot: { u: 0.5, v: 0.5 } },
    { anchor: on(pdf, { page: 5 }), body: 'x' },
    { anchor: on(pdf), body: 'x', spot: { u: 0.5, v: 0.5 } },
    { anchor: on(pdf, { timeMs: 1000 }), body: 'x' },
    { anchor: on(video, { timeMs: 60_000 }), body: 'x' },
    { anchor: on(video, { page: 1 }), body: 'x' },
    { anchor: { ...on(video), versionId: 'ver_0123456789abcdefghij' }, body: 'x' },
    { anchor: { ...on(video), assetId: pdf.facts.assetId }, body: 'x' },
  ]
  for (const body of refused) {
    expect(await postThread(a.page, board, body), JSON.stringify(body)).toEqual({
      status: 400,
      code: 'INVALID_ANCHOR',
    })
  }
  // out of the contract's range: refused before the checks
  expect(
    (await postThread(a.page, board, { anchor: on(pdf, { page: 1 }), body: 'x', spot: { u: 2, v: 0 } }))
      .status,
  ).toBe(400)
  expect(await apiThreads(a.page, board)).toEqual([])
  // and the good ones are stored
  expect(
    (await postThread(a.page, board, { anchor: on(pdf, { page: 4 }), body: 'x', spot: { u: 0.1, v: 0.9 } }))
      .status,
  ).toBe(201)
  expect((await postThread(a.page, board, { anchor: on(video, { timeMs: 4_000 }), body: 'x' })).status).toBe(
    201,
  )
  expect(await apiThreads(a.page, board)).toHaveLength(2)
})
