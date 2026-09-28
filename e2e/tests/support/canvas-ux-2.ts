// Helpers for the second canvas-ux wave (canvas-ux-2.spec.ts): arrange as grid (MAK-18), select by type
// (MAK-17), the board menu's "Hide note authors" (FAC-07 partial) and the owner-set start view (PRE-08).
// Editor methods used here beyond support/canvas-ux.ts exist in tldraw 5.4.2's Editor.ts.
import { expect, type Page } from '@playwright/test'
import { type CanvasEditor, editEd, readEd } from './canvas-ux.ts'
import type { BoxLike, VecLike } from './editor.ts'

/** CanvasEditor plus the document record (where the board settings live). */
export interface BoardEditor extends CanvasEditor {
  getDocumentSettings(): { meta: Record<string, unknown> }
  updateDocumentSettings(settings: { meta: Record<string, unknown> }): BoardEditor
  undo(): BoardEditor
  redo(): BoardEditor
  setCurrentPage(id: string): BoardEditor
}

export function readBd<T, A = undefined>(page: Page, fn: (editor: BoardEditor, arg: A) => T, arg?: A) {
  return readEd<T, A>(page, fn as unknown as (e: CanvasEditor, a: A) => T, arg)
}
export function editBd<A>(page: Page, fn: (editor: BoardEditor, arg: A) => unknown, arg?: A) {
  return editEd<A>(page, fn as unknown as (e: CanvasEditor, a: A) => unknown, arg)
}

/** The document record's meta, as this tab holds it. */
export const docMeta = (page: Page) =>
  readBd(
    page,
    (ed) => JSON.parse(JSON.stringify(ed.getDocumentSettings().meta ?? {})) as Record<string, unknown>,
  )

/** Page bounds of each listed shape (by id). */
export const boxes = (page: Page, ids: readonly string[]) =>
  readBd(
    page,
    (ed, list) => {
      const out: Record<string, BoxLike> = {}
      for (const id of list) {
        const b = ed.getShapePageBounds(id)
        if (b) out[id] = { x: b.x, y: b.y, w: b.w, h: b.h }
      }
      return out
    },
    [...ids],
  )

/** x/y/parentId of each listed shape (the synced record values). */
export const placements = (page: Page, ids: readonly string[]) =>
  readBd(
    page,
    (ed, list) => {
      const out: Record<string, { x: number; y: number; parentId: string }> = {}
      for (const id of list) {
        const s = ed.getShape(id)
        if (s) out[id] = { x: s.x, y: s.y, parentId: s.parentId }
      }
      return out
    },
    [...ids],
  )

export const selected = (page: Page) => readBd(page, (ed) => [...ed.getSelectedShapeIds()].sort())

// ---- menus -------------------------------------------------------------------------------------------

/** Opens tldraw's main (board) menu and its "Board" submenu. */
export async function openBoardMenu(page: Page) {
  const content = page.getByTestId('main-menu-sub.dr-board-content')
  if (!(await content.isVisible())) {
    await page.getByTestId('main-menu.button').click()
    await page.getByTestId('main-menu-sub.dr-board-button').click()
  }
  await expect(content).toBeVisible()
  return content
}

/**
 * Closes open tldraw menus with Escape, one press at a time and only while one is still open (a stray
 * Escape on the canvas would clear the selection).
 */
export async function closeMenus(page: Page) {
  const menus = page.locator('.tlui-menu')
  for (let i = 0; i < 3 && (await menus.count()) > 0; i++) {
    await page.keyboard.press('Escape')
    await expect(menus)
      .toHaveCount(0, { timeout: 1_000 })
      .catch(() => {})
  }
  await expect(menus).toHaveCount(0)
}

/** The board menu's "Hide note authors" checkbox (a menuitemcheckbox; radix renders no test id). */
export const hideAuthorsItem = (page: Page) =>
  page.getByRole('menuitemcheckbox', { name: 'Hide note authors' })

/** Right-clicks the canvas at a page point and waits for the context menu. */
export async function contextMenuAt(page: Page, point: VecLike) {
  const s = await readBd(page, (ed, p) => ed.pageToScreen(p), point)
  await page.mouse.click(s.x, s.y, { button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  return menu
}

/** Opens a context-menu submenu by its tldraw id and returns its content. */
export async function openContextSubmenu(page: Page, id: string) {
  await page.getByTestId(`context-menu-sub.${id}-button`).click()
  const content = page.getByTestId(`context-menu-sub.${id}-content`)
  await expect(content).toBeVisible()
  return content
}

// ---- geometry ------------------------------------------------------------------------------------------

/** Distinct values, rounded to 0.01, ascending. */
export const distinct = (values: number[]) =>
  [...new Set(values.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b)

export function anyOverlap(list: readonly BoxLike[]): boolean {
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i] as BoxLike
      const b = list[j] as BoxLike
      if (
        a.x < b.x + b.w - 0.01 &&
        b.x < a.x + a.w - 0.01 &&
        a.y < b.y + b.h - 0.01 &&
        b.y < a.y + a.h - 0.01
      )
        return true
    }
  return false
}

/** The camera, rounded for comparisons across browsers. */
export const cameraOf = (page: Page) =>
  readBd(page, (ed) => {
    const c = ed.getCamera()
    return { x: c.x, y: c.y, z: c.z }
  })

export const near = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  px = 2,
) => Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px && Math.abs(a.z - b.z) < 0.01
