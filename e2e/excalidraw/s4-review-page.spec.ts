// Wave S, WS4: the client review page (`/b/:bid?view=review`) and the review summary PDF, in a real browser.
//  - a review link made with "Open as review page" (the Share dialog's option) lands a client who joins with just a name
//    straight on the page, on a phone (390x844): the items in order with their pictures, a sticky "0 of 3 approved", 44 px
//    buttons, no sideways scroll, and no request leaves Lobby's origin;
//  - Previous / Next move between the items;
//  - the status buttons call WS1's routes with the right bodies (the routes are doubles here: s4-kit.ts ReviewDouble):
//    Approve (confirmed), Request changes (with a note), Back to awaiting review, a status somebody else set meanwhile
//    (409 STATUS_CHANGED → "Approve anyway"), a newer version of a file (409 NEWER_VERSION); a person who may not answer
//    gets no buttons;
//  - the summary PDF is made in the browser (a download, no File System Access picker) and its TEXT is read back: the
//    cover, every item, its status, who and when, the history and every open comment, the guest footnote;
//  - with the switch off the address changes nothing.
import type { Page } from '@playwright/test'
import { expect, test } from '../tests/support/canvas.ts'
import {
  closeShare,
  openMoreWaysToShare,
  openShareFromButton,
  shareDialog,
} from '../tests/support/dashboard-share.ts'
import { downloadFrom, pdfPageTexts, readPdf } from '../tests/support/present-export.ts'
import { commentsApi, shapeAnchor } from './comments-kit.ts'
import { seedDeck } from './present-kit.ts'
import {
  ANA_GUEST,
  createReviewLink,
  joinThroughInvitePage,
  noSideScroll,
  openAs,
  ReviewDouble,
  reviewItems,
  reviewPage,
  WEB_URL,
} from './s4-kit.ts'

/** contracts review.ts REVIEW_GUEST_FOOTNOTE (e2e declares no dependency on the contracts package) */
const REVIEW_GUEST_FOOTNOTE = '(guest): joined with a name only; identity not verified.'
const PHONE = { width: 390, height: 844 }
const FRAMES = [
  { id: 's4-fr-a', name: 'Key art A', x: 0, y: 0, w: 640, h: 360 },
  { id: 's4-fr-b', name: 'Key art B', x: 800, y: 0, w: 640, h: 360 },
  { id: 's4-fr-c', name: 'Teaser', x: 1600, y: 0, w: 640, h: 360 },
] as const

/** alice puts three frames, each with a note, on the board (in a window of her own, closed after). */
async function seedBoard(browser: Parameters<typeof openAs>[0], board: string) {
  const alice = await openAs(browser, 'alice', board)
  await seedDeck(alice.page, {
    frames: FRAMES.map((f) => ({ ...f })),
    notes: FRAMES.map((f, i) => ({
      id: `s4-note-${i}`,
      frame: f.id,
      x: 40,
      y: 40,
      text: `${f.name} headline`,
    })),
  })
  await alice.context.close()
}

const doubleFor = (board: string, over: Partial<ConstructorParameters<typeof ReviewDouble>[2]> = {}) =>
  new ReviewDouble(
    board,
    FRAMES.map((f) => ({ elementId: f.id, label: f.name })),
    over,
  )

/** A name-only guest on a commenter link that opens the review page, on a phone. */
async function guestOnReviewPage(
  browser: Parameters<typeof openAs>[0],
  users: { api(handle: string): Promise<Parameters<typeof createReviewLink>[0]> },
  board: string,
  double: ReviewDouble,
  name = 'Sam Rivera',
) {
  const api = await users.api('alice')
  const link = await createReviewLink(api, board, {
    role: 'commenter',
    allowGuests: true,
    landing: 'review',
  })
  expect(link.landing).toBe('review')
  const guest = await joinThroughInvitePage(browser, link.url, name, { viewport: PHONE, double })
  await expect(guest.page).toHaveURL(/\/b\/[a-z0-9-]+\?view=review$/, { timeout: 30_000 })
  await expect(reviewPage(guest.page)).toBeVisible({ timeout: 30_000 })
  return guest
}

