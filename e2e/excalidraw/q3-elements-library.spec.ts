// Wave Q, WS3: the Elements panel's Library tab and "Save to library", on the real board page and sync server, with
// WS2's library api stood in for by a route double in the page (./q3-kit.ts libraryDouble: the contract's shapes,
// in memory) until WS2's routes land. What must hold: a selection saved from the selection bar is sent as portable
// elements with the board as its source; it shows in the Library tab, and a click places it (POST /place first, then
// one push) in one undo step; a star makes it a favourite; the context menu saves too; edit details sends the
// revision it read; delete has Undo; folders are made and used; an api refusal is said in the dialog; an outsider
// (a member without a work address) saves to their own library only and is told why.
//
//   E2E_PORT_BASE=7760 pnpm exec playwright test excalidraw/q3-elements-library --project=chromium --workers=1   (from e2e/)
import type { Page } from '@playwright/test'
import { Api, signInContext } from '../tests/support/api.ts'
import {
  type CanvasElement,
  clickItem,
  expect,
  expectSaved,
  items,
  pushedOps,
  select,
  setViewport,
  test,
  waitForCanvas,
} from '../tests/support/canvas.ts'
import { freshHandle } from '../tests/support/dashboard-share.ts'
import { undoKey } from './navigation-kit.ts'
import { elementsPanelOn, libraryDouble, openElements, reloadWithElements, tab, tile } from './q3-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const kindOf = (e: CanvasElement) => (e.customData as { lobby?: { kind?: string } } | undefined)?.lobby?.kind
const pieceEls = async (page: Page, kind: string) => (await items(page)).filter((e) => kindOf(e) === kind)

/** A Process piece on the board through the panel's Shapes tab; its element ids. */
async function addProcess(page: Page): Promise<string[]> {
  await openElements(page)
  await tab(page, 'shapes').click()
  await page.getByTestId('element-search').fill('process')
  await tile(page, 'piece', 'process').click()
  await expect.poll(async () => (await pieceEls(page, 'piece-process')).length).toBe(2)
  await expectSaved(page)
  return (await pieceEls(page, 'piece-process')).map((e) => e.id)
}

