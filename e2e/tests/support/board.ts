import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test'
import { signInContext } from './api.ts'
import type { BindingLike, BoxLike, EditorLike, RecordLike, ShapeLike, VecLike } from './editor.ts'
import { plainText } from './editor.ts'
import type { TestUser } from './users.ts'

export interface Session {
  /** The dev sign-in handle ("alice"). */
  readonly user: string
  /** Display name: what presence, cursors and editing badges show. */
  readonly name: string
  /** The API's user id (usr_…): presence and badge `data-user-id` values. */
  readonly id: string
  readonly context: BrowserContext
  readonly page: Page
}

/** The editor is mounted and the sync socket is live. */
export async function waitForBoard(page: Page) {
  await page.waitForFunction(() => window.editor !== undefined, undefined, { timeout: 30_000 })
  await expect(page.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', { timeout: 30_000 })
}

/**
 * The real dev sign-in form. The page must be on /signin (or be redirected there, as any protected
 * page is when signed out); afterwards the app returns to where it was sent from. `email` (domain
 * access) fills "Email (dev only)"; without it the account is <handle>@dev.invalid, a creator.
 */
export async function signInThroughUi(page: Page, user: { handle: string; name: string; email?: string }) {
  await expect(page.getByTestId('signin-form')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('dev-signin-notice')).toBeVisible()
  await page.getByTestId('signin-handle').fill(user.handle)
  await page.getByTestId('signin-name').fill(user.name)
  if (user.email !== undefined) await page.getByTestId('dev-login-email').fill(user.email)
  await page.getByTestId('signin-submit').click()
  await expect(page.getByTestId('signin-form')).toHaveCount(0, { timeout: 30_000 })
}

/**
 * Opens `board` as `user` in a new browser context. `via: 'ui'` follows the board link while signed
 * out, signs in through the form and lands back on the board; `via: 'cookie'` (default) signs the
 * context in through the same dev login endpoint first.
 */
export async function openSession(
  browser: Browser,
  board: string,
  user: TestUser,
  opts: { via?: 'ui' | 'cookie' } = {},
): Promise<Session> {
  const context = await browser.newContext()
  const page = await context.newPage()
  if (opts.via === 'ui') {
    await page.goto(`/b/${board}`)
    await expect(page).toHaveURL(/\/signin\?returnTo=/)
    await signInThroughUi(page, user)
    await expect(page).toHaveURL(new RegExp(`/b/${board}$`))
  } else {
    await signInContext(context, user.handle, user.name)
    await page.goto(`/b/${board}`)
  }
  await waitForBoard(page)
  await expect(page.getByTestId('dev-identity-badge')).toHaveAttribute('data-user-id', user.id)
  return { user: user.handle, name: user.name, id: user.id, context, page }
}

export const connStatus = (page: Page) => page.getByTestId('conn-status')

/** Polls until `read` yields a value and returns it. */
export async function waitForValue<T>(
  read: () => Promise<T | null | undefined>,
  opts: { timeout?: number; message?: string } = {},
): Promise<T> {
  let value: T | null | undefined
  await expect
    .poll(async () => {
      value = await read()
      return value ?? null
    }, opts)
    .not.toBeNull()
  return value as T
}

export async function expectConn(page: Page, state: 'online' | 'offline' | 'error', timeout = 30_000) {
  await expect(connStatus(page)).toHaveAttribute('data-state', state, { timeout })
}

// ---- running code against `window.editor` inside the page ---------------------------------------

function inPage(fn: (editor: EditorLike, arg: never) => unknown, arg: unknown, discard: boolean): string {
  // `fn` is serialized like any page.evaluate callback, so it may only use its two parameters.
  // Explicit semicolons: this is source text, and a line starting with "(" would otherwise continue
  // the previous statement.
  const call = `(${fn.toString()})(editor, ${JSON.stringify(arg ?? null)})`
  return `(() => {
    const editor = window.editor;
    if (!editor) throw new Error('window.editor is not mounted');
    ${discard ? `${call}; return null;` : `return ${call};`}
  })()`
}

/**
 * Runs `fn(editor, arg)` in the page for its side effects. Editor mutators return the editor itself,
 * which cannot be serialized back, so the result is dropped.
 */
export async function edit<A>(page: Page, fn: (editor: EditorLike, arg: A) => unknown, arg?: A) {
  await page.evaluate(inPage(fn as (e: EditorLike, a: never) => unknown, arg, true))
}

/** Evaluates `fn(editor, arg)` in the page and returns its (serializable) result. */
export async function read<T, A = undefined>(page: Page, fn: (editor: EditorLike, arg: A) => T, arg?: A) {
  return (await page.evaluate(inPage(fn as (e: EditorLike, a: never) => unknown, arg, false))) as T
}

// ---- reading editor state ------------------------------------------------------------------------

export const getShape = (page: Page, id: string) =>
  page.evaluate((shapeId) => window.editor?.getShape(shapeId) ?? null, id)

export const shapeText = async (page: Page, id: string) => {
  const shape = await getShape(page, id)
  return shape ? plainText(shape.props.richText) : null
}

export const shapeBounds = (page: Page, id: string): Promise<BoxLike | null> =>
  page.evaluate((shapeId) => {
    const b = window.editor?.getShapePageBounds(shapeId)
    return b ? { x: b.x, y: b.y, w: b.w, h: b.h } : null
  }, id)

export const pageShapes = (page: Page): Promise<ShapeLike[]> =>
  page.evaluate(() => window.editor?.getCurrentPageShapes() ?? [])

export const arrowBindings = (page: Page, arrowId: string): Promise<BindingLike[]> =>
  page.evaluate((id) => window.editor?.getBindingsFromShape(id, 'arrow') ?? [], arrowId)

export interface BoardDocument {
  shapes: Record<string, ShapeLike>
  bindings: Record<string, BindingLike>
  assets: Record<string, RecordLike>
}

/** The synced document records (shapes, bindings, assets) this tab currently holds, by id. */
export async function boardDocument(page: Page): Promise<BoardDocument> {
  const records = await page.evaluate(() =>
    (window.editor?.store.allRecords() ?? []).filter(
      (r) => r.typeName === 'shape' || r.typeName === 'binding' || r.typeName === 'asset',
    ),
  )
  const doc: BoardDocument = { shapes: {}, bindings: {}, assets: {} }
  for (const r of records) {
    if (r.typeName === 'shape') doc.shapes[r.id] = r as ShapeLike
    else if (r.typeName === 'binding') doc.bindings[r.id] = r as BindingLike
    else doc.assets[r.id] = r
  }
  return doc
}

/** Ids of records that differ between two tabs ([] = converged). Readable in a failed poll. */
export function documentDiff(a: BoardDocument, b: BoardDocument): string[] {
  const out: string[] = []
  for (const kind of ['shapes', 'bindings', 'assets'] as const) {
    const ids = new Set([...Object.keys(a[kind]), ...Object.keys(b[kind])])
    for (const id of ids) {
      if (JSON.stringify(a[kind][id]) !== JSON.stringify(b[kind][id])) out.push(id)
    }
  }
  return out.sort()
}

/** Waits until every page holds exactly the same shapes, bindings and assets as `reference`. */
export async function expectConverged(reference: Page, others: Page[], timeout = 20_000) {
  await expect
    .poll(
      async () => {
        const ref = await boardDocument(reference)
        const diffs = await Promise.all(others.map(async (p) => documentDiff(ref, await boardDocument(p))))
        return diffs.flat()
      },
      { timeout, message: 'tabs hold different document records' },
    )
    .toEqual([])
}

// ---- driving the UI ----------------------------------------------------------------------------

export async function toScreen(page: Page, point: VecLike): Promise<VecLike> {
  return page.evaluate((p) => {
    const s = window.editor?.pageToScreen(p)
    if (!s) throw new Error('editor not mounted')
    return { x: s.x, y: s.y }
  }, point)
}

export async function shapeCenterOnScreen(page: Page, id: string): Promise<VecLike> {
  const b = await shapeBounds(page, id)
  if (!b) throw new Error(`shape ${id} has no bounds`)
  return toScreen(page, { x: b.x + b.w / 2, y: b.y + b.h / 2 })
}

/** Double-clicks a note/text/geo shape to enter text editing, like a user would. */
export async function startTextEditing(page: Page, id: string) {
  const c = await shapeCenterOnScreen(page, id)
  await page.mouse.dblclick(c.x, c.y)
  await waitForTextEditor(page, id)
}

/**
 * Enters text editing from the keyboard (select, then Enter). A note opens with the caret at the end of
 * its text (A11Y-12); other shapes open with all of their text selected (tldraw).
 * Unlike a double-click there is no pointer-driven caret placement to race with later keys.
 */
export async function startTextEditingWithKeyboard(page: Page, id: string) {
  await edit(page, (ed, shapeId) => ed.select(shapeId), id)
  await page.keyboard.press('Enter')
  await waitForTextEditor(page, id)
}

/** Resolves once `id` (or any shape) is being text-edited and its editor has keyboard focus. */
export async function waitForTextEditor(page: Page, id?: string): Promise<string> {
  const editingId = () => page.evaluate(() => window.editor?.getEditingShapeId() ?? null)
  if (id) await expect.poll(editingId).toBe(id)
  const editing = id ?? (await waitForValue(editingId))
  // Keys pressed before the text editor has focus go to the canvas (where "a" picks the arrow tool).
  await expect(page.locator(`[data-shape-id="${editing}"] [contenteditable="true"]`)).toBeFocused()
  // tldraw registers the TipTap instance in its onCreate (a setTimeout after mount), which is also
  // where it moves the caret to the double-click point; keys sent before that can land anywhere.
  await expect
    .poll(() =>
      read(
        page,
        (ed, shapeId) => {
          const tiptap = ed.getRichTextEditor()
          return !!tiptap && !tiptap.isDestroyed && !!tiptap.view.dom.closest(`[data-shape-id="${shapeId}"]`)
        },
        editing,
      ),
    )
    .toBe(true)
  return editing
}

export async function stopTextEditing(page: Page) {
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => window.editor?.getEditingShapeId() ?? null)).toBeNull()
}

/** Types through the real text editor (TipTap), one key event per character. */
export async function typeText(page: Page, text: string) {
  await page.keyboard.type(text, { delay: 15 })
}

/** Opens the app's "Insert file" chooser (Ctrl/Cmd+U) and picks the given files. */
export async function insertFiles(page: Page, paths: string[]) {
  const chooser = page.waitForEvent('filechooser')
  await page.keyboard.press('ControlOrMeta+u')
  await (await chooser).setFiles(paths)
}

export const fileCard = (page: Page, name: string) =>
  page.getByTestId('file-card').filter({ has: page.getByText(name, { exact: true }) })