test('a client opens a review link made with "Open as review page" and lands on the page (phone 390x844)', async ({
  browser,
  board,
}, testInfo) => {
  await seedBoard(browser, board)
  const double = doubleFor(board)
  const alice = await openAs(browser, 'alice', board)
  await double.install(alice.context)
  const contexts = [alice.context]
  try {
    // the Share dialog offers the option, ticked for her because the board already has items in review
    await alice.page.reload()
    await openShareFromButton(alice.page)
    await openMoreWaysToShare(alice.page)
    const dialog = shareDialog(alice.page)
    const landing = dialog.getByTestId('review-link-landing')
    await expect(landing).toBeVisible()
    await expect(landing).toBeChecked()
    await expect(landing).toHaveAccessibleName('Open as review page')
    await dialog.getByTestId('review-link-guests').check()
    await dialog.getByTestId('review-link-role').selectOption('commenter')
    await dialog.getByTestId('review-link-create').click()
    const row = dialog.getByTestId('review-link-row')
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('link-opens-review')).toHaveText('opens the review page')
    const url = await row.getByTestId('review-link-url').inputValue()
    expect(url).toMatch(new RegExp(`^${WEB_URL}/invite/[A-Za-z0-9_-]{43}$`))
    await closeShare(alice.page)

    // a client with no account joins with just a name and lands on the review page
    const guestDouble = doubleFor(board)
    const guest = await joinThroughInvitePage(browser, url, 'Sam Rivera', {
      viewport: PHONE,
      double: guestDouble,
    })
    contexts.push(guest.context)
    const g = guest.page
    const foreign: string[] = []
    g.on('request', (r) => {
      const u = new URL(r.url())
      if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.origin !== new URL(WEB_URL).origin)
        foreign.push(r.url())
    })
    await expect(g).toHaveURL(/\/b\/[a-z0-9-]+\?view=review$/, { timeout: 30_000 })
    await expect(reviewPage(g)).toBeVisible({ timeout: 30_000 })

    // the items, in order, with their words
    await expect(reviewItems(g)).toHaveCount(3)
    await expect(g.getByTestId('review-item-label')).toHaveText(['Key art A', 'Key art B', 'Teaser'])
    await expect(g.getByTestId('review-progress')).toContainText('0 of 3 approved')
    await expect(g.getByTestId('review-progress')).toContainText('3 awaiting review')
    await expect(reviewItems(g).first().getByTestId('review-item-status')).toContainText('Awaiting review')

    // a picture of the first frame (drawn by the exporter), not a placeholder
    const first = reviewItems(g).first().getByTestId('review-item-picture')
    await expect(first).toHaveAttribute('data-state', 'ready', { timeout: 45_000 })
    const natural = await first.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)
    expect(natural).toBeGreaterThan(300)
    // the board's first-view code drops deep-link parameters from the address: `?view=review` is not one of them
    await expect(g).toHaveURL(/\/b\/[a-z0-9-]+\?view=review$/)

    // phone: nothing scrolls sideways, targets are 44 px, the page fills the screen
    expect(await noSideScroll(g)).toBe(true)
    for (const id of ['review-approve', 'review-request-changes', 'review-prev', 'review-next']) {
      const box = await g.getByTestId(id).first().boundingBox()
      expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(44)
      expect(box?.width ?? 0, id).toBeGreaterThanOrEqual(44)
    }
    const panel = await reviewPage(g).boundingBox()
    expect(panel?.width).toBe(PHONE.width)
    expect(panel?.height).toBe(PHONE.height)
    // a client on a commenter link: no summary button while the board's export policy is the client-link default
    await expect(g.getByTestId('review-summary-pdf')).toHaveCount(0)
    await testInfo.attach('review-page-390.png', { body: await g.screenshot(), contentType: 'image/png' })

    // the page makes the requests of the board and the review (its own origin), nothing else
    expect(foreign).toEqual([])
    expect(guestDouble.calls.some((c) => c.method === 'GET' && c.path.endsWith('/review'))).toBe(true)

    // "Open the board" leaves the page for the board
    await g.getByTestId('review-close').click()
    await expect(reviewPage(g)).toHaveCount(0)
    await expect(g).toHaveURL(/\/b\/[a-z0-9-]+$/)
  } finally {
    await Promise.all(contexts.map((c) => c.close()))
  }
})

