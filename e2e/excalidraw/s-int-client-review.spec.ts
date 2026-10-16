// Wave S integration: client review end to end on the real api, sync server and preview worker, with the switches
// as the build ships them (every wave S switch on; no localStorage override, no route double):
//   1. the owner marks a frame and a video file card for review;
//   2. a client with no account opens a review link made to land on the review page, joins with a name, approves the
//      frame and requests changes on the file (with a note); both answers read "(guest)";
//   3. the owner sees the badges live and the bell's review notification;
//   4. the owner uploads v2 of the file: its status goes back to Awaiting review about v2, and Compare puts v1 and v2
//      side by side in the review viewer;
//   5. a comment at a time on the video (typed in the viewer's composer and posted with Enter), its scrubber marker,
//      and a click on the marker seeks there;
//   6. the summary PDF is downloaded from the review page and its text read back;
//   7. the refusals: a viewer (an account, and a viewer-link guest) cannot set a status; a name-only guest cannot
//      manage the review (mark, change, remove, rounds).
// H.264 playback needs branded Chrome (as media-video.spec.ts): this file runs on the `chrome` channel.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test -c excalidraw/playwright.config.ts s-int-
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, select, selectNone, test } from '../tests/support/canvas.ts'
import { fileFromPath } from '../tests/support/files.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { downloadFrom, pdfPageTexts } from '../tests/support/present-export.ts'
import { FIXTURES_DIR } from '../tests/support/stack.ts'
import { cardItems, fileCard, insertFiles, newItems } from './media-kit.ts'
import { foreignRequests } from './r3-chat-kit.ts'
import { badgeOf, frameNamed, ORIGIN, reviewLinkToken } from './s1-kit.ts'
import { chipOf, uploadNewVersion } from './s2-kit.ts'
import { openReview, postInViewer, videoState, viewer } from './s3-kit.ts'
import { createReviewLink, joinThroughInvitePage, reviewItems, reviewPage } from './s4-kit.ts'

const fixture = (name: string) => join(FIXTURES_DIR, name)
/** contracts review.ts REVIEW_GUEST_FOOTNOTE (e2e declares no dependency on the contracts package) */
const REVIEW_GUEST_FOOTNOTE = '(guest): joined with a name only; identity not verified.'
const PHONE = { width: 390, height: 844 }

test.use({ channel: 'chrome', viewport: { width: 1440, height: 900 } })
test.describe.configure({ mode: 'serial' })

interface ApiItem {
  id: string
  elementId: string
  kind: string
  label: string
  status: string
  statusVersionId: string | null
  statusBy: { name: string; kind: string } | null
}

/** The board's review as `page`'s session sees it (same origin, the session cookie). */
function apiReview(page: Page, board: string) {
  return page.evaluate(async (bid) => {
    const res = await fetch(`/api/boards/${bid}/review`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'x-lobby-client': '3' },
    })
    return {
      status: res.status,
      body: (await res.json()) as { items: ApiItem[]; can: { setStatus: boolean; manage: boolean } },
    }
  }, board)
}

/** Selects `id` and marks it for review from the selection bar (its badge then reads Awaiting review). */
async function markFromBar(page: Page, id: string): Promise<void> {
  await select(page, [id])
  await page.getByTestId('selection-review-mark').click()
  await expect(page.getByTestId('review-marked').last()).toContainText('In review:')
  await expect(badgeOf(page, id)).toHaveAttribute('data-status', 'pending')
  await selectNone(page)
}

