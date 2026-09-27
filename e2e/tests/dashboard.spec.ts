// Milestone 1: the workspace dashboard, driven through the real UI by a user who signs in through the
// dev sign-in form. A fresh user per run owns an empty personal workspace, so every count below is
// exact. The server's view is checked through the API after each change (the UI could be lying).
import type { Page } from '@playwright/test'
import type { ApiBoard, Me } from './support/api.ts'
import { signInThroughUi, waitForBoard } from './support/board.ts'
import { expect, test } from './support/fixtures.ts'
import { capture } from './support/screenshots.ts'

const card = (page: Page, boardId: string) =>
  page.locator(`[data-testid="board-card"][data-board-id="${boardId}"]`)
const cards = (page: Page) => page.getByTestId('board-card')
const titles = (page: Page) => page.getByTestId('board-card-title').allTextContents()

async function chooseFromMenu(page: Page, boardId: string, action: string) {
  await card(page, boardId).getByTestId('board-card-menu').click()
  await card(page, boardId).locator(`[role="menuitem"][data-action="${action}"]`).click()
}

const menuActions = async (page: Page, boardId: string) => {
  await card(page, boardId).getByTestId('board-card-menu').click()
  const actions = await card(page, boardId)
    .locator('[role="menuitem"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-action')))
  await page.keyboard.press('Escape')
  return actions
}

async function serverBoard(page: Page, workspaceId: string, boardId: string) {
  for (const status of ['active', 'archived', 'trashed'] as const) {
    const res = await page.request.get(`/api/workspaces/${workspaceId}/boards?status=${status}`)
    expect(res.status()).toBe(200)
    const found = ((await res.json()) as { boards: ApiBoard[] }).boards.find((b) => b.id === boardId)
    if (found) return { title: found.title, status: found.status }
  }
  return null
}

