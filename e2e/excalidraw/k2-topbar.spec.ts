// K2-5 (wave K, UXD-01, F3, UXP-11, UXP-5): the calmer top bar. One status dot for Saved and Live, no comment
// tool in the bar (the toolbar's Comment stays), "Shared outside" as a badge on Share with the sharing link
// badge against it, an always-visible Feedback pill, the H1 named by the title alone, and on a phone the bell
// and the comment tool in "⋯". The count of visible controls (at most 8 with a client link and a vote running)
// needs K3's Facilitate grouping: before it lands the count is recorded and that one check is skipped.
import fs from 'node:fs'
import type { Page } from '@playwright/test'
import { createNote, expect, expectSaved, test, waitForCanvas } from '../tests/support/canvas.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const online = (page: Page) =>
  expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', { timeout: 30_000 })

/** The visible controls on the bar's right side (after the title) and the account, by test id or name. */
async function visibleControls(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-testid="topbar"]')
    const account = document.querySelector('.dr-board__account')
    const spacer = bar?.querySelector('.dr-topbar__spacer')
    const out: string[] = []
    const seen = (el: Element) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      if (r.width < 4 || r.height < 4) return false
      const s = getComputedStyle(el)
      return (
        s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('[hidden], [aria-hidden="true"]')
      )
    }
    const controls = [...(bar?.querySelectorAll('button, a[href], [role="button"]') ?? [])]
    for (const el of controls) {
      // only the right side: what comes after the spacer in the bar's order
      if (spacer && !(spacer.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
      // a control inside another (a badge inside Share) is that control
      if (el.parentElement?.closest('button')) continue
      if (seen(el))
        out.push(
          el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '?',
        )
    }
    for (const el of account?.querySelectorAll('button, a[href]') ?? [])
      if (seen(el)) out.push(el.getAttribute('data-testid') ?? 'account')
    return out
  })
}