test('S-int client review: mark, a client answers on the review page, badges and bell, v2 resets and compares, a video comment seeks, the summary PDF', async ({
  canvasSession,
  board,
  browser,
  users,
}) => {
  test.setTimeout(420_000)
  const owner = await canvasSession('alice')
  const ownerApi = await users.api('alice')
  const ownerForeign = foreignRequests(owner.page)
  const contexts: { close(): Promise<void> }[] = []
  try {
    let frameId = ''
    let cardId = ''
    let v1 = { assetId: '', versionId: '' }
    await test.step('1. the owner marks a frame and a video file card for review', async () => {
      // the frame top left, marked before the card arrives in the middle of the view
      frameId = await frameNamed(owner.page, 'Key art', { x: 40, y: 40, width: 360, height: 240 })
      await markFromBar(owner.page, frameId)
      const before = new Set((await cardItems(owner.page)).map((f) => f.id))
      await insertFiles(owner.page, [fixture('video.mp4')])
      const [card] = await newItems(owner.page, cardItems, before, 1)
      if (!card) throw new Error('no card')
      cardId = card.id
      v1 = { assetId: card.facts.assetId, versionId: card.facts.versionId }
      await expect(fileCard(owner.page, 'video.mp4')).toHaveAttribute('data-status', 'ready', {
        timeout: 60_000,
      })
      await markFromBar(owner.page, cardId)
      const { body } = await apiReview(owner.page, board)
      expect(body.items.map((i) => [i.elementId, i.kind, i.status])).toEqual([
        [frameId, 'frame', 'pending'],
        [cardId, 'file', 'pending'],
      ])
      expect(body.can).toEqual({ setStatus: true, manage: true })
    })

    await test.step('2. a client on a review link lands on the review page and answers both items as "(guest)"', async () => {
      const link = await createReviewLink(ownerApi, board, {
        role: 'commenter',
        allowGuests: true,
        landing: 'review',
      })
      expect(link.landing).toBe('review')
      const guest = await joinThroughInvitePage(browser, link.url, 'Sam', { viewport: PHONE })
      contexts.push(guest.context)
      const g = guest.page
      const guestForeign = foreignRequests(g)
      await expect(g).toHaveURL(/\/b\/[a-z0-9-]+\?view=review$/, { timeout: 30_000 })
      await expect(reviewPage(g)).toBeVisible({ timeout: 30_000 })
      await expect(reviewItems(g)).toHaveCount(2)
      await expect(g.getByTestId('review-progress')).toContainText('0 of 2 approved')

      const frameItem = reviewItems(g).filter({ hasText: 'Key art' })
      await frameItem.getByTestId('review-approve').click()
      await frameItem.getByTestId('review-approve-confirm').click()
      await expect(frameItem.getByTestId('review-item-status')).toContainText('Approved')
      await expect(frameItem.getByTestId('review-item-status')).toContainText('Sam (guest)')

      const fileItem = reviewItems(g).filter({ hasNotText: 'Key art' })
      await fileItem.getByTestId('review-request-changes').click()
      await fileItem.getByTestId('review-note').fill('Shorter intro, please')
      await fileItem.getByTestId('review-note-send').click()
      await expect(fileItem.getByTestId('review-item-status')).toContainText('Changes requested')
      await expect(g.getByTestId('review-progress')).toContainText('1 of 2 approved')

      // stored as the guest, about the version the client saw
      const { body } = await apiReview(owner.page, board)
      const byEl = new Map(body.items.map((i) => [i.elementId, i]))
      expect(byEl.get(frameId)).toMatchObject({
        status: 'approved',
        statusBy: { name: 'Sam', kind: 'guest' },
      })
      expect(byEl.get(cardId)).toMatchObject({
        status: 'changes_requested',
        statusVersionId: v1.versionId,
        statusBy: { kind: 'guest' },
      })
      expect(guestForeign, 'the client page asked someone outside Lobby').toEqual([])
    })

    await test.step('3. the owner sees the badges live and the bell', async () => {
      await expect(badgeOf(owner.page, frameId)).toHaveAttribute('data-status', 'approved', {
        timeout: 10_000,
      })
      await expect(badgeOf(owner.page, frameId)).toContainText('Approved · Sam (guest)')
      await expect(badgeOf(owner.page, cardId)).toHaveAttribute('data-status', 'changes_requested')
      await expect(badgeOf(owner.page, cardId)).toContainText('Changes requested · Sam (guest)')
      await expect
        .poll(async () => {
          const res = await ownerApi.request.fetch(`${WEB_URL}/api/me/notifications`, {
            headers: { 'x-lobby-client': '3' },
          })
          const body = (await res.json()) as { notifications: { kind: string }[] }
          return body.notifications.filter((n) => n.kind === 'review_status').length
        })
        .toBeGreaterThanOrEqual(2)
      await owner.page.evaluate(() => window.dispatchEvent(new Event('focus')))
      const bell = owner.page.getByTestId('notifications-bell')
      await expect(bell).not.toHaveAttribute('data-unread', '0', { timeout: 75_000 })
      await bell.click()
      const items = owner.page.locator('[data-testid="notification-item"][data-kind="review_status"]')
      await expect(items.filter({ hasText: 'Sam (guest) approved Key art' })).toHaveCount(1)
      await owner.page.keyboard.press('Escape')
    })

    let v2VersionId = ''
    await test.step('4. v2 of the file: its status goes back to Awaiting review, and Compare shows v1 and v2', async () => {
      const v2 = await uploadNewVersion(owner.page, cardId, {
        ...fileFromPath(fixture('video.mp4')),
        name: 'trailer-v2.mp4',
      })
      v2VersionId = v2.facts.versionId
      expect(v2.facts.assetId).toBe(v1.assetId)
      await expect(fileCard(owner.page, 'trailer-v2.mp4')).toHaveAttribute('data-status', 'ready', {
        timeout: 60_000,
      })
      await expect(chipOf(owner.page, cardId)).toHaveText('v2')
      await expect(badgeOf(owner.page, cardId)).toHaveAttribute('data-status', 'pending', { timeout: 10_000 })
      await expect(badgeOf(owner.page, cardId)).toContainText('Awaiting review')
      // the approved frame is not about the file: it stays approved
      await expect(badgeOf(owner.page, frameId)).toHaveAttribute('data-status', 'approved')
      const { body } = await apiReview(owner.page, board)
      expect(body.items.find((i) => i.elementId === cardId)).toMatchObject({
        status: 'pending',
        statusVersionId: v2VersionId,
      })

      await selectNone(owner.page)
      await chipOf(owner.page, cardId).click()
      await owner.page
        .getByTestId('version-list')
        .locator(`[data-version="${v1.versionId}"]`)
        .getByTestId('version-compare')
        .click()
      const rv = viewer(owner.page)
      await expect(rv.getByTestId('compare')).toHaveAttribute('data-kind', 'video')
      await expect(rv.getByTestId('compare-a')).toHaveAttribute(
        'src',
        new RegExp(`/files/${v1.assetId}/${v1.versionId}/original`),
      )
      await expect(rv.getByTestId('compare-b')).toHaveAttribute(
        'src',
        new RegExp(`/files/${v1.assetId}/${v2VersionId}/original`),
      )
      // the header names the version being viewed
      await expect(rv.locator('.dr-rv__title')).toHaveText('trailer-v2.mp4')
      await owner.page.keyboard.press('Escape')
      await expect(rv).toHaveCount(0)
    })

    await test.step('5. a comment at a time on the video (Enter posts it), its marker, a click seeks', async () => {
      await openReview(owner.page, cardId)
      await expect(owner.page.getByTestId('rv-video')).toBeVisible()
      await expect
        .poll(async () => (await videoState(owner.page)).ready, { timeout: 30_000 })
        .toBeGreaterThan(0)
      await owner.page.getByTestId('rv-video-next-second').click()
      await owner.page.getByTestId('rv-video-next-second').click()
      const here = owner.page.getByTestId('rv-comment-here')
      await expect(here).toHaveText('Comment at 00:02.0')
      await here.click()
      // the composer's Enter is React's: the viewer's key stop must not swallow it
      await postInViewer(owner.page, 'Logo pops here')
      const marker = owner.page.getByTestId('rv-marker')
      await expect(marker).toHaveCount(1)
      expect(Math.abs(Number(await marker.getAttribute('data-time-ms')) - 2000)).toBeLessThanOrEqual(40)
      // no key the composer took reached the board: one card, one frame, one note
      expect((await cardItems(owner.page)).map((c) => c.id)).toEqual([cardId])
      await owner.page.getByTestId('rv-video-next-second').click()
      await expect.poll(async () => (await videoState(owner.page)).t).toBeGreaterThan(2.9)
      await marker.click()
      await expect.poll(async () => Math.abs((await videoState(owner.page)).t - 2.0)).toBeLessThan(0.1)
      expect((await videoState(owner.page)).paused).toBe(true)
      await expect(owner.page.getByTestId('rv-thread')).toContainText('Logo pops here')
      const threads = (await (await ownerApi.fetch('GET', `/api/boards/${board}/threads`)).json()) as {
        threads: { anchor: { kind: string; versionId?: string; timeMs?: number } }[]
      }
      // the client's note is a thread on v1 (the version it was about); this one is at a time on v2
      const onFile = threads.threads.filter((t) => t.anchor.kind === 'asset')
      expect(
        onFile
          .map((t) => [t.anchor.versionId, t.anchor.timeMs ?? null])
          .sort((x, y) => Number(x[1] ?? -1) - Number(y[1] ?? -1)),
      ).toEqual([
        [v1.versionId, null],
        [v2VersionId, 2000],
      ])
      await owner.page.getByTestId('review-viewer-close').click()
      await expect(viewer(owner.page)).toHaveCount(0)
    })

    await test.step('6. the summary PDF from the review page: every item, its status and who, the guest footnote', async () => {
      const boardTitle = (await ownerApi.getBoard(board)).board.title
      await owner.page.goto(`/b/${board}?view=review`)
      const p = owner.page
      await expect(reviewPage(p)).toBeVisible({ timeout: 30_000 })
      await expect(reviewItems(p)).toHaveCount(2)
      await expect(p.getByTestId('review-progress')).toContainText('1 of 2 approved')
      const file = await downloadFrom(p, () => p.getByTestId('review-summary-pdf').click())
      expect(file.name).toMatch(/Review summary\.pdf$/)
      const texts = await pdfPageTexts(file.bytes)
      expect(texts.length).toBeGreaterThanOrEqual(3)
      const all = texts.join('\n')
      const cover = texts[0] as string
      expect(cover).toContain('Review summary')
      expect(cover).toContain(boardTitle.split(':')[0] ?? boardTitle)
      expect(cover).toContain('1 Approved')
      expect(cover).toContain('1 Awaiting review')
      expect(cover).toContain('Key art')
      expect(cover).toContain(REVIEW_GUEST_FOOTNOTE)
      expect(all).toContain('Sam (guest)')
      expect(all).toContain('Approved')
      // the file item: about v2 of 2, its history keeps the client's request
      expect(all).toContain('v2 of 2')
      expect(all).toContain('Changes requested')
      await p.getByTestId('review-close').click()
      await expect(reviewPage(p)).toHaveCount(0)
    })

    expect(ownerForeign, 'the owner page asked someone outside Lobby').toEqual([])
  } finally {
    for (const c of contexts) await c.close()
  }
})

