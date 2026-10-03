// authz-006: the Share dialog's "Workspace members" (owners and admins of the board's workspace): a
// member's role changes there, and removing someone takes them out of the workspace with every grant they
// held on its boards, so their open board closes on the no-access screen at once (the api tells sync,
// which does not wait for its periodic re-check).
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw -- workspace-members
import type { Page } from '@playwright/test'
import { expect, test } from '../tests/support/canvas.ts'

const row = (page: Page, userId: string) =>
  page.getByTestId('workspace-member-row').and(page.locator(`[data-user-id="${userId}"]`))

test('authz-006: an owner changes a member’s workspace role and removes them; their open board loses access at once', async ({
  canvasSession,
  users,
}) => {
  const a = await canvasSession('alice') // Dev Studio owner
  const b = await canvasSession('bob', { role: 'editor' }) // a Dev Studio member with a grant on the board
  const bob = await users.get('bob')

  await a.page.getByTestId('share-button').click()
  const dialog = a.page.getByTestId('share-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('workspace-members-toggle').click()
  const bobRow = row(a.page, bob.id)
  await expect(bobRow).toHaveAttribute('data-role', 'member')
  // alice's own row has no controls, and alice (the only owner) keeps her role
  const aliceRow = row(a.page, (await users.get('alice')).id)
  await expect(aliceRow).toContainText('(you)')
  await expect(aliceRow.getByTestId('workspace-member-remove')).toHaveCount(0)

  await test.step('a role change: Admin, then back to Member', async () => {
    await bobRow.getByTestId('workspace-member-role').selectOption('admin')
    await expect(bobRow).toHaveAttribute('data-role', 'admin')
    await bobRow.getByTestId('workspace-member-role').selectOption('member')
    await expect(bobRow).toHaveAttribute('data-role', 'member')
    await expect(dialog.getByTestId('workspace-members-error')).toHaveCount(0)
  })

  await test.step('removing bob: asked first, then he is gone from the workspace and from the board', async () => {
    await bobRow.getByTestId('workspace-member-remove').click()
    await expect(bobRow.getByTestId('workspace-member-remove-box')).toContainText(
      'Remove Bob Chen from Dev Studio?',
    )
    await bobRow.getByTestId('workspace-member-remove-confirm').click()
    await expect(bobRow).toHaveCount(0)
    await expect(
      dialog.getByTestId('member-row').and(a.page.locator(`[data-user-id="${bob.id}"]`)),
    ).toHaveCount(0)
  })

  // well inside the sync server's 10 s periodic re-check: the api's push closed his session
  await expect(b.page.getByTestId('no-access')).toBeVisible({ timeout: 8_000 })
  await expect(b.page.getByTestId('lobby-board')).toHaveCount(0)
  const reopened = await b.page.request.get(`/api/workspaces/${users.devStudioId}/members`)
  expect(reopened.status()).toBe(404)
})

// (carol, not bob: authz-006 above removes bob from the workspace)
// REVIEW-6 (wave D6): the role toast names who changed my access only when the api said so, and only for the
// change the name was about. The api tells carol's own stream the owner's name after every PUT of her grant, a
// PUT that changes nothing included, and says nothing for a change of her workspace role; the page held that
// name for 60 s, so a later change nobody named got the owner's name on it. Now a name is dropped as soon as the
// page's re-read of its role agrees with what it shows.
test('REVIEW-6: a grant set to what it was changes nothing and names nobody later; a real lowering still names the owner', async ({
  canvasSession,
  users,
  board,
}) => {
  const b = await canvasSession('carol', { role: 'editor' })
  const carol = await users.get('carol')
  const alice = await users.api('alice')
  const aliceName = (await users.get('alice')).name
  const toast = b.page.getByTestId('role-change-toast')
  const setWorkspaceRole = async (role: 'admin' | 'member') => {
    const res = await alice.fetch('PATCH', `/api/workspaces/${users.devStudioId}/members/${carol.id}`, {
      role,
    })
    expect(res.status(), await res.text()).toBe(200)
  }

  await test.step('alice sets carol’s grant to what it already is: the api still tells carol’s stream it was alice, and carol’s page reads the role again and finds nothing changed', async () => {
    const reread = b.page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/boards/${board}/ticket`,
    )
    await alice.putMember(board, carol.id, 'editor')
    await reread
    // the page settles the name when that read comes back
    await b.page.waitForTimeout(500)
    await expect(toast).toHaveCount(0)
  })

  await test.step('her workspace role changes (no event, no name): the toast says what happened and names nobody', async () => {
    await setWorkspaceRole('admin')
    await expect(toast).toBeVisible({ timeout: 20_000 })
    await expect(toast).toContainText('You are now an owner of this board')
    await expect(toast).not.toContainText('changed by')
  })

  await test.step('back to a member, then alice lowers carol’s grant: that one alice did, and the toast says so', async () => {
    await setWorkspaceRole('member')
    await expect(toast).toContainText('Your access changed to Can edit', { timeout: 20_000 })
    await expect(toast).not.toContainText('changed by')
    await alice.putMember(board, carol.id, 'commenter')
    await expect(toast).toContainText('Your access changed to Can comment', { timeout: 20_000 })
    await expect(toast).toContainText(`changed by ${aliceName}`)
  })
})
