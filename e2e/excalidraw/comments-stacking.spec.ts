// OWNER: 3c. Where the comment popovers sit against the Excalidraw board page's chrome (the early wave-5
// review, docs/research/excalidraw/REVIEW-W5-EARLY.md W5-07, 3c's part "comment sheet stacking"):
//  - on a phone the new-comment sheet and the thread sheet are on top of the board's chrome (the tool dock,
//    the navigation slot and 3i's floating "Board actions" button), so every point of the text box and the
//    Post / Reply button can be tapped (the tldraw page's sheet covered tldraw's tools the same way);
//  - on a laptop a thread popover low on the board stays above the toolbar's row, so its reply box, the
//    "@ to mention" hint and Reply are not under the toolbar, and nothing of it is cut off at the bottom.
// Each check asks the browser what is on top (`elementFromPoint`) across the control. And W5-49 (both
// builds; the tldraw one is in tests/comments.spec.ts): a marker's initials stay at 4.5:1 on its face,
// also on the faded face of a thread you have read (comments/pin-face.ts).
import type { Browser, Locator, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import {
  createNote,
  expect,
  expectSaved,
  item,
  setViewport,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import type { TestUser } from '../tests/support/users.ts'
import {
  canvasRect,
  centerOn,
  commentsApi,
  newCommentPopover,
  pin,
  pins,
  screenPointOnElement,
  shapeAnchor,
  threadPopover,
} from './comments-kit.ts'

/** A board page in a context of our own (a phone: touch and a small viewport). */
async function openWith(
  browser: Browser,
  board: string,
  user: TestUser,
  options: Parameters<Browser['newContext']>[0],
) {
  const context = await browser.newContext(options)
  await signInContext(context, user.handle, user.name)
  const page = await context.newPage()
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  return { context, page }
}

/** Points across a control (fractions of its box) where something else is on top, with what it is. */
async function coveredPoints(target: Locator, points: readonly (readonly [number, number])[]) {
  return target.evaluate((el, pts) => {
    const r = el.getBoundingClientRect()
    const out: string[] = []
    for (const [u, v] of pts) {
      const x = r.left + u * r.width
      const y = r.top + v * r.height
      const hit = document.elementFromPoint(x, y)
      if (hit && (hit === el || el.contains(hit))) continue
      const who = hit
        ? `${hit.tagName.toLowerCase()}${hit.getAttribute('data-testid') ? `[${hit.getAttribute('data-testid')}]` : ''}.${String(hit.className).slice(0, 40)}`
        : 'nothing'
      out.push(`(${u}, ${v}) under ${who}`)
    }
    return out
  }, points)
}

/**
 * W5-49: the contrast of each open thread's marker initials on its face as the page draws them (the face's
 * opacity over the marker's white included).
 */
const pinInkContrasts = (page: Page) =>
  page.evaluate(() => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number)
    const lum = (c: number[]) => {
      const f = (v: number) => {
        const x = v / 255
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(c[0] ?? 0) + 0.7152 * f(c[1] ?? 0) + 0.0722 * f(c[2] ?? 0)
    }
    const over = (c: number[], a: number, under: number[]) =>
      [0, 1, 2].map((i) => (c[i] ?? 0) * a + (under[i] ?? 0) * (1 - a))
    const white = [255, 255, 255]
    return [...document.querySelectorAll('[data-testid="comment-pin"]')]
      .filter((p) => p.getAttribute('data-state') !== 'resolved')
      .map((p) => {
        const s = getComputedStyle(p.querySelector('.dr-cpin__face') as Element)
        const op = Number(s.opacity)
        const bg = rgb(s.backgroundColor)
        const face = over(bg, bg[3] ?? 1, white)
        const ink = over(rgb(s.color), 1, face)
        const a = lum(over(face, op, white))
        const b = lum(over(ink, op, white))
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        return `${p.getAttribute('data-state')} ${Math.round(ratio * 100) / 100}`
      })
  })

/** Across a text box: left to right, through its middle and near its bottom edge. */
const ACROSS: readonly (readonly [number, number])[] = [
  [0.04, 0.5],
  [0.25, 0.5],
  [0.5, 0.5],
  [0.75, 0.5],
  [0.96, 0.5],
  [0.5, 0.9],
  [0.96, 0.9],
]
const MIDDLE: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.15, 0.5],
  [0.85, 0.5],
]

async function expectAllOnTop(popover: Locator) {
  const box = popover.getByTestId('comment-composer')
  await expect(box).toBeVisible()
  expect(await coveredPoints(box, ACROSS), 'every point of the text box can be tapped').toEqual([])
  expect(await coveredPoints(popover.getByTestId('comment-submit'), MIDDLE), 'the submit button').toEqual([])
}