test('S-int refusals: a viewer cannot set a status; a name-only guest cannot manage the review', async ({
  canvasSession,
  board,
  browser,
  users,
}) => {
  test.setTimeout(180_000)
  const owner = await canvasSession('alice')
  const ownerApi = await users.api('alice')
  const viewerAccount = await canvasSession('bob', { role: 'viewer' })
  const contexts: { close(): Promise<void> }[] = []
  try {
    const frameId = await frameNamed(owner.page, 'Poster', { x: 0, y: 0 })
    await markFromBar(owner.page, frameId)
    const [item] = (await apiReview(owner.page, board)).body.items
    if (!item) throw new Error('no item')
    const statusPath = `/api/boards/${board}/review/items/${item.id}/status`

    // a viewer account: the badge and the history, no buttons; the api refuses the write
    await expect(badgeOf(viewerAccount.page, frameId)).toContainText('Awaiting review', { timeout: 15_000 })
    const asViewer = await apiReview(viewerAccount.page, board)
    expect(asViewer.body.can).toEqual({ setStatus: false, manage: false })
    const refused = await viewerAccount.context.request.post(statusPath, {
      headers: ORIGIN,
      data: { status: 'approved' },
    })
    expect(refused.status()).toBe(403)

    // a viewer-link guest: refused too
    const viewerToken = await reviewLinkToken(ownerApi, board, 'viewer')
    const vic = await browser.newContext()
    contexts.push(vic)
    const joinedVic = await vic.request.post(`${WEB_URL}/api/invitations/${viewerToken}/guest`, {
      headers: ORIGIN,
      data: { name: 'Vic' },
    })
    expect(joinedVic.status()).toBe(201)
    const vicWrite = await vic.request.post(statusPath, { headers: ORIGIN, data: { status: 'approved' } })
    expect(vicWrite.status()).toBe(403)

    // a name-only guest on a commenter link may answer, never manage
    const commenterToken = await reviewLinkToken(ownerApi, board, 'commenter')
    const ana = await browser.newContext()
    contexts.push(ana)
    const joinedAna = await ana.request.post(`${WEB_URL}/api/invitations/${commenterToken}/guest`, {
      headers: ORIGIN,
      data: { name: 'Ana' },
    })
    expect(joinedAna.status()).toBe(201)
    const manage = [
      ana.request.post(`/api/boards/${board}/review/items`, {
        headers: ORIGIN,
        data: { elementId: 'frame-x', kind: 'frame', label: 'x' },
      }),
      ana.request.patch(`/api/boards/${board}/review/items/${item.id}`, {
        headers: ORIGIN,
        data: { label: 'y' },
      }),
      ana.request.delete(`/api/boards/${board}/review/items/${item.id}`, { headers: ORIGIN }),
      ana.request.post(`/api/boards/${board}/review/rounds`, { headers: ORIGIN, data: {} }),
    ]
    for (const res of await Promise.all(manage)) {
      expect(res.status()).toBe(403)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('GUEST_ACCOUNT_REQUIRED')
    }
    const answered = await ana.request.post(statusPath, {
      headers: ORIGIN,
      data: { status: 'approved' },
    })
    expect(answered.status(), await answered.text()).toBe(200)

    // nothing changed but the guest's answer
    const after = (await apiReview(owner.page, board)).body.items
    expect(after.map((i) => [i.id, i.label, i.status])).toEqual([[item.id, item.label, 'approved']])
  } finally {
    for (const c of contexts) await c.close()
  }
})
