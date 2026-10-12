// Facade-based helpers for PORTED specs (docs/EXCALIDRAW-MIGRATION.md §6.3, docs/EXCALIDRAW-CONTRACTS.md
// §9): the replacement for board.ts's `window.editor` helpers on the Excalidraw board page. Types and
// signatures are frozen at wave 1 (2E owns the bodies from wave 2 on).
//
// Rules for ported specs:
//  - Every canvas WRITE a spec makes goes through `window.lobbyCanvas` (the facade), whose writes go
//    through `CanvasPort.transact` and the sync engine, never straight into the engine's scene. Forged
//    writes use a raw WebSocket with the page's own ticket instead (spike-b/support/forge.ts).
//  - Clicks on canvas content go to `sceneToScreen` coordinates of an element (`clickItem`,
//    `itemCenterOnScreen`); overlays are found by their `data-lobby-*` / `data-testid` attributes.
//  - Text is plain: `itemText` reads a note's label; typing goes through the real editor after
//    `startTextEditing` (the lease is granted before a key is sent).
//  - Convergence is the facade's convergence hash (canvas-schema hash.ts), equal on every tab.
//
// Verbs: the C0 facade (apps/web/src/canvas/test-facade.types.ts) plus the wave-1 verbs
// (apps/web/src/canvas/api/facade.types.ts). Until 2E adds a wave-1 verb to the page, the helper falls
// back to spike B's harness channel (`window.__lobbyHarness`) where it has the same verb, or derives it
// from the C0 facade and the harness (`text`, `readOnly`; CR W1-2E-2), else fails with
// "facade verb <name> not implemented (2E)".
import { type Browser, type BrowserContext, expect, type Page } from '@playwright/test'
import type { FacadeMe, LobbyCanvasFacadeV1 } from '../../../apps/web/src/canvas/api/facade.types.ts'
import type {
  Bounds,
  CanvasElement,
  ItemKind,
  ScenePoint,
  ScreenPoint,
  Viewport,
} from '../../../apps/web/src/canvas/port.ts'
import type { PushRecord, SaveStatus } from '../../../apps/web/src/canvas/sync/types.ts'
import type { LobbyCanvasFacade } from '../../../apps/web/src/canvas/test-facade.types.ts'
import { signInContext } from './api.ts'
import { waitForValue } from './board.ts'
import { test as base } from './fixtures.ts'
import type { TestUser } from './users.ts'

export type { Bounds, CanvasElement, FacadeMe, ItemKind, ScenePoint, ScreenPoint, Viewport }

/** Every verb a spec may call on `window.lobbyCanvas`. */
export type CanvasFacade = LobbyCanvasFacade & LobbyCanvasFacadeV1
export type CanvasVerb = keyof CanvasFacade

/** One signed-in tab on the Excalidraw board page (board.ts `Session`, same fields). */
export interface CanvasSession {
  /** the dev sign-in handle ("alice") */
  readonly user: string
  /** display name: what presence and the editing badges show */
  readonly name: string
  /** the API's user id (usr_…): the roster uid */
  readonly id: string
  readonly context: BrowserContext
  readonly page: Page
}

/** The text editor Excalidraw opens (one per page). */
export const TEXT_EDITOR = 'textarea.excalidraw-wysiwyg'

// ---- calling the facade ---------------------------------------------------------------------------------

/**
 * Calls one facade verb in the page and returns its (JSON) result. Falls back to the spike harness for
 * the verbs it shares (`viewport`, `setViewport`, `screenToScene`, `ready`, `me`), and derives `readOnly`
 * and `text` from the harness and the C0 facade, until 2E lands them on the page.
 */
