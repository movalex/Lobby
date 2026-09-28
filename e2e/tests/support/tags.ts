// Helpers for the tags suite (tags.spec.ts, wave 4). Storage: one meta key per tag, `drTags:<key>` on
// notes and file cards and `drTagList:<key>` on the document record (packages/contracts/src/tags.ts).
import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test'
import { waitForBoard } from './board.ts'
import { editEd, readEd } from './canvas-ux.ts'
import { editBd, readBd } from './canvas-ux-2.ts'
import { closeShare, openShareFromButton, shareDialog } from './dashboard-share.ts'
import { richText } from './editor.ts'

export interface Tag {
  key: string
  name: string
  color: string
}
export const tag = (key: string, name: string, color = 'blue'): Tag => ({ key, name, color })

/** Shape meta for these tags, in the stored format. */
export const tagsMeta = (...tags: Tag[]) =>
  Object.fromEntries(tags.map((t) => [`drTags:${t.key}`, { name: t.name, color: t.color }]))

export const noteAt = (id: string, x: number, y: number, text = '', meta: Record<string, unknown> = {}) => ({
  id,
  type: 'note',
  x,
  y,
  props: { richText: richText(text) },
  meta,
})

export async function createShapes(page: Page, shapes: Record<string, unknown>[]) {
  await editEd(
    page,
    (ed, list) => (ed as unknown as { createShapes(l: unknown[]): void }).createShapes(list),
    shapes,
  )
}

/** Tag keys stored on a shape (sorted), as this tab holds it. */
export const storedTagKeys = (page: Page, id: string) =>
  readEd(
    page,
    (ed, shapeId) =>
      Object.keys(ed.getShape(shapeId)?.meta ?? {})
        .filter((k) => k.startsWith('drTags:'))
        .map((k) => k.slice('drTags:'.length))
        .sort(),
    id,
  )

/** The board's tag list (document meta) as this tab holds it: key → { name, color }. */
export const boardList = (page: Page) =>
  readBd(page, (ed) => {
    const meta = ed.getDocumentSettings().meta ?? {}
    const out: Record<string, { name: string; color: string }> = {}
    for (const [k, v] of Object.entries(meta)) if (k.startsWith('drTagList:')) out[k.slice(10)] = v as never
    return out
  })

/** The chips drawn on a shape (inside its tldraw container). */
export const chips = (page: Page, id: string) =>
  page.locator(`.tl-shape[data-shape-id="${id}"] [data-testid="tag-chip"]`)
export const chipKeys = async (page: Page, id: string) =>
  (await chips(page, id).evaluateAll((els) => els.map((e) => e.getAttribute('data-tag-key') ?? ''))).sort()

export async function selectIds(page: Page, ids: readonly string[]) {
  await editEd(page, (ed, list) => ed.select(...list), [...ids])
  await expect(page.getByTestId('selection-bar')).toBeVisible()
}

/** Opens the picker from the selection bar's Tags button. */
export async function openPicker(page: Page) {
  const picker = page.getByTestId('tag-picker')
  if (!(await picker.isVisible())) await page.getByTestId('selection-tags').click()
  await expect(picker).toBeVisible()
  return picker
}

export const option = (page: Page, key: string) =>
  page.locator(`[data-testid="tag-picker"] [data-testid="tag-option"][data-tag-key="${key}"]`)

/** Puts the camera on a page point at an exact zoom. */
export async function cameraAt(page: Page, center: { x: number; y: number }, z: number) {
  await editEd(
    page,
    (ed, a) => {
      const e = ed as unknown as {
        getViewportScreenBounds(): { w: number; h: number }
        setCamera(c: { x: number; y: number; z: number }, o?: { immediate?: boolean }): void
      }
      const vp = e.getViewportScreenBounds()
      e.setCamera({ x: vp.w / (2 * a.z) - a.c.x, y: vp.h / (2 * a.z) - a.c.y, z: a.z }, { immediate: true })
    },
    { c: center, z },
  )
}