test('dashboard: create, search, rename, archive, trash and restore boards', async ({
  browser,
  stackReady: _,
}, testInfo) => {
  const user = { handle: `dana-${Date.now().toString(36).slice(-6)}`, name: 'Dana Rivera' }
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } })
  try {
    const page = await context.newPage()

    // Signed out, the app sends everyone to the sign-in page first.
    await page.goto('/')
    await expect(page).toHaveURL(/\/signin$/)
    await signInThroughUi(page, user)
    await expect(page.getByTestId('dashboard')).toBeVisible()
    await expect(page.getByTestId('dev-identity-badge')).toHaveAttribute('title', /Dana Rivera/)

    const me = (await (await page.request.get('/api/me')).json()) as Me
    const personal = me.workspaces.find((w) => w.name === "Dana Rivera's workspace")
    expect(personal?.role).toBe('owner')
    const wid = personal?.id ?? ''
    await page.goto(`/w/${wid}`)
    await expect(page.getByTestId('dashboard')).toHaveAttribute('data-workspace-id', wid)
    await expect(page.getByTestId('dashboard-empty')).toBeVisible()

    const ids: Record<string, string> = {}
    await test.step('create three boards from the dashboard; each opens as a live board', async () => {
      for (const title of ['Q4 roadmap', 'Brand moodboard', 'Launch retro']) {
        await page.getByTestId('create-board').click()
        await expect(page.getByTestId('create-board-dialog')).toBeVisible()
        await page.getByTestId('create-board-title').fill(title)
        await page.getByTestId('create-board-submit').click()
        await expect(page).toHaveURL(/\/b\/b-[0-9a-z]{10}$/)
        ids[title] = new URL(page.url()).pathname.split('/')[2] ?? ''
        await waitForBoard(page)
        await expect(page.getByTestId('board-title')).toHaveText(title)
        // The owner sees no read-only pill and can rename from the top bar.
        await expect(page.getByTestId('readonly-pill')).toHaveCount(0)
        await page.getByRole('link', { name: `Back to ${personal?.name}` }).click()
        await expect(page.getByTestId('dashboard')).toBeVisible()
      }
      await page.getByTestId('nav-all').click()
      await expect(cards(page)).toHaveCount(3)
      for (const id of Object.values(ids)) {
        await expect(card(page, id)).toHaveAttribute('data-status', 'active')
        await expect(card(page, id)).toHaveAttribute('data-role', 'owner')
      }
      // Private by default, created by the signed-in user.
      const detail = await page.request.get(`/api/boards/${ids['Q4 roadmap']}`)
      expect(await detail.json()).toMatchObject({
        board: { visibility: 'private', status: 'active', createdBy: me.user.id, workspaceId: wid },
        role: 'owner',
      })
    })

    await test.step('search filters by title (case-insensitive, every word)', async () => {
      const search = page.getByTestId('dashboard-search')
      await search.fill('mood')
      await expect(cards(page)).toHaveCount(1)
      expect(await titles(page)).toEqual(['Brand moodboard'])
      await search.fill('ROADMAP q4')
      expect(await titles(page)).toEqual(['Q4 roadmap'])
      await search.fill('retro roadmap')
      await expect(cards(page)).toHaveCount(0)
      await expect(page.getByTestId('dashboard-empty')).toBeVisible()
      await search.fill('')
      await expect(cards(page)).toHaveCount(3)
    })

    await test.step('rename from the card menu; the new title is the server’s', async () => {
      const id = ids['Launch retro'] ?? ''
      expect(await menuActions(page, id)).toEqual(['open', 'copy-link', 'rename', 'archive', 'trash'])
      await chooseFromMenu(page, id, 'rename')
      const input = card(page, id).getByTestId('board-card-rename')
      await input.fill('Launch retro — September')
      await input.press('Enter')
      await expect(card(page, id).getByTestId('board-card-title')).toHaveText('Launch retro — September')
      await expect
        .poll(() => serverBoard(page, wid, id))
        .toEqual({ title: 'Launch retro — September', status: 'active' })
      await page.reload()
      await expect(card(page, id).getByTestId('board-card-title')).toHaveText('Launch retro — September')
    })

    await test.step('archive: the board leaves All boards and is listed (read-only) under Archived', async () => {
      const id = ids['Q4 roadmap'] ?? ''
      await chooseFromMenu(page, id, 'archive')
      await expect(card(page, id)).toHaveCount(0)
      await expect(cards(page)).toHaveCount(2)
      await expect.poll(() => serverBoard(page, wid, id)).toEqual({ title: 'Q4 roadmap', status: 'archived' })
      await page.getByTestId('nav-archived').click()
      await expect(card(page, id)).toHaveAttribute('data-status', 'archived')
      expect(await menuActions(page, id)).toEqual(['open', 'copy-link', 'restore', 'trash'])
      // Archived boards open read-only, even for their owner.
      await card(page, id).getByRole('link').click()
      await waitForBoard(page)
      await expect(page.getByTestId('readonly-pill')).toHaveText('Archived · View only')
      expect(await page.evaluate(() => window.editor?.getIsReadonly())).toBe(true)
      await page.goBack()
      await expect(card(page, id)).toBeVisible()
    })

    await test.step('trash: the board is listed under Trash and cannot be opened', async () => {
      const id = ids['Brand moodboard'] ?? ''
      await page.getByTestId('nav-all').click()
      await chooseFromMenu(page, id, 'trash')
      await expect(card(page, id)).toHaveCount(0)
      await expect
        .poll(() => serverBoard(page, wid, id))
        .toEqual({ title: 'Brand moodboard', status: 'trashed' })
      await page.getByTestId('nav-trash').click()
      await expect(card(page, id)).toHaveAttribute('data-status', 'trashed')
      await expect(card(page, id).getByRole('link')).toHaveCount(0)
      expect((await page.request.get(`/api/boards/${id}`)).status()).toBe(404)
      await page.goto(`/b/${id}`)
      await expect(page.getByTestId('no-access')).toBeVisible()
    })

    await test.step('restore from Trash and from Archived: both are back in All boards', async () => {
      const trashed = ids['Brand moodboard'] ?? ''
      const archived = ids['Q4 roadmap'] ?? ''
      await page.goto(`/w/${wid}/trash`)
      await chooseFromMenu(page, trashed, 'restore')
      await expect(card(page, trashed)).toHaveCount(0)
      await expect(page.getByTestId('dashboard-empty')).toBeVisible()
      await page.getByTestId('nav-archived').click()
      await chooseFromMenu(page, archived, 'restore')
      await expect(card(page, archived)).toHaveCount(0)
      await page.getByTestId('nav-all').click()
      await expect(cards(page)).toHaveCount(3)
      for (const id of Object.values(ids)) {
        await expect(card(page, id)).toHaveAttribute('data-status', 'active')
        await expect.poll(async () => (await serverBoard(page, wid, id))?.status).toBe('active')
      }
    })

    // A fresh load: the Recent list as the server returns it (and no status toasts left over).
    await page.getByTestId('nav-recent').click()
    await page.reload()
    await expect(cards(page)).toHaveCount(3)
    await expect(page.getByTestId('dashboard-toast')).toHaveCount(0)
    await capture('dashboard.png', page, testInfo)
  } finally {
    await context.close()
  }
})
