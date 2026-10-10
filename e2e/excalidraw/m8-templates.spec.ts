// Wave M (M8-3/M8-4, owner W8): workspace templates in the browser, against the real api and sync server.
//  - a creator who is the workspace owner saves a board as a team template from the board menu (Board ▸);
//  - another creator (a plain member, who has no access to that board) sees it under the picker's Workspace tab
//    and starts a board from it: the new board has the content and none of the template's sharing;
//  - a member who is not an admin, a member who is not a creator and a name-only guest are offered no save;
//  - against an api that answers 404 (one without templates) the Workspace tab is hidden;
//  - nothing leaves Lobby's origins (the e2e network assertion).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m8-templates.spec.ts --project=chromium --workers=1
import type { BrowserContext, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { createNote, expect, expectSaved, test, waitForCanvas } from '../tests/support/canvas.ts'
import { WEB_URL } from '../tests/support/ports.ts'
import { foreignRequests } from './ai-kit.ts'
import { guestOn, ORIGIN, tokenOf } from './guests-kit.ts'
import { navEntries } from './navigation-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const SAVE = 'ws-templates.save'
const word = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 8)}`

/** Every element's words on the open board. */
const boardWords = (page: Page) =>
  page.evaluate(() => {
    const c = (
      window as unknown as {
        __lobbyBoard?: { canvas: { items(): { id: string }[]; text: { of(id: string): string } } }
      }
    ).__lobbyBoard?.canvas
    if (!c) throw new Error('no window.__lobbyBoard')
    return c
      .items()
      .map((e) => c.text.of(e.id))
      .filter(Boolean)
  })

/** Whether the board menu offers "Save as workspace template" to this page's person. */
const saveOffered = async (page: Page) => (await navEntries(page, 'mainMenu')).some((e) => e.id === SAVE)

async function openNewBoardDialog(page: Page, workspaceId: string) {
  await page.goto(`/w/${workspaceId}`)
  await page.getByTestId('create-board').click()
  await expect(page.getByTestId('create-board-dialog')).toBeVisible()
  await expect(page.getByTestId('template-gallery')).toBeVisible()
}

test('a creator saves a board as a workspace template; another member starts a board from it, with none of its sharing', async ({
  board,
  browser,
  canvasSession,
  users,
}) => {
  test.setTimeout(180_000)
  const key = word('retro')
  const aliceApi = await users.api('alice')
  // the template board: content, a grant for carol and workspace visibility (none of it may reach the copy)
  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  await createNote(a.page, { x: 0, y: 0, text: `What went well? ${key}` })
  await expectSaved(a.page)
  const carol = await users.get('carol')
  await aliceApi.putMember(board, carol.id, 'commenter')
  await aliceApi.patchBoard(board, { visibility: 'workspace_view' })
  // ... and private again, so bob (a plain member) cannot open the board itself
  await aliceApi.patchBoard(board, { visibility: 'private' })

  // alice (the workspace owner, a creator): Board ▸ Save as workspace template…
  await expect.poll(() => saveOffered(a.page)).toBe(true)
  await a.page.getByTestId('main-menu.button').click()
  await a.page.getByTestId('main-menu-sub.dr-board-button').click()
  await a.page.getByRole('menuitem', { name: /Save as workspace template/ }).click()
  const dialog = a.page.getByTestId('ws-template-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByTestId('ws-template-submit')).toBeEnabled()
  await dialog.getByTestId('ws-template-name').fill(`Team retro ${key}`)
  await dialog.getByTestId('ws-template-category').selectOption('review')
  await dialog.getByTestId('ws-template-submit').click()
  await expect(a.page.getByTestId('ws-template-saved')).toContainText('Saved as a workspace template')
  await expect(dialog).toHaveCount(0)
  expect(foreign).toEqual([])

  // bob (a member and a creator, not an admin): no save on a board, and no access to the template board
  const bobUser = await users.get('bob')
  const bobApi = await users.api('bob')
  expect((await bobApi.fetch('GET', `/api/boards/${board}`)).status()).toBe(404)
  const bobContext = await browser.newContext()
  try {
    await signInContext(bobContext, bobUser.handle, bobUser.name)
    const page = await bobContext.newPage()
    const bobForeign = foreignRequests(page)
    await openNewBoardDialog(page, users.devStudioId)
    const chip = page.locator('[data-testid="template-category"][data-category="workspace"]')
    await expect(chip).toBeVisible()
    await chip.click()
    const card = page.getByTestId('ws-template-card').filter({ hasText: `Team retro ${key}` })
    await expect(card).toBeVisible()
    await expect(card).toContainText('Review · saved by')
    await card.getByTestId('ws-template-use').click()
    await expect(page).toHaveURL(/\/b\/[a-z0-9_-]+$/, { timeout: 30_000 })
    const copy = new URL(page.url()).pathname.split('/b/')[1] ?? ''
    expect(copy).not.toBe(board)
    await waitForCanvas(page)
    await expect.poll(() => boardWords(page), { timeout: 20_000 }).toContain(`What went well? ${key}`)
    // none of the template's sharing: private, bob's grant only (alice reaches it as the workspace owner)
    const made = await bobApi.getBoard(copy)
    expect(made.board).toMatchObject({ title: `Team retro ${key}`, visibility: 'private' })
    const grants = (await bobApi.members(copy)).filter((m) => m.source === 'grant')
    expect(grants.map((m) => [m.user.id, m.role])).toEqual([[bobUser.id, 'owner']])
    // bob is no admin: no save on his own board either
    expect(await saveOffered(page)).toBe(false)
    expect(bobForeign).toEqual([])
  } finally {
    await bobContext.close()
  }
})

test('no save for a member who is not an admin, a member who is not a creator, or a name-only guest', async ({
  board,
  browser,
  canvasSession,
  users,
}) => {
  test.setTimeout(180_000)
  const aliceApi = await users.api('alice')
  const contexts: BrowserContext[] = []
  try {
    // bob: a member and a creator, with an editor grant
    const bob = await canvasSession('bob', { role: 'editor' })
    await expect.poll(() => navEntries(bob.page, 'mainMenu').then((e) => e.length)).toBeGreaterThan(0)
    expect(await saveOffered(bob.page)).toBe(false)

    // pat: a workspace MEMBER whose address is outside the creator domains (not a creator), through an
    // email-locked workspace invitation, with an editor grant on the board
    const handle = word('pat')
    const email = `${handle}@client.example.test`
    const invited = await aliceApi.fetch('POST', `/api/workspaces/${users.devStudioId}/invitations`, {
      role: 'member',
      email,
    })
    expect(invited.status(), await invited.text()).toBe(201)
    const ctx = await browser.newContext()
    contexts.push(ctx)
    const me = await signInContext(ctx, handle, 'Pat', { email })
    expect(me.access?.creator).toBe(false)
    const accepted = await ctx.request.post(
      `${WEB_URL}/api/invitations/${tokenOf((await invited.json()).url)}/accept`,
      { headers: ORIGIN },
    )
    expect(accepted.status(), await accepted.text()).toBe(200)
    await aliceApi.putMember(board, me.user.id, 'editor')
    const page = await ctx.newPage()
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)
    await expect.poll(() => navEntries(page, 'mainMenu').then((e) => e.length)).toBeGreaterThan(0)
    expect(await saveOffered(page)).toBe(false)

    // a name-only guest through a guest link
    const link = await aliceApi.fetch('POST', `/api/boards/${board}/review-links`, {
      role: 'editor',
      allowGuests: true,
    })
    expect(link.status(), await link.text()).toBe(201)
    const gctx = await browser.newContext()
    contexts.push(gctx)
    const guest = await guestOn(gctx, tokenOf((await link.json()).url), 'Gia')
    await expect.poll(() => navEntries(guest.page, 'mainMenu').then((e) => e.length)).toBeGreaterThan(0)
    expect(await saveOffered(guest.page)).toBe(false)
    // and the api refuses all three anyway
    for (const res of [
      await (await users.api('bob')).fetch('POST', `/api/workspaces/${users.devStudioId}/templates`, {
        boardId: board,
        name: 'Nope',
      }),
      await gctx.request.post(`${WEB_URL}/api/workspaces/${users.devStudioId}/templates`, {
        headers: ORIGIN,
        data: { boardId: board, name: 'Nope' },
      }),
    ])
      expect(res.status()).toBe(403)
  } finally {
    for (const c of contexts) await c.close()
  }
})

test('against an api answering 404 (no templates there yet), the picker hides its Workspace tab', async ({
  browser,
  users,
}) => {
  const alice = await users.get('alice')
  const ctx = await browser.newContext()
  try {
    await signInContext(ctx, alice.handle, alice.name)
    const page = await ctx.newPage()
    const asked: string[] = []
    await page.route('**/api/workspaces/*/templates', (route) => {
      asked.push(route.request().url())
      return route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Not found.' } } })
    })
    await openNewBoardDialog(page, users.devStudioId)
    await expect.poll(() => asked.length).toBeGreaterThan(0)
    // the catalog's chips are all there, the Workspace one is not
    await expect(page.locator('[data-testid="template-category"][data-category="ideate"]')).toBeVisible()
    await expect(page.locator('[data-testid="template-category"][data-category="workspace"]')).toHaveCount(0)
    await expect(page.getByTestId('template-card').first()).toBeVisible()
  } finally {
    await ctx.close()
  }
})