test('Q3: a selection saved from the selection bar goes to the library as portable elements; placed from the Library tab in one undo step; a star makes it a favourite', async ({
  canvasSession,
  board,
}, testInfo) => {
  const a = await canvasSession('alice')
  const lib = await libraryDouble(a.page)
  await reloadWithElements(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  const ids = await addProcess(a.page)
  const boxEl = (await pieceEls(a.page, 'piece-process')).find((e) => e.type === 'rectangle') as CanvasElement

  await test.step('the selection bar’s Save to library opens the dialog with the selection’s words as its name', async () => {
    await select(a.page, [boxEl.id])
    await a.page.getByTestId('selection-save-to-library').click()
    const dialog = a.page.getByTestId('element-save-dialog')
    await expect(dialog).toBeVisible()
    await expect(a.page.getByTestId('element-save-name')).toHaveValue('Process')
    await expect(a.page.getByTestId('element-save-scope-workspace')).toBeChecked()
    await a.page.screenshot({ path: testInfo.outputPath('q3-save-dialog.png') })
    await a.page.getByTestId('element-save-name').fill('Flow step')
    await a.page.getByTestId('element-save-tags').fill('Flow, Step')
    await a.page.getByTestId('element-save-submit').click()
    await expect(a.page.getByTestId('element-saved')).toContainText(
      'Saved “Flow step” to the workspace library.',
    )
    expect(lib.saves).toHaveLength(1)
    const sent = lib.saves[0] as { elements: Record<string, unknown>[] }
    expect(sent).toMatchObject({
      scope: 'workspace',
      name: 'Flow step',
      tags: ['flow', 'step'],
      sourceBoardId: board,
    })
    // the box and its label, item-local ids, the box at the origin, nothing server-bound
    expect(sent.elements).toHaveLength(2)
    for (const e of sent.elements) {
      expect(ids).not.toContain(e.id)
      expect((e.customData as Record<string, unknown> | undefined)?.lobbyServer).toBeUndefined()
      expect(e.locked).toBe(false)
    }
    const rect = sent.elements.find((e) => e.type === 'rectangle') as { x: number; y: number }
    expect([rect.x, rect.y]).toEqual([0, 0])
  })

  const before = (await items(a.page)).length
  await test.step('the Library tab shows it; a click asks /place first, then pushes it in one step', async () => {
    await openElements(a.page)
    await a.page.getByTestId('element-search').fill('')
    await tab(a.page, 'library').click()
    const [id] = [...lib.items.keys()]
    if (!id) throw new Error('nothing saved')
    await expect(tile(a.page, 'item', id)).toBeVisible()
    await expect(a.page.locator(`[data-item-preview="${id}"] rect`).first()).toBeVisible()
    await a.page.screenshot({ path: testInfo.outputPath('q3-library-tab.png') })
    const pushedBefore = (await pushedOps(a.page)).length
    await tile(a.page, 'item', id).click()
    await expect.poll(async () => (await pieceEls(a.page, 'piece-process')).length).toBe(4)
    expect(lib.requests.filter((r) => r.endsWith('/place'))).toHaveLength(1)
    expect((await pushedOps(a.page)).length).toBeGreaterThan(pushedBefore)
    await expectSaved(a.page)
    await undoKey(a.page)
    await expect.poll(async () => (await items(a.page)).length).toBe(before)
  })

  await test.step('the star makes it a favourite (PUT marks), shown in the Favourites row', async () => {
    const [id] = [...lib.items.keys()]
    await openElements(a.page)
    await tile(a.page, 'item', id as string).hover()
    await tile(a.page, 'item', id as string)
      .getByTestId('element-star')
      .click()
    await expect.poll(() => lib.marks.get(`item:${id}`)?.favourite).toBe(true)
    await expect(a.page.getByTestId('element-section-favourites').getByTestId('element-tile')).toHaveCount(1)
  })
})

test('Q3: the context menu saves to my library; edit details sends the revision; delete has Undo; folders', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const lib = await libraryDouble(a.page)
  await reloadWithElements(a.page)
  await setViewport(a.page, { x: 0, y: 0, zoom: 1 })
  await addProcess(a.page)
  const boxEl = (await pieceEls(a.page, 'piece-process')).find((e) => e.type === 'rectangle') as CanvasElement

  await test.step('right-click → Save to library… → Mine', async () => {
    await clickItem(a.page, boxEl.id, { button: 'right' })
    await a.page.getByTestId('context-menu.elements.save').click()
    await expect(a.page.getByTestId('element-save-dialog')).toBeVisible()
    await a.page.getByTestId('element-save-scope-personal').check()
    await a.page.getByTestId('element-save-submit').click()
    await expect(a.page.getByTestId('element-saved')).toContainText('to your library')
    expect(lib.saves[0]).toMatchObject({ scope: 'personal', name: 'Process' })
  })

  const [id] = [...lib.items.keys()]
  if (!id) throw new Error('nothing saved')
  await openElements(a.page)
  await a.page.getByTestId('element-search').fill('')
  await tab(a.page, 'library').click()
  await a.page.locator('[data-testid="element-scope"][data-scope="personal"]').click()
  await expect(tile(a.page, 'item', id)).toBeVisible()

  await test.step('a new folder, then Edit details: rename, tags and the folder, with the revision read', async () => {
    await a.page.getByTestId('element-folder-actions').click()
    await a.page.locator('[data-testid="element-menu"] [data-action="new"]').click()
    await a.page.getByTestId('element-folder-name').fill('Flows')
    await a.page.getByTestId('element-folder-submit').click()
    await expect(a.page.getByTestId('element-folder-dialog')).toHaveCount(0)
    expect([...lib.folders.values()].map((f) => f.name)).toEqual(['Flows'])
    await a.page.getByTestId('element-folder').selectOption('all')
    await tile(a.page, 'item', id).click({ button: 'right' })
    await a.page.locator('[data-testid="element-menu"] [data-action="edit"]').click()
    await a.page.getByTestId('element-item-name').fill('Process step')
    await a.page.getByTestId('element-item-tags').fill('flow')
    await a.page.locator('[data-testid="element-item-dialog"] select').selectOption({ label: 'Flows' })
    await a.page.getByTestId('element-item-submit').click()
    await expect(a.page.getByTestId('element-item-dialog')).toHaveCount(0)
    const item = lib.items.get(id)
    expect(item?.summary).toMatchObject({ name: 'Process step', tags: ['flow'], revision: 2 })
    expect(item?.summary.folderId).toBe([...lib.folders.keys()][0])
    await expect(tile(a.page, 'item', id)).toHaveAttribute('title', 'Process step')
  })

  await test.step('Delete, then the notice’s Undo restores it', async () => {
    await tile(a.page, 'item', id).click({ button: 'right' })
    await a.page.locator('[data-testid="element-menu"] [data-action="delete"]').click()
    await expect(a.page.getByTestId('element-deleted')).toBeVisible()
    await expect(tile(a.page, 'item', id)).toHaveCount(0)
    expect(lib.items.get(id)?.summary.deletedAt).toBeTruthy()
    await a.page.getByTestId('element-deleted-undo').click()
    await expect.poll(() => lib.items.get(id)?.summary.deletedAt ?? null).toBeNull()
    await openElements(a.page)
    await expect(tile(a.page, 'item', id)).toBeVisible()
  })
})