test('K2-5: one status dot says Saved and Live; no comment tool in the bar; the H1 is the title alone; Feedback opens the dialog', async ({
  canvasSession,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  await online(a.page)
  await createNote(a.page, { x: 0, y: 0, text: 'Hello' })
  await expectSaved(a.page)

  const status = a.page.getByTestId('board-status')
  await expect(status).toBeVisible()
  await expect(status).toHaveAttribute('data-tone', 'ok')
  await expect(a.page.getByTestId('save-status')).toHaveText('Saved')
  await expect(a.page.getByTestId('conn-status')).toHaveText('Live')
  await expect(status).toHaveAttribute('title', /^Saved: .*Connected: /)
  // drawn in the live colour (green), not the busy grey
  const colours = await status.evaluate((el) => {
    const dot = el.querySelector('.dr-status__dot') as HTMLElement
    const probe = document.createElement('span')
    probe.style.color = 'var(--dr-live)'
    el.appendChild(probe)
    const live = getComputedStyle(probe).color
    probe.remove()
    return { dot: getComputedStyle(dot).backgroundColor, live }
  })
  expect(colours.dot).toBe(colours.live)
  // the dot alone: no "Saved" and "Live" pills any more
  await expect(a.page.locator('[data-testid="topbar"] .dr-status__label')).toHaveCount(0)
  await expect(a.page.locator('[data-testid="topbar"] .dr-pill--online')).toHaveCount(0)

  // "Saved" is read once: no empty status node beside it, and edits are not announced
  const announcer = a.page.getByTestId('save-announcer')
  await expect(announcer).not.toHaveAttribute('role', /.+/)
  await expect(announcer).toHaveAttribute('aria-live', 'polite')
  await expect(a.page.locator('[data-testid="topbar"] [role="status"]')).toHaveCount(0)
  await expect(announcer).toHaveText('')

  // the comment tool left the bar; the toolbar has it, the bell stays
  await expect(a.page.getByTestId('comment-tool')).toHaveCount(0)
  await expect(a.page.getByTestId('tools.comment')).toBeVisible()
  await expect(a.page.getByTestId('notifications-bell')).toBeVisible()

  // UXP-11: the H1's name is the title; its button is "Rename board"
  const title = ((await a.page.getByTestId('board-title').textContent()) ?? '').trim()
  await expect(a.page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible()
  await expect(a.page.getByRole('button', { name: 'Rename board', exact: true })).toBeVisible()

  // F3: the Feedback pill opens wave J5's dialog about this board; the keyboard comes back to the pill
  const pill = a.page.getByTestId('topbar-feedback')
  await expect(pill).toBeVisible()
  await pill.click()
  const dialog = a.page.getByTestId('feedback-dialog')
  await expect(dialog.getByRole('heading', { name: 'Send feedback' })).toBeVisible()
  await expect(a.page.getByTestId('feedback-context-board')).toContainText(title)
  await a.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(pill).toBeFocused()
  await a.page.screenshot({
    path: testInfo.outputPath('k2-5-topbar-1440.png'),
    clip: { x: 0, y: 0, width: 1440, height: 60 },
  })
})

test('K2-5: with a client link and a vote running: Shared outside is a badge on Share, the link badge sits against it, at most 8 controls (with K3)', async ({
  canvasSession,
  board,
  users,
}, testInfo) => {
  const a = await canvasSession('alice')
  await waitForCanvas(a.page)
  await online(a.page)
  const api = await users.api('alice')
  const link = await api.fetch('POST', `/api/boards/${board}/review-links`, {
    role: 'commenter',
    expiresInDays: 14,
    allowGuests: true,
  })
  expect(link.status()).toBe(201)
  await createNote(a.page, { x: 0, y: 0, text: 'Option A' })
  await expectSaved(a.page)
  const vote = await api.fetch('POST', `/api/boards/${board}/votes`, {
    title: 'Pick a direction',
    votesPerPerson: 3,
    onePerObject: false,
    scope: 'board',
  })
  expect(vote.status()).toBeLessThan(300)

  const share = a.page.getByTestId('share-button')
  const outside = a.page.getByTestId('topbar-shared-outside')
  await expect(outside).toBeVisible()
  await expect(outside).toHaveAttribute('title', /outside Dark Burn/)
  // the badge is on Share (inside it); Share's name stays "Share", its description says it
  expect(await share.locator('[data-testid="topbar-shared-outside"]').count()).toBe(1)
  await expect(share).toHaveAccessibleName('Share')
  await expect(share).toHaveAccessibleDescription(/^Shared outside: .*outside Dark Burn/)
  // the link badge: its icon alone, against Share (its words stay its name)
  const badge = a.page.getByTestId('share-badge')
  await expect(badge).toBeVisible()
  const [b, s] = await Promise.all([badge.boundingBox(), share.boundingBox()])
  if (!b || !s) throw new Error('no badge or Share box')
  expect(Math.abs(s.x - (b.x + b.width))).toBeLessThanOrEqual(4)
  await expect(badge).toHaveAttribute('aria-label', /^Link: comment/)
  // the vote is running: K3-3 shows it in the Facilitate button's pill (the vote chip is in its menu)
  await expect(a.page.getByTestId('facilitate-pill')).toContainText('Vote')

  const controls = await visibleControls(a.page)
  await testInfo.attach('k2-5-controls.json', {
    body: JSON.stringify(controls, null, 2),
    contentType: 'application/json',
  })
  fs.writeFileSync(testInfo.outputPath('k2-5-controls.json'), JSON.stringify(controls, null, 2))
  await a.page.screenshot({
    path: testInfo.outputPath('k2-5-topbar-link-vote.png'),
    clip: { x: 0, y: 0, width: 1440, height: 60 },
  })
  // K2's part, whatever K3 has done: no comment tool, one status dot (not a control), Feedback is there
  expect(controls).not.toContain('comment-tool')
  expect(controls).toContain('topbar-feedback')
  expect(controls).toContain('share-button')
  // K3's Facilitate grouping takes the timer, the vote chip and reactions into one button and the export icon out
  const ungrouped = controls.filter((c) =>
    ['timer-pill', 'vote-chip', 'reactions-button', 'export-button'].includes(c),
  )
  // wave K integration: K3 is merged, so this is a check, not a skip
  expect(ungrouped, controls.join(', ')).toEqual([])
  expect(controls.length, controls.join(', ')).toBeLessThanOrEqual(8)
})

test('K2-5: on a 375 px phone the bell, the comment tool, Feedback and the account are in "⋯"; the dot and Share stay', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  await a.page.setViewportSize({ width: 375, height: 812 })
  await waitForCanvas(a.page)
  await online(a.page)
  const bar = a.page.getByTestId('topbar')
  await expect(bar.getByTestId('board-status')).toBeVisible()
  await expect(bar.getByTestId('share-button')).toBeVisible()
  for (const id of ['notifications-bell', 'comment-tool', 'topbar-feedback'])
    await expect(a.page.getByTestId(id), id).toBeHidden()
  await a.page.getByTestId('topbar-overflow').click()
  const panel = a.page.getByTestId('topbar-overflow-panel')
  await expect(panel).toHaveAttribute('data-open', 'true')
  for (const id of ['notifications-bell', 'comment-tool', 'topbar-feedback'])
    await expect(panel.getByTestId(id), id).toBeVisible()
  await expect(panel).toContainText('Your account')
  // the comment tool from the menu picks the tool; the next press on the board closes the menu and places the
  // new comment there (the phone flow a11y-phone-reach.spec.ts W5-07 now takes: "⋯", then Comment tool)
  await panel.getByTestId('comment-tool').click()
  await expect(panel.getByTestId('comment-tool')).toHaveAttribute('aria-pressed', 'true')
  const c = await a.page.locator('[data-lobby-board-canvas]').boundingBox()
  if (!c) throw new Error('no canvas')
  // below the empty board's start card (its buttons take clicks)
  await a.page.mouse.click(c.x + c.width / 2, c.y + c.height * 0.62)
  await expect(panel).toHaveAttribute('data-open', 'false')
  await expect(a.page.getByTestId('new-comment-popover')).toBeVisible()
})