export async function canvasCall<V extends CanvasVerb>(
  page: Page,
  verb: V,
  ...args: Parameters<CanvasFacade[V]>
): Promise<Awaited<ReturnType<CanvasFacade[V]>>> {
  return (await page.evaluate(
    async ({ verb, args }) => {
      const f = (window as unknown as { lobbyCanvas?: Record<string, unknown> }).lobbyCanvas
      if (!f) throw new Error('window.lobbyCanvas is not installed (not the Excalidraw board page?)')
      const own = f[verb]
      if (typeof own === 'function') return await (own as (...a: unknown[]) => unknown).apply(f, args)
      type Session = {
        welcomed: boolean
        uid: string | null
        sid: string | null
        role: string | null
        guest: boolean | null
        readonly: boolean | null
      }
      const h = (window as unknown as { __lobbyHarness?: Record<string, unknown> & { session(): Session } })
        .__lobbyHarness
      if (h) {
        if (verb === 'ready') return h.session().welcomed
        if (verb === 'me') {
          const s = h.session()
          return s.welcomed && s.uid && s.sid
            ? { uid: s.uid, sid: s.sid, role: s.role, guest: !!s.guest }
            : null
        }
        // derived until the page has the verb: the welcome's read-only flag; an element's plain text (a
        // text's own, a frame's name, else its bound label's; '' when it has none)
        if (verb === 'readOnly') return h.session().readonly === true
        if (verb === 'text') {
          type El = {
            id: string
            type: string
            originalText?: string
            name?: string | null
            boundElements?: { id: string; type: string }[] | null
          }
          const all = (f.items as () => El[])()
          const el = all.find((e) => e.id === args[0])
          if (!el) return ''
          if (el.type === 'text') return el.originalText ?? ''
          if (el.type === 'frame') return el.name ?? ''
          const lbl = (el.boundElements ?? []).find((b) => b.type === 'text')
          return (lbl ? all.find((e) => e.id === lbl.id)?.originalText : undefined) ?? ''
        }
        const shared = h[verb]
        if (typeof shared === 'function') return await (shared as (...a: unknown[]) => unknown).apply(h, args)
      }
      throw new Error(`facade verb ${verb} not implemented (2E)`)
    },
    { verb, args: args as unknown[] },
  )) as Awaited<ReturnType<CanvasFacade[V]>>
}

// ---- sessions ------------------------------------------------------------------------------------------

/** The facade is installed and the first `welcome` is applied. */
export async function waitForCanvas(page: Page, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const f = (window as unknown as { lobbyCanvas?: { ready?: () => boolean } }).lobbyCanvas
      if (!f) return false
      if (typeof f.ready === 'function') return f.ready()
      const h = (window as unknown as { __lobbyHarness?: { session(): { welcomed: boolean } } })
        .__lobbyHarness
      return h?.session().welcomed === true
    },
    undefined,
    { timeout, polling: 50 },
  )
}

/**
 * Opens `board` as `user` in a new browser context (signed in through the dev login endpoint) and waits
 * for the canvas; checks that the server's `welcome` names this user.
 */
export async function openCanvasSession(
  browser: Browser,
  board: string,
  user: TestUser,
): Promise<CanvasSession> {
  const context = await browser.newContext()
  const page = await context.newPage()
  await signInContext(context, user.handle, user.name)
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  // polled, not read once: `me` is null for a tab that is between two welcomes (a reconnect just after the
  // first); gaps-board-status's fresh open of an archived board read null once under load (cause not found:
  // 2/2 alone, and the single failure is the only one seen)
  await expect
    .poll(async () => (await canvasCall(page, 'me'))?.uid, { message: 'the welcome names this user' })
    .toBe(user.id)
  return { user: user.handle, name: user.name, id: user.id, context, page }
}

// ---- reading ----------------------------------------------------------------------------------------------

/** Live elements, paint order (labels included). */
export const items = (page: Page): Promise<CanvasElement[]> => canvasCall(page, 'items')
export const item = (page: Page, id: string): Promise<CanvasElement | null> => canvasCall(page, 'get', id)
/** Plain text of an element (a note's label, a frame's name). */
export const itemText = (page: Page, id: string): Promise<string> => canvasCall(page, 'text', id)
export const itemBounds = (page: Page, id: string): Promise<Bounds | null> => canvasCall(page, 'bounds', id)
export const selection = (page: Page): Promise<string[]> => canvasCall(page, 'selection')
export const tool = (page: Page): Promise<string | null> => canvasCall(page, 'tool')
export const editingId = (page: Page): Promise<string | null> => canvasCall(page, 'editingId')
export const saveState = (page: Page): Promise<SaveStatus> => canvasCall(page, 'saveState')
export const viewport = (page: Page): Promise<Viewport> => canvasCall(page, 'viewport')
export const readOnly = (page: Page): Promise<boolean> => canvasCall(page, 'readOnly')
export const hash = (page: Page): Promise<string> => canvasCall(page, 'hash')
export const pushedOps = (page: Page): Promise<PushRecord[]> => canvasCall(page, 'pushedOps')
export const collaborators = (page: Page) => canvasCall(page, 'collaborators')
export const leaseHolder = (page: Page, id: string) => canvasCall(page, 'leaseHolder', id)