test('W5-07: on a phone the new-comment and thread sheets are on top of the dock, the tools and Board actions', async ({
  browser,
  board,
  users,
}) => {
  const alice = await users.get('alice')
  const { context, page } = await openWith(browser, board, alice, {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  try {
    const note = await createNote(page, { x: 0, y: 0, text: 'Key art' })
    await expectSaved(page)
    await centerOn(page, note, 1)
    // the board's chrome the review found over the sheet is there
    await expect(page.getByTestId('phone-sheet-open')).toBeVisible()

    // a new comment: the comment tool, then a tap on the note
    await page.evaluate(() => {
      const b = (window as unknown as { __lobbyBoard: { canvas: { setTool(t: string): void } } }).__lobbyBoard
      b.canvas.setTool('comment')
    })
    const at = await screenPointOnElement(page, note, 0.5, 0.3)
    await page.touchscreen.tap(at.x, at.y)
    const composer = newCommentPopover(page)
    await expect(composer).toBeVisible()
    await expect(composer).toHaveAttribute('data-docked', 'true')
    await expectAllOnTop(composer)
    // a tap on the right of the box types into it (the review: it opened Board actions)
    const field = composer.getByTestId('comment-composer')
    const fb = await field.boundingBox()
    if (!fb) throw new Error('no composer box')
    await page.touchscreen.tap(fb.x + fb.width - 12, fb.y + fb.height / 2)
    await expect(field).toBeFocused()
    await expect(page.getByTestId('phone-sheet')).toHaveCount(0)
    await page.keyboard.type('Warmer, please')
    await composer.getByTestId('comment-submit').tap()
    await expect(composer).toHaveCount(0)

    // the thread sheet: its reply box and Reply
    const thread = threadPopover(page)
    await expect(thread).toBeVisible()
    await expect(thread).toHaveAttribute('data-docked', 'true')
    await expectAllOnTop(thread)
    const reply = thread.getByTestId('comment-composer')
    const rb = await reply.boundingBox()
    if (!rb) throw new Error('no reply box')
    await page.touchscreen.tap(rb.x + rb.width - 12, rb.y + rb.height / 2)
    await expect(reply).toBeFocused()
    await expect(page.getByTestId('phone-sheet')).toHaveCount(0)

    // closed, the board's chrome is usable again
    await thread.getByRole('button', { name: /close/i }).first().tap()
    await expect(thread).toHaveCount(0)
    expect(await coveredPoints(page.getByTestId('phone-sheet-open'), MIDDLE)).toEqual([])
  } finally {
    await context.close()
  }
})

test('W5-07: on a laptop a thread low on the board opens above the toolbar, with its reply box, hint and Reply clear of it', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await a.page.setViewportSize({ width: 1280, height: 720 })
  const note = await createNote(a.page, { x: 0, y: 0, text: 'Story' })
  await expectSaved(a.page)
  const api = commentsApi(await users.api('alice'))
  const t = await api.createThread(board, shapeAnchor(note, 0.5, 0.9), 'Can the story beat land earlier?')
  for (const body of [
    'Agreed, the second act drags a little.',
    'We could swap the montage and the reveal.',
    'Let me try a cut with the reveal first and post it here.',
  ])
    await api.reply(t.id, body)
  // the thread's anchor low on the board, clear of the toolbar: 72 % of the canvas height, in the middle
  const el = await item(a.page, note)
  if (!el) throw new Error('no note')
  const r = await canvasRect(a.page)
  const anchor = { x: el.x + el.width * 0.5, y: el.y + el.height * 0.9 }
  await setViewport(a.page, { x: anchor.x - r.width / 2, y: anchor.y - r.height * 0.72, zoom: 1 })
  await expect(pin(a.page, t.id)).toBeVisible()
  await pin(a.page, t.id).click()
  const popover = threadPopover(a.page, t.id)
  await expect(popover).toBeVisible()
  await expect(popover).toHaveAttribute('data-docked', 'false')
  await expect(popover.getByTestId('comment-item')).toHaveCount(4)

  const toolbar = await a.page.locator('[data-lobby-slot="toolbar"]').boundingBox()
  const box = await popover.boundingBox()
  if (!toolbar || !box) throw new Error('no toolbar or popover box')
  // nothing of the popover is cut off by the bottom of the canvas, and it ends above the toolbar's row
  expect(box.y + box.height).toBeLessThanOrEqual(r.y + r.height)
  expect(box.y + box.height).toBeLessThanOrEqual(toolbar.y)
  await expectAllOnTop(popover)
  expect(await coveredPoints(popover.locator('.dr-ccomposer__hint'), MIDDLE), 'the composer hint').toEqual([])
})

test('W5-49: every marker’s initials are 4.5:1 or more on its face, read or unread', async ({
  board,
  users,
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const note = await createNote(a.page, { x: 0, y: 0, text: 'Palette' })
  await expectSaved(a.page)
  await centerOn(a.page, note, 1)
  const ids: string[] = []
  for (const [who, u] of [
    ['alice', 0.2],
    ['bob', 0.5],
    ['carol', 0.8],
  ] as const) {
    if (who !== 'alice') await users.grant(board, who, 'editor')
    const thread = await commentsApi(await users.api(who)).createThread(board, shapeAnchor(note, u, 0.5), who)
    ids.push(thread.id)
  }
  await expect(pins(a.page)).toHaveCount(3)
  // alice's own thread is read; bob's turns read once she opens it; carol's stays unread
  await expect(pin(a.page, ids[0] ?? '')).toHaveAttribute('data-state', 'read')
  await pin(a.page, ids[1] ?? '').click()
  await expect(pin(a.page, ids[1] ?? '')).toHaveAttribute('data-state', 'read')
  await a.page.keyboard.press('Escape')
  await expect(threadPopover(a.page)).toHaveCount(0)
  await expect(pin(a.page, ids[2] ?? '')).toHaveAttribute('data-state', 'unread')
  const ratios = await pinInkContrasts(a.page)
  expect(ratios).toHaveLength(3)
  for (const r of ratios) expect(Number(r.split(' ')[1]), r).toBeGreaterThanOrEqual(4.5)
})
