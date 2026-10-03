// Opening a board on the Excalidraw board page (ported from the tldraw suite's shell-2, saving and
// permissions checks of the same jobs): the top bar, Saved and Live, the canvas's name and keyboard, the
// read-only roles, no access, and spike B's board page still reachable.
import { signInContext } from '../tests/support/api.ts'
import {
  clickItem,
  createNote,
  dragItem,
  expect,
  item,
  test,
  waitForCanvas,
  waitForItem,
} from '../tests/support/canvas.ts'
import { canvasReadOnly, pushCount } from './board-kit.ts'

const canvasHasKeyboard = (page: import('@playwright/test').Page) =>
  page.evaluate(() => !!document.activeElement?.closest('.excalidraw'))

test('opening a board: the top bar names it, Saved and Live, and the canvas is named after it and takes the keyboard', async ({
  canvasSession,
}) => {
  const alice = await canvasSession('alice')
  const p = alice.page
  const board = p.getByTestId('lobby-board')
  await expect(board).toHaveAttribute('data-engine', 'excalidraw')
  await expect(board).toHaveAttribute('data-phase', 'ready')
  await expect(p.getByTestId('board-title')).toHaveText('Opening a board')
  await expect(p.locator('.dr-topbar__ws')).toHaveText('Dev Studio')
  await expect(p.getByTestId('save-status')).toHaveAttribute('data-state', 'saved')
  await expect(p.getByTestId('save-status')).toHaveText('Saved')
  await expect(p.getByTestId('save-status')).toHaveAttribute(
    'title',
    'Every change you made is stored on the board server',
  )
  await expect(p.getByTestId('conn-status')).toHaveAttribute('data-state', 'online')
  await expect(p.getByTestId('conn-status')).toHaveText('Live')
  await expect(p.getByTestId('share-button')).toBeVisible()
  // A11Y2-09: the canvas region is named after the board (W5-57: apart from the application inside it,
  // '<title> board'), and it has the keyboard once the board opens
  await expect(p.locator('[data-lobby-board-canvas]')).toHaveAttribute(
    'aria-label',
    'Opening a board board area',
  )
  await expect.poll(() => canvasHasKeyboard(p)).toBe(true)
  expect(await canvasReadOnly(p)).toBe(false)
  // A11Y-09: the board's first Tab is "Skip to canvas", and it gives the canvas the keyboard
  // from the top of the page (a blur() would leave Tab's starting point on the canvas)
  await p.evaluate(() => {
    document.body.tabIndex = -1
    document.body.focus()
  })
  await p.keyboard.press('Tab')
  await expect(p.getByTestId('skip-to-canvas')).toBeFocused()
  await p.keyboard.press('Enter')
  await expect.poll(() => canvasHasKeyboard(p)).toBe(true)
})

test('read-only roles: the role pill says so, the canvas is read-only, and a drag or Delete changes nothing and pushes nothing', async ({
  canvasSession,
}) => {
  const alice = await canvasSession('alice')
  const viewer = await canvasSession('bob', { role: 'viewer' })
  const commenter = await canvasSession('carol', { role: 'commenter' })
  await expect(viewer.page.getByTestId('readonly-pill')).toHaveText('View only')
  await expect(commenter.page.getByTestId('readonly-pill')).toHaveText('Can comment')
  expect(await canvasReadOnly(viewer.page)).toBe(true)
  expect(await canvasReadOnly(commenter.page)).toBe(true)
  // the pill already says it: the indicator is out of the way
  await expect(viewer.page.getByTestId('save-status')).toHaveAttribute('data-state', 'readonly')
  await expect(viewer.page.getByTestId('save-status')).toBeHidden()

  const id = await createNote(alice.page, { x: 120, y: 120, text: 'Mine' })
  await waitForItem(viewer.page, id)
  const before = await item(alice.page, id)
  await dragItem(viewer.page, id, { x: 140, y: 60 })
  await clickItem(viewer.page, id)
  await viewer.page.keyboard.press('Delete')
  // PRI-08: the first blocked edit says why nothing happened, once, with a way to ask for more
  await expect(viewer.page.getByTestId('blocked-edit-hint')).toBeVisible()
  await expect(viewer.page.getByTestId('blocked-edit-hint')).toContainText('You can view this board.')
  await viewer.page.waitForTimeout(500)
  expect(await pushCount(viewer.page)).toBe(0)
  expect(await pushCount(commenter.page)).toBe(0)
  const after = await item(alice.page, id)
  expect({ x: after?.x, y: after?.y, isDeleted: after?.isDeleted }).toEqual({
    x: before?.x,
    y: before?.y,
    isDeleted: false,
  })
})

test('no access: someone the board is not shared with sees the no-access screen, and never a canvas', async ({
  browser,
  board,
  users,
}) => {
  const carol = await users.get('carol')
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await signInContext(context, carol.handle, carol.name)
    await page.goto(`/b/${board}`)
    await expect(page.getByTestId('no-access')).toContainText("You don't have access to this board")
    await expect(page.getByTestId('lobby-board')).toHaveCount(0)
    expect(await page.evaluate(() => !!(window as unknown as { lobbyCanvas?: unknown }).lobbyCanvas)).toBe(
      false,
    )
  } finally {
    await context.close()
  }
})

test("spike B's board page stays reachable (?page=spike) on the same build", async ({
  canvasSession,
  board,
}) => {
  const alice = await canvasSession('alice')
  const id = await createNote(alice.page, { x: 80, y: 80, text: 'Both pages' })
  const spike = await alice.context.newPage()
  await spike.goto(`/b/${board}?page=spike`)
  await expect(spike.getByTestId('spike-board')).toBeVisible()
  await waitForCanvas(spike)
  await waitForItem(spike, id)
  await expect(spike.getByTestId('save-state')).toHaveAttribute('data-state', 'saved')
})
