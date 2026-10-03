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