test('Previous and Next move between the items', async ({ browser, board, users }) => {
  await seedBoard(browser, board)
  const guest = await guestOnReviewPage(browser, users, board, doubleFor(board))
  try {
    const g = guest.page
    const position = g.getByTestId('review-position')
    await expect(position).toHaveText('1 of 3')
    await expect(g.getByTestId('review-prev')).toBeDisabled()
    await expect(reviewItems(g).nth(0)).toHaveAttribute('data-active', 'true')

    await g.getByTestId('review-next').click()
    await expect(position).toHaveText('2 of 3')
    await expect(reviewItems(g).nth(1)).toHaveAttribute('data-active', 'true')
    // the second item is what is on screen now (its top is at the top of the list)
    await expect
      .poll(async () => {
        const [scroll, card] = await Promise.all([
          g.getByTestId('review-scroll').boundingBox(),
          reviewItems(g).nth(1).boundingBox(),
        ])
        return Math.abs((card?.y ?? 9999) - (scroll?.y ?? 0)) < 40
      })
      .toBe(true)

    await g.getByTestId('review-next').click()
    await expect(position).toHaveText('3 of 3')
    await expect(g.getByTestId('review-next')).toBeDisabled()
    await g.getByTestId('review-prev').click()
    await expect(position).toHaveText('2 of 3')
    await g.getByTestId('review-prev').click()
    await expect(position).toHaveText('1 of 3')
    await expect(g.getByTestId('review-prev')).toBeDisabled()
  } finally {
    await guest.context.close()
  }
})

test('the status buttons call the right routes: Approve (confirmed), Request changes (with a note), Back, a conflict, a newer version; a person who may not answer gets none', async ({
  browser,
  board,
  users,
}) => {
  await seedBoard(browser, board)
  const double = doubleFor(board)
  const guest = await guestOnReviewPage(browser, users, board, double)
  try {
    const g = guest.page
    const item = (n: number) => reviewItems(g).nth(n - 1)

    // Approve is two taps: the button, then Confirm
    await item(1).getByTestId('review-approve').click()
    await expect(item(1).getByTestId('review-confirm')).toContainText('Approve “Key art A”?')
    expect(double.statusCalls()).toHaveLength(0)
    await item(1).getByTestId('review-approve-confirm').click()
    await expect(item(1).getByTestId('review-item-status')).toContainText('Approved · Sam Rivera (guest)')
    expect(double.statusCalls()).toHaveLength(1)
    expect(double.statusCalls()[0]).toMatchObject({
      method: 'POST',
      path: `/api/boards/${board}/review/items/${double.itemId(1)}/status`,
      body: { status: 'approved', fromSeq: 0 },
    })
    await expect(g.getByTestId('review-progress')).toContainText('1 of 3 approved')
    await expect(g.getByTestId('review-live')).toContainText('Key art A: approved')
    await expect(item(1)).toHaveAttribute('data-status', 'approved')

    // Request changes asks for a note, and sends it with the status
    await item(2).getByTestId('review-request-changes').click()
    const note = item(2).getByTestId('review-note')
    await expect(note).toBeFocused()
    await expect(note).toHaveAttribute('placeholder', 'What should change?')
    await note.fill('Make the logo bigger')
    await item(2).getByTestId('review-note-send').click()
    await expect(item(2).getByTestId('review-item-status')).toContainText(
      'Changes requested · Sam Rivera (guest)',
    )
    expect(double.statusCalls()[1]).toMatchObject({
      path: `/api/boards/${board}/review/items/${double.itemId(2)}/status`,
      body: { status: 'changes_requested', fromSeq: 0, note: 'Make the logo bigger' },
    })
    await expect(g.getByTestId('review-progress')).toContainText('1 with changes requested')

    // Back to awaiting review
    await item(1).getByTestId('review-back').click()
    await expect(item(1).getByTestId('review-item-status')).toContainText('Awaiting review')
    expect(double.statusCalls()[2]).toMatchObject({ body: { status: 'pending', fromSeq: 1 } })

    // somebody else answered item 3 meanwhile: the page says so and asks before it overwrites
    double.changeBehindTheBack(3, 'changes_requested', ANA_GUEST)
    await item(3).getByTestId('review-approve').click()
    await item(3).getByTestId('review-approve-confirm').click()
    const conflict = item(3).getByTestId('review-conflict')
    await expect(conflict).toContainText('Ana (guest) just set this to Changes requested.')
    await expect(item(3).getByTestId('review-item-status')).toContainText('Changes requested · Ana (guest)')
    await conflict.getByTestId('review-conflict-anyway').click()
    await expect(item(3).getByTestId('review-item-status')).toContainText('Approved · Sam Rivera (guest)')
    const last = double.statusCalls().at(-1)
    expect(last?.body).toEqual({ status: 'approved' }) // no fromSeq: the person chose to overwrite

    // "Keep theirs" leaves it as it is
    double.changeBehindTheBack(2, 'approved', ANA_GUEST)
    await item(2).getByTestId('review-back').click()
    await expect(item(2).getByTestId('review-conflict')).toContainText(
      'Ana (guest) just set this to Approved.',
    )
    await item(2).getByTestId('review-conflict-keep').click()
    await expect(item(2).getByTestId('review-item-status')).toContainText('Approved · Ana (guest)')

    // a newer version of a file: asked to reload, nothing set
    double.failNext(409, {
      error: { code: 'NEWER_VERSION', message: 'A newer version exists.' },
      latestVersionId: 'ver_s4newer000001',
    })
    await item(1).getByTestId('review-approve').click()
    await item(1).getByTestId('review-approve-confirm').click()
    await expect(item(1).getByTestId('review-error')).toContainText(
      'A newer version of this file was just added',
    )
    await expect(item(1).getByTestId('review-item-status')).toContainText('Awaiting review')

    // a person who may not answer sees the statuses and no buttons
    double.can.setStatus = false
    await g.reload()
    await expect(reviewPage(g)).toBeVisible({ timeout: 30_000 })
    await expect(reviewItems(g)).toHaveCount(3)
    await expect(g.getByTestId('review-readonly')).toBeVisible()
    await expect(g.getByTestId('review-controls')).toHaveCount(0)
    await expect(g.getByTestId('review-approve')).toHaveCount(0)
    await expect(item(3).getByTestId('review-item-status')).toContainText('Approved')
  } finally {
    await guest.context.close()
  }
})