/** Opens the Tags dock panel. */
export async function openTagsPanel(page: Page) {
  const panel = page.getByTestId('tags-panel')
  if (!(await panel.isVisible())) await page.getByTestId('dock-tab-tags').click()
  await expect(panel).toBeVisible()
  return panel
}

export const row = (page: Page, key: string) =>
  page.locator(`[data-testid="tags-panel"] [data-testid="tag-row"][data-tag-key="${key}"]`)

/** Computed opacity of a shape's tldraw container (the "Show only" filter dims through it). */
export const shapeOpacity = (page: Page, id: string) =>
  page
    .locator(`.tl-shape[data-shape-id="${id}"]`)
    .first()
    .evaluate((el) => Number(getComputedStyle(el).opacity))

/** Writes the board's tag list directly (test setup; the UI path is tested on its own). */
export async function listOnBoard(page: Page, tags: Tag[]) {
  await editBd(
    page,
    (ed, list) => {
      const meta = { ...ed.getDocumentSettings().meta }
      for (const t of list) meta[`drTagList:${t.key}`] = { name: t.name, color: t.color }
      ed.updateDocumentSettings({ meta })
    },
    tags,
  )
}

/**
 * A read-only person's forged tag writes: the UI's read-only flag switched off, then a tag put on a note
 * and on the board's list the way the app writes them (whole records). The sync server must refuse both.
 */
export async function forgeTagWrites(page: Page, noteId: string) {
  await editBd(
    page,
    (ed, id) => {
      const e = ed as unknown as {
        updateInstanceState(p: unknown): void
        getShape(id: string): { meta: Record<string, unknown> } | undefined
        store: { put(records: unknown[]): void }
      }
      e.updateInstanceState({ isReadonly: false })
      const shape = e.getShape(id)
      if (shape)
        e.store.put([
          { ...shape, meta: { ...shape.meta, 'drTags:forged': { name: 'Forged', color: 'red' } } },
        ])
      const doc = ed.getDocumentSettings()
      ed.updateDocumentSettings({
        meta: { ...doc.meta, 'drTagList:forged': { name: 'Forged', color: 'red' } },
      })
    },
    noteId,
  )
}

// ---- name-only guests (as in guests.spec.ts) -------------------------------------------------------

/** On alice's open board: a guest-enabled link (workshop = editor, review = commenter); returns its URL. */
export async function createGuestLink(page: Page, kind: 'review' | 'workshop'): Promise<string> {
  await openShareFromButton(page)
  const dialog = shareDialog(page)
  await dialog.getByTestId(kind === 'review' ? 'review-link-guests' : 'workshop-link-guests').check()
  if (kind === 'review') await dialog.getByTestId('review-link-role').selectOption('commenter')
  await dialog.getByTestId(kind === 'review' ? 'review-link-create' : 'workshop-link-create').click()
  const linkRow = dialog.getByTestId(kind === 'review' ? 'review-link-row' : 'workshop-link-row')
  await expect(linkRow).toHaveCount(1)
  const url = await linkRow.getByTestId('review-link-url').inputValue()
  await closeShare(page)
  return url
}

/** A fresh context with no sign-in that joins `link` with just a name. */
export async function joinAsGuest(
  browser: Browser,
  link: string,
  name: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } })
  const page = await context.newPage()
  await page.goto(link)
  await page.getByTestId('invite-guest-name').fill(name)
  await page.getByTestId('invite-guest-join').click()
  await expect(page).toHaveURL(/\/b\/[a-z0-9-]+$/, { timeout: 30_000 })
  await waitForBoard(page)
  await expect(page.getByTestId('user-menu')).toHaveAttribute('data-kind', 'guest')
  return { context, page }
}

/** Whether the element's box lies inside the browser viewport (with a margin). */
export async function insideViewport(page: Page, selector: string, margin = 0) {
  const box = await page.locator(selector).boundingBox()
  const vp = page.viewportSize()
  if (!box || !vp) return false
  return (
    box.x >= margin &&
    box.y >= margin &&
    box.x + box.width <= vp.width - margin &&
    box.y + box.height <= vp.height - margin
  )
}
