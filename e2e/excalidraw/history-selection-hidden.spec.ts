// F2 (wave F; the E2 follow-up to D3-2a): an undo or a redo restores a selected GROUP as a group
// (history-selection.spec.ts), but never through a hidden member. The port's `select` leaves a hidden id out
// of the selection; `selectedGroupIds` naming the group would still make Excalidraw draw the group's box and
// move the group over every member, the hidden one included. board/session.ts's `select` leaves such a group
// out (board/select-groups.ts), so the restore selects the visible members only.
import type { Page } from '@playwright/test'
import {
  createItem,
  dragItem,
  expect,
  expectSaved,
  item,
  select,
  selection,
  selectNone,
  test,
} from '../tests/support/canvas.ts'
import { focusCanvas, pressRedo, pressUndo } from '../tests/support/excalidraw.ts'

/** Excalidraw's `selectedGroupIds` as the engine holds it now. */
const groupsSelected = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const board = (
      window as unknown as {
        __lobbyBoard: { api: { getAppState(): { selectedGroupIds: Record<string, boolean> } } }
      }
    ).__lobbyBoard
    const s = board.api.getAppState().selectedGroupIds
    return Object.keys(s).filter((k) => s[k])
  })

/** A feature hiding `id` (a collapsed branch, say) until the returned function runs. */
async function hide(page: Page, id: string): Promise<() => Promise<void>> {
  await page.evaluate((hidden) => {
    const w = window as unknown as {
      __lobbyBoard: { canvas: { hide(owner: string, ids: string[]): () => void } }
      __unhideF2?: () => void
    }
    w.__unhideF2 = w.__lobbyBoard.canvas.hide('f2-spec', [hidden])
  }, id)
  await expect
    .poll(() =>
      page.evaluate((hidden) => {
        const w = window as unknown as { __lobbyBoard: { canvas: { isHidden(id: string): boolean } } }
        return w.__lobbyBoard.canvas.isHidden(hidden)
      }, id),
    )
    .toBe(true)
  return async () => {
    await page.evaluate(() => (window as unknown as { __unhideF2?: () => void }).__unhideF2?.())
  }
}

const sorted = (ids: string[]) => [...ids].sort()

test('undo and redo do not select a group through a hidden member; once it shows, the group comes back as a group', async ({
  canvasSession,
}) => {
  const { page } = await canvasSession('alice')
  const A = 'sel-h-a'
  const B = 'sel-h-b'
  await createItem(page, 'rectangle', { id: A, x: 100, y: 120, width: 140, height: 100 })
  await createItem(page, 'rectangle', { id: B, x: 320, y: 120, width: 140, height: 100 })
  await expectSaved(page)
  const x = async (id: string) => Math.round((await item(page, id))?.x ?? 0)

  let gid = ''
  await test.step('group A and B (Ctrl/Cmd+G), drag the group (one step), click away', async () => {
    await select(page, [A, B])
    await focusCanvas(page)
    await page.keyboard.press('ControlOrMeta+g')
    await expect.poll(async () => ((await item(page, A))?.groupIds ?? []).length).toBe(1)
    gid = ((await item(page, A))?.groupIds ?? [])[0] as string
    await expect.poll(() => groupsSelected(page)).toEqual([gid])
    await dragItem(page, A, { x: 90, y: 60 })
    await expect.poll(() => x(A)).toBeGreaterThan(160)
    await expect.poll(() => x(B)).toBeGreaterThan(380)
    await expectSaved(page)
    await selectNone(page)
    await expect.poll(() => selection(page)).toEqual([])
    await expect.poll(() => groupsSelected(page)).toEqual([])
  })

  let show = async () => {}
  await test.step('B is hidden; the undo moves the group back and selects A alone, not the group', async () => {
    show = await hide(page, B)
    await pressUndo(page)
    await expect.poll(() => x(A)).toBe(100)
    await expect.poll(() => x(B)).toBe(320)
    await expect.poll(() => selection(page)).toEqual([A])
    // the group would select B through its box and a move of the group
    await expect.poll(() => groupsSelected(page)).toEqual([])
  })

  await test.step('B shows again: the redo moves the group and selects it as a group', async () => {
    await show()
    await selectNone(page)
    await expect.poll(() => selection(page)).toEqual([])
    await pressRedo(page)
    await expect.poll(() => x(A)).toBeGreaterThan(160)
    await expect.poll(async () => sorted(await selection(page))).toEqual(sorted([A, B]))
    await expect.poll(() => groupsSelected(page)).toEqual([gid])
  })
})