/** Polls until `id` exists (and `predicate` holds for it) and returns it. */
export async function waitForItem(
  page: Page,
  id: string,
  predicate: (el: CanvasElement) => boolean = () => true,
  timeout = 20_000,
): Promise<CanvasElement> {
  return waitForValue(
    async () => {
      const el = await item(page, id)
      return el && predicate(el) ? el : null
    },
    { timeout, message: `element ${id}` },
  )
}

// ---- writing (through the facade: transact, then the sync engine) ----------------------------------------------

export const createItem = (
  page: Page,
  kind: ItemKind,
  props: Record<string, unknown> = {},
): Promise<string> => canvasCall(page, 'create', kind, props)

/** A sticky note (with its label) at scene (x, y); `color` is its backgroundColor. */
export function createNote(
  page: Page,
  opts: { x: number; y: number; text?: string; color?: string; size?: number },
): Promise<string> {
  return createItem(page, 'note', {
    x: opts.x,
    y: opts.y,
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    ...(opts.color !== undefined ? { backgroundColor: opts.color } : {}),
    ...(opts.size !== undefined ? { size: opts.size } : {}),
  })
}

export const updateItem = (page: Page, id: string, patch: Record<string, unknown>): Promise<void> =>
  canvasCall(page, 'update', id, patch)
export const deleteItem = (page: Page, id: string): Promise<void> => canvasCall(page, 'delete', id)
export const select = (page: Page, ids: string[]): Promise<void> => canvasCall(page, 'select', ids)
export const selectNone = (page: Page): Promise<void> => canvasCall(page, 'select', [])
export const setTool = (page: Page, name: string): Promise<boolean> => canvasCall(page, 'setTool', name)
export const zoomToFit = (page: Page): Promise<void> => canvasCall(page, 'zoomToFit')
/**
 * Moves the camera through the harness. A camera animation of the board's own (a focus, a fit, "go to") is not stopped by
 * the harness's raw set, and takes the camera back on its next frame (the wave L "L-compat 3" flake), so a running one is
 * let finish first (at most 3 s; nothing to wait for on a page with no board handle). The page-side fix is test-facade.ts
 * stopping it as the board's own viewport.set does (the canvas workstream's); this keeps specs deterministic until then.
 */
export const setViewport = async (
  page: Page,
  v: Partial<Pick<Viewport, 'x' | 'y' | 'zoom'>>,
): Promise<void> => {
  await page
    .waitForFunction(
      () => {
        type W = { __lobbyBoard?: { canvas: { viewport: { moving(): boolean } } } }
        return !(window as unknown as W).__lobbyBoard?.canvas.viewport.moving()
      },
      undefined,
      { timeout: 3_000 },
    )
    .catch(() => undefined)
  await canvasCall(page, 'setViewport', v)
}
/** A frame's live children in paint order (tldraw's `getSortedChildIdsForParent`; GAP-1). */
export const children = (page: Page, frameId: string): Promise<string[]> =>
  canvasCall(page, 'children', frameId)

/**
 * A board-document key's value as this tab holds it (the server's copy with this tab's unsent and unacked
 * writes on top): workshop settings (`workshop`), the start view (`startView`), a tag (`tagDef:<key>`).
 * `undefined` for a key nobody wrote, `null` for one that was removed.
 */
export const getDoc = (page: Page, key: string): Promise<unknown> => canvasCall(page, 'doc', key)
/**
 * Writes board-document keys in one go, as the features do (`canvas.doc.set`: through the sync engine, the
 * page's own UI told); a `null` value removes the key. Two calls within one round trip are two pushes built
 * on the same base clock (doc-key-lost-write.spec.ts races them).
 */
export const setDoc = (page: Page, entries: Record<string, unknown>): Promise<void> =>
  canvasCall(page, 'setDoc', entries)

/** Lobby's undo (as Ctrl+Z on the board would). */
export const undo = (page: Page): Promise<void> => canvasCall(page, 'undo')
export const redo = (page: Page): Promise<void> => canvasCall(page, 'redo')

// ---- driving the UI ----------------------------------------------------------------------------------------

export const sceneToScreen = (page: Page, p: ScenePoint): Promise<ScreenPoint> =>
  canvasCall(page, 'sceneToScreen', p)
export const screenToScene = (page: Page, p: ScreenPoint): Promise<ScenePoint> =>
  canvasCall(page, 'screenToScene', p)

/** Screen (client) coordinates of an element's centre, for page.mouse. */
export async function itemCenterOnScreen(page: Page, id: string): Promise<ScreenPoint> {
  const b = await itemBounds(page, id)
  if (!b) throw new Error(`element ${id} has no bounds`)
  return sceneToScreen(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 })
}

