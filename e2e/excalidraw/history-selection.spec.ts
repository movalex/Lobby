// D3-2 (wave B follow-up): the selection an undo or a redo restores keeps a GROUP as a group. Excalidraw
// selects a group whole (every member in `selectedElementIds`, the group in `selectedGroupIds`); the history
// restored the members and the port's `select` cleared `selectedGroupIds`, so a group came back as separate
// members (no group box, a click-and-drag of one member moved the group's members apart in the eyes of the
// handles). The history side (canvas/history/controller.ts `selectedGroups`, handed to the `select` option)
// is covered by canvas/history/selection-settle.test.ts and selected-groups.test.ts; board/session.ts's
// `select` callback hands the groups to the engine (`selectedGroupIds`, D3-2a, wave E). Since then this is a
// plain test: before, it skipped itself by reading session.ts's source until that callback took the groups.
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

const sorted = (ids: string[]) => [...ids].sort()

test('undo and redo select a group as a group, not as its members', async ({ canvasSession }) => {
  const { page } = await canvasSession('alice')
  const A = 'sel-g-a'
  const B = 'sel-g-b'
  const C = 'sel-g-c'
  await createItem(page, 'rectangle', { id: A, x: 100, y: 120, width: 140, height: 100 })
  await createItem(page, 'rectangle', { id: B, x: 320, y: 120, width: 140, height: 100 })
  await createItem(page, 'rectangle', { id: C, x: 100, y: 420, width: 140, height: 100 })
  await expectSaved(page)
  const x = async (id: string) => Math.round((await item(page, id))?.x ?? 0)

  let gid = ''
  await test.step('group A and B (Ctrl/Cmd+G): the group is selected as a group', async () => {
    await select(page, [A, B])
    await focusCanvas(page)
    await page.keyboard.press('ControlOrMeta+g')
    await expect.poll(async () => ((await item(page, A))?.groupIds ?? []).length).toBe(1)
    gid = ((await item(page, A))?.groupIds ?? [])[0] as string
    await expect.poll(() => groupsSelected(page)).toEqual([gid])
    await expectSaved(page)
  })

  await test.step('drag the group (one step), then click away', async () => {
    await dragItem(page, A, { x: 90, y: 60 })
    await expect.poll(() => x(A)).toBeGreaterThan(160)
    await expect.poll(() => x(B)).toBeGreaterThan(380)
    await expect.poll(() => groupsSelected(page)).toEqual([gid])
    await expectSaved(page)
    await selectNone(page)
    await expect.poll(() => selection(page)).toEqual([])
    await expect.poll(() => groupsSelected(page)).toEqual([])
  })

  await test.step('the undo puts the group back where it was, selected as a group', async () => {
    await pressUndo(page)
    await expect.poll(() => x(A)).toBe(100)
    await expect.poll(() => x(B)).toBe(320)
    await expect.poll(async () => sorted(await selection(page))).toEqual(sorted([A, B]))
    await expect.poll(() => groupsSelected(page)).toEqual([gid])
  })

  await test.step('the redo moves it again and selects it as a group', async () => {
    await selectNone(page)
    await expect.poll(() => groupsSelected(page)).toEqual([])
    await pressRedo(page)
    await expect.poll(() => x(A)).toBeGreaterThan(160)
    await expect.poll(async () => sorted(await selection(page))).toEqual(sorted([A, B]))
    await expect.poll(() => groupsSelected(page)).toEqual([gid])
  })

  await test.step('the undo of Ctrl+G ungroups, the members come back selected; the redo groups them again and selects the group', async () => {
    await pressUndo(page)
    await pressUndo(page)
    await expect.poll(async () => ((await item(page, A))?.groupIds ?? []).length).toBe(0)
    await expect.poll(async () => sorted(await selection(page))).toEqual(sorted([A, B]))
    await selectNone(page)
    await pressRedo(page)
    await expect.poll(async () => ((await item(page, A))?.groupIds ?? []).length).toBe(1)
    await expect.poll(async () => sorted(await selection(page))).toEqual(sorted([A, B]))
    await expect.poll(() => groupsSelected(page)).toEqual([gid])
  })
})
