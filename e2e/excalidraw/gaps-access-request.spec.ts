// GAP PASS (browser-test gaps on the Excalidraw canvas): asking for access FROM the new canvas, and an
// approval reaching a waiting page.
//
// permissions-canvas covers roles and revocation; board-open covers that a read-only drag changes nothing.
// Nobody drives the Lobby board page's blocked-edit hint (LobbyBoardPage.tsx: a read-only person's drag,
// double-click or Delete shows one hint naming an owner, with "Request"), the role pill's request form, the
// owner's approval in Share, or the no-access screen opening the Excalidraw canvas by itself once approved
// (the tldraw suite's PRI-08/PRI-09b and dashboard-share "request access" were never ported).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw gaps-access-request
import type { Page } from '@playwright/test'
import {
  canvasCall,
  createNote,
  dragItem,
  expect,
  expectSaved,
  item,
  readOnly,
  test,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import {
  accessRequests,
  closeShare,
  memberRow,
  requestRow,
  shareDialog,
  signedInContext,
} from '../tests/support/dashboard-share.ts'
import { pushCount } from '../tests/support/excalidraw.ts'

const xOf = async (page: Page, id: string) => Math.round(((await item(page, id)) as { x: number }).x)

test('a commenter’s drag on the new canvas shows one hint naming the owner, with Request; the role pill opens the same form; once alice approves in Share the pill goes, the canvas is writable and a drag moves the note for everyone', async ({
  canvasSession,
  users,
  board,
}) => {
  const a = await canvasSession('alice')
  const note = await createNote(a.page, { x: 300, y: 240, text: 'Try to move me' })
  await expectSaved(a.page)
  const c = await canvasSession('carol', { role: 'commenter' })
  await waitForItem(c.page, note)
  expect(await readOnly(c.page)).toBe(true)
  const before = await xOf(c.page, note)

  await test.step('the first blocked drag explains, once, and names who to ask; nothing moved or was pushed', async () => {
    await dragItem(c.page, note, { x: 80, y: 50 })
    const hint = c.page.getByTestId('blocked-edit-hint')
    await expect(hint).toContainText(`You can comment on this board. Ask ${a.name} for edit access.`)
    await hint.getByTestId('blocked-edit-request').click()
    await expect(shareDialog(c.page).getByTestId('share-ask-section')).toBeVisible()
    await expect(shareDialog(c.page).getByTestId('access-request-role')).toBeFocused()
    await closeShare(c.page)
    expect(await xOf(c.page, note)).toBe(before)
    expect(await pushCount(c.page)).toBe(0)
    // a second blocked gesture: no second hint
    await dragItem(c.page, note, { x: 60, y: 30 })
    await c.page.waitForTimeout(500)
    await expect(c.page.getByTestId('blocked-edit-hint')).toHaveCount(0)
    expect(await xOf(c.page, note)).toBe(before)
  })

  await test.step('the role pill is a button to the same form; the request is sent', async () => {
    await c.page.getByTestId('readonly-pill').click()
    await expect(shareDialog(c.page).getByTestId('share-ask-section')).toBeVisible()
    await shareDialog(c.page).getByTestId('access-request-button').click()
    await expect(shareDialog(c.page).getByTestId('access-request-status')).toContainText(
      'Edit access requested just now',
    )
    await closeShare(c.page)
    const pending = await accessRequests(await users.api('alice'), board)
    expect(pending.map((r) => [r.user.id, r.roleRequested, r.status])).toEqual([[c.id, 'editor', 'pending']])
  })

  await test.step('alice approves from the board’s Share dialog', async () => {
    const badge = a.page.getByTestId('share-badge')
    await expect(badge).toHaveAttribute('data-requests', '1', { timeout: 10_000 })
    await badge.click()
    await expect(shareDialog(a.page)).toBeVisible()
    const row = requestRow(a.page, c.id)
    await expect(row).toContainText('Asks to edit')
    await row.getByTestId('access-request-approve').click()
    await expect(row).toHaveCount(0)
    await expect(memberRow(a.page, c.id)).toHaveAttribute('data-role', 'editor')
    await closeShare(a.page)
  })

  await test.step('carol is told, the pill goes, the canvas is writable, her drag lands for alice', async () => {
    // REVIEW-6 (wave E3): the api names the approver to the person approved
    await expect(c.page.getByTestId('role-change-toast')).toHaveText(
      `You can edit this board now (changed by ${a.name})`,
      { timeout: 20_000 },
    )
    await expect(c.page.getByTestId('readonly-pill')).toHaveCount(0)
    await expect.poll(() => readOnly(c.page), { timeout: 20_000 }).toBe(false)
    await dragItem(c.page, note, { x: 90, y: 60 })
    await expect.poll(() => xOf(c.page, note)).toBeGreaterThan(before + 40)
    await expectSaved(c.page)
    const moved = await xOf(c.page, note)
    await expect.poll(() => xOf(a.page, note)).toBe(moved)
  })
})

test('someone without access asks from the no-access screen; alice approves in Share; the waiting page opens the Excalidraw canvas by itself and the newcomer edits at once', async ({
  canvasSession,
  users,
  board,
  browser,
}, testInfo) => {
  const aliceApi = await users.api('alice')
  const a = await canvasSession('alice')
  const brief = await createNote(a.page, { x: 100, y: 100, text: 'Brief' })
  await expectSaved(a.page)
  const dave = await signedInContext(browser, 'dave')
  try {
    const d = dave.page
    await test.step('dave (a Dev Studio member without a grant) sees the request form and asks for edit', async () => {
      await d.goto(`/b/${board}`)
      await expect(d.getByTestId('no-access')).toContainText("You don't have access to this board")
      await expect(d.getByTestId('access-request-form')).toBeVisible()
      await d.getByTestId('access-request-role').selectOption('editor')
      await d.getByTestId('access-request-message').fill('I need to add the storyboard notes')
      await d.getByTestId('access-request-button').click()
      await expect(d.getByTestId('access-request-status')).toContainText('Edit access requested just now')
      await expect
        .poll(async () => (await accessRequests(aliceApi, board)).map((r) => [r.user.id, r.roleRequested]))
        .toEqual([[dave.me.user.id, 'editor']])
    })

    await test.step('alice approves from the Share badge of the open board', async () => {
      const badge = a.page.getByTestId('share-badge')
      await expect(badge).toHaveAttribute('data-requests', '1', { timeout: 10_000 })
      await badge.click()
      const row = requestRow(a.page, dave.me.user.id)
      await expect(row).toContainText('I need to add the storyboard notes')
      const started = Date.now()
      await row.getByTestId('access-request-approve').click()
      await expect(row).toHaveCount(0)
      await expect(memberRow(a.page, dave.me.user.id)).toHaveAttribute('data-role', 'editor')
      await closeShare(a.page)

      await waitForCanvas(d, 15_000)
      testInfo.annotations.push({
        type: 'approval latency',
        description: `${Date.now() - started} ms until dave's page showed the canvas (target < 10000 ms)`,
      })
    })

    await test.step('dave is on the board as himself, an editor: he sees the brief and alice sees his note', async () => {
      const me = await canvasCall(d, 'me')
      expect(me?.uid).toBe(dave.me.user.id)
      await waitForItem(d, brief)
      await expect.poll(() => readOnly(d)).toBe(false)
      const mine = await createNote(d, { x: 400, y: 100, text: 'From dave' })
      await expectSaved(d)
      await waitForItem(a.page, mine)
    })
  } finally {
    await dave.context.close()
  }
})