export async function clickItem(
  page: Page,
  id: string,
  opts: { button?: 'left' | 'right'; modifiers?: ('Shift' | 'Alt' | 'ControlOrMeta')[] } = {},
): Promise<void> {
  const c = await itemCenterOnScreen(page, id)
  for (const m of opts.modifiers ?? []) await page.keyboard.down(m)
  await page.mouse.click(c.x, c.y, { button: opts.button ?? 'left' })
  for (const m of opts.modifiers ?? []) await page.keyboard.up(m)
}

export async function dblclickItem(page: Page, id: string): Promise<void> {
  const c = await itemCenterOnScreen(page, id)
  await page.mouse.dblclick(c.x, c.y)
}

/** Drags an element by (dx, dy) screen pixels with the real pointer, in `steps` moves. */
export async function dragItem(page: Page, id: string, delta: ScreenPoint, steps = 8): Promise<void> {
  const c = await itemCenterOnScreen(page, id)
  await page.mouse.move(c.x, c.y)
  await page.mouse.down()
  await page.mouse.move(c.x + delta.x, c.y + delta.y, { steps })
  await page.mouse.up()
}

// ---- text (through the real editor and the lease) -------------------------------------------------------------

/**
 * Resolves once this tab edits `id` (or any element): the lease is granted, Excalidraw's textarea has
 * the keyboard and is writable. Keys sent before that are buffered by the lease flow or go to the board.
 */
export async function waitForTextEditor(page: Page, id?: string, timeout = 15_000): Promise<string> {
  if (id) await expect.poll(() => editingId(page), { timeout }).toBe(id)
  const editing = id ?? (await waitForValue(() => editingId(page), { timeout, message: 'an open editor' }))
  const editor = page.locator(TEXT_EDITOR)
  await expect(editor).toBeFocused({ timeout })
  await expect(editor).toHaveJSProperty('readOnly', false, { timeout })
  return editing
}

/** Double-clicks an element's centre (the P2 editor-open path), then waits for the editor. */
export async function startTextEditing(page: Page, id: string): Promise<void> {
  await dblclickItem(page, id)
  await waitForTextEditor(page, id)
}

/** Selects the element and presses Enter (the P1 path; a note opens with the caret at the end). */
export async function startTextEditingWithKeyboard(page: Page, id: string): Promise<void> {
  await select(page, [id])
  // the board's keys go to the focused canvas: a tab that has not clicked it yet must be given it
  await page.evaluate(() => document.querySelector<HTMLElement>('.excalidraw')?.focus())
  await page.keyboard.press('Enter')
  await waitForTextEditor(page, id)
}

/** Escape: the editor closes (the edit becomes one undo step) and the lease is released. */
export async function stopTextEditing(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect.poll(() => editingId(page)).toBeNull()
}

/** Types through the real textarea, one key event per character. */
export async function typeText(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text, { delay: 15 })
}

// ---- sync ------------------------------------------------------------------------------------------------

/** "Saved" (§2.5.7): nothing dirty, in flight or queued on this tab. */
export async function expectSaved(page: Page, timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => (await saveState(page)).state, { timeout, message: 'save state' })
    .toBe('saved')
}

/** Waits until every tab's convergence hash equals `reference`'s (tombstones included). */
export async function expectConverged(reference: Page, others: Page[], timeout = 20_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const ref = await hash(reference)
        const all = await Promise.all(others.map((p) => hash(p)))
        return all.filter((h) => h !== ref).length
      },
      { timeout, message: 'tabs hold different element maps' },
    )
    .toBe(0)
}

// ---- fixture ------------------------------------------------------------------------------------------------

interface CanvasFixtures {
  /**
   * Opens the test's `board` as `user` on the Excalidraw page (closed after the test). Anyone but alice
   * first gets an explicit grant (default: editor), as fixtures.ts `session` does.
   */
  canvasSession(
    user: string,
    opts?: { role?: 'owner' | 'editor' | 'commenter' | 'viewer' | null },
  ): Promise<CanvasSession>
}

/** fixtures.ts `test` plus `canvasSession`. Ported specs import `test` and `expect` from here. */
export const test = base.extend<CanvasFixtures>({
  canvasSession: async ({ browser, board, users }, use) => {
    const opened: CanvasSession[] = []
    await use(async (user, opts = {}) => {
      const who = opts.role === null ? await users.get(user) : await users.grant(board, user, opts.role)
      const s = await openCanvasSession(browser, board, who)
      opened.push(s)
      return s
    })
    await Promise.all(opened.map((s) => s.context.close()))
  },
})

export { expect }