/** Counts File System Access picker calls (a picker is a download Playwright's events never see) and rejects them. */
async function countPickers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>
    const counts: Record<string, number> = {}
    Object.defineProperty(window, '__s4Pickers', { value: counts })
    for (const name of ['showSaveFilePicker', 'showOpenFilePicker', 'showDirectoryPicker']) {
      counts[name] = 0
      w[name] = () => {
        counts[name] = (counts[name] ?? 0) + 1
        return Promise.reject(new DOMException('The user aborted a request.', 'AbortError'))
      }
    }
  })
  return () =>
    page.evaluate(() => ({
      ...((window as unknown as { __s4Pickers?: Record<string, number> }).__s4Pickers ?? {}),
    }))
}

test('the summary PDF is made in the browser: a download whose text holds every item, status, who, history and open comment', async ({
  browser,
  board,
  users,
}) => {
  await seedBoard(browser, board)
  const aliceApi = await users.api('alice')
  const comments = commentsApi(aliceApi)
  const thread = await comments.createThread(
    board,
    shapeAnchor('s4-fr-a', 1, 0),
    'Please warm up the colours',
  )
  await comments.reply(thread.id, 'Thanks, will do')
  const boardTitle = (await aliceApi.getBoard(board)).board.title

  const double = doubleFor(board, { actor: { id: null, name: 'Alice', kind: 'account', external: false } })
  const stamp = '2026-10-15T12:00:00.000Z'
  Object.assign(double.item(1), { status: 'approved', statusBy: ANA_GUEST, statusAt: stamp, statusSeq: 1 })
  Object.assign(double.item(2), {
    status: 'changes_requested',
    statusBy: { id: null, name: 'Carol Outside', kind: 'account', external: true },
    statusAt: stamp,
    statusSeq: 1,
  })
  double.events.set(double.itemId(1), [
    {
      id: 'rve_s4event0000001',
      itemId: double.itemId(1),
      roundId: null,
      kind: 'status',
      status: 'approved',
      previousStatus: 'pending',
      reason: 'set',
      versionId: null,
      threadId: null,
      actor: ANA_GUEST,
      itemCount: null,
      createdAt: stamp,
      seq: 1,
    },
  ])

  const alice = await openAs(browser, 'alice', board, { path: `/b/${board}?view=review` })
  await double.install(alice.context)
  const pickers = await countPickers(alice.page)
  try {
    await alice.page.reload()
    const p = alice.page
    await expect(reviewPage(p)).toBeVisible({ timeout: 30_000 })
    await expect(reviewItems(p)).toHaveCount(3)
    await expect(p.getByTestId('review-progress')).toContainText('1 of 3 approved')
    // the open comment shows on its item, with its reply
    const first = reviewItems(p).first()
    await expect(first.getByTestId('review-thread')).toHaveCount(1)
    await expect(first.getByTestId('review-thread')).toContainText('Please warm up the colours')
    await expect(first.getByTestId('review-thread')).toContainText('Thanks, will do')

    const file = await downloadFrom(p, () => p.getByTestId('review-summary-pdf').click())
    expect(file.name).toBe(
      `${boardTitle.replace(/[:*?"<>|/\\]/g, '')} - Review summary.pdf`.replace(/\s+/g, ' '),
    )
    await expect(p.getByTestId('review-summary-status')).toContainText('Saved', { timeout: 30_000 })
    expect(await pickers()).toEqual({ showSaveFilePicker: 0, showOpenFilePicker: 0, showDirectoryPicker: 0 })

    const pdf = await readPdf(file.bytes)
    // the cover, then one page per item
    expect(pdf.pages).toHaveLength(4)
    const texts = await pdfPageTexts(file.bytes)
    expect(texts).toHaveLength(4)
    const cover = texts[0] as string
    expect(cover).toContain('Review summary')
    expect(cover).toContain(boardTitle.split(':')[0] ?? boardTitle)
    expect(cover).toContain('1 Approved')
    expect(cover).toContain('1 Changes requested')
    expect(cover).toContain('1 Awaiting review')
    for (const label of ['Key art A', 'Key art B', 'Teaser']) expect(cover).toContain(label)
    expect(cover).toContain('Generated by')
    expect(cover).toContain(REVIEW_GUEST_FOOTNOTE)

    // item 1: status, who and when, its history, its picture and every open comment with the reply
    const one = texts[1] as string
    expect(one).toContain('Key art A')
    expect(one).toContain('Item 1 of 3')
    expect(one).toContain('Approved')
    expect(one).toContain('Ana (guest)')
    expect(one).toContain('Oct 15, 2026')
    expect(one).toContain('History')
    expect(one).toContain('Open comments (1)')
    expect(one).toContain('Please warm up the colours')
    expect(one).toContain('Thanks, will do')
    expect(one).toContain(REVIEW_GUEST_FOOTNOTE)
    expect(pdf.pages[1]?.images.length).toBeGreaterThan(0)

    // item 2: an outside account is tagged; item 3 has no answer yet and no comments
    const two = texts[2] as string
    expect(two).toContain('Changes requested')
    expect(two).toContain('Carol Outside · External')
    expect(two).toContain('No open comments.')
    const three = texts[3] as string
    expect(three).toContain('Teaser')
    expect(three).toContain('Awaiting review')

    // one bookmark per page, named for what is on it
    expect(pdf.outline.map((o) => o.title)).toEqual(['Review summary', 'Key art A', 'Key art B', 'Teaser'])
  } finally {
    await alice.context.close()
  }
})

test('with the review page switch off the address changes nothing', async ({ browser, board }) => {
  await seedBoard(browser, board)
  const alice = await openAs(browser, 'alice', board, { path: `/b/${board}?view=review`, flag: false })
  try {
    await expect(alice.page.getByTestId('lobby-board')).toBeVisible()
    await alice.page.waitForTimeout(1500)
    await expect(reviewPage(alice.page)).toHaveCount(0)
    await expect(alice.page.getByTestId('share-button')).toBeVisible()
  } finally {
    await alice.context.close()
  }
})