test('Q3: an api refusal is said in the save dialog, and nothing is saved', async ({ canvasSession }) => {
  const a = await canvasSession('alice')
  const lib = await libraryDouble(a.page)
  await reloadWithElements(a.page)
  await addProcess(a.page)
  const boxEl = (await pieceEls(a.page, 'piece-process')).find((e) => e.type === 'rectangle') as CanvasElement
  lib.refuseNextSave = { status: 403, code: 'CREATOR_REQUIRED' }
  await select(a.page, [boxEl.id])
  await a.page.getByTestId('selection-save-to-library').click()
  await a.page.getByTestId('element-save-submit').click()
  await expect(a.page.getByTestId('element-save-error')).toContainText('needs a work address')
  expect(lib.items.size).toBe(0)
  await expect(a.page.getByTestId('element-save-dialog')).toBeVisible()
})

test('Q3: an outsider (a member without a work address) saves to their own library only, and is told why', async ({
  browser,
  board,
  playwright,
  users,
}) => {
  const handle = freshHandle('exo')
  const email = 'exo@client.example.test'
  // a Dev Studio member first (a dev sign-in without an address is a creator), then signed in with an outside
  // address: the same account, a member still, no longer a creator (as domain-access.spec.ts's former creator)
  const first = await Api.signIn(playwright, handle, 'Exo Client')
  await (await users.api('alice')).putMember(board, first.me.user.id, 'editor')
  await first.api.dispose()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  try {
    const me = await signInContext(context, handle, 'Exo Client', { email })
    expect(me.access).toMatchObject({ creator: false, reason: 'outside' })
    expect(me.workspaces).toContainEqual(expect.objectContaining({ id: users.devStudioId, role: 'member' }))
    await elementsPanelOn(context)
    const page = await context.newPage()
    const lib = await libraryDouble(page)
    await page.goto(`/b/${board}`)
    await waitForCanvas(page)
    await openElements(page)
    await expect(tab(page, 'library')).toBeVisible()
    const ids = await addProcess(page)
    await select(page, ids.slice(0, 1))
    await page.getByTestId('selection-save-to-library').click()
    await expect(page.getByTestId('element-save-scope-workspace')).toBeDisabled()
    await expect(page.getByTestId('element-save-scope-personal')).toBeChecked()
    await expect(page.getByTestId('element-save-workspace-reason')).toContainText('needs a work address')
    await page.getByTestId('element-save-submit').click()
    await expect(page.getByTestId('element-saved')).toContainText('to your library')
    expect(lib.saves[0]).toMatchObject({ scope: 'personal' })
  } finally {
    await context.close()
  }
})
