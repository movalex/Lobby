// Owner-set start view (PRE-08): an editor or owner saves the current view (or a frame) as the board's
// start view. It lives in the tldraw document record's `meta` (key `drStartView`), so the board's own
// sync carries it to everyone, it persists with the board, and it never enters anyone's undo history
// (`editor.updateDocumentSettings` writes with history: 'ignore'). Read-only roles cannot write the
// document (the sync server marks their session read-only), so only editors and owners can set it.
//
// Who uses it: people opening the board with no saved camera of their own (a first visit, a new
// browser) land there; everyone can "Go to start view" from the board menu. Returning people keep
// their own last view (PRE-06, start-view.ts). Pure; the editor wiring is start-view-runtime.ts.

export const START_VIEW_META_KEY = 'drStartView'

export interface BoardStartView {
  pageId: string
  /** The saved area, in page coordinates (the viewport's page bounds when it was set). */
  x: number
  y: number
  w: number
  h: number
  /** Set from a frame: the view follows that frame while it exists on that page. */
  frameId?: string
}

const MAX_ABS = 1e9
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < MAX_ABS

/** The start view in a document record's meta; anything missing or malformed reads as none. */
export function parseBoardStartView(meta: unknown): BoardStartView | null {
  const raw = isObject(meta) ? meta[START_VIEW_META_KEY] : undefined
  if (!isObject(raw)) return null
  const { pageId, x, y, w, h, frameId } = raw
  if (typeof pageId !== 'string' || !pageId.startsWith('page:') || pageId.length > 300) return null
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w <= 0 || h <= 0) return null
  const view: BoardStartView = { pageId, x, y, w, h }
  if (typeof frameId === 'string' && frameId.startsWith('shape:') && frameId.length <= 300)
    view.frameId = frameId
  return view
}

/** The new document meta with the start view set, or cleared with `null` (other meta keys are kept). */
export function withBoardStartView(meta: unknown, view: BoardStartView | null): Record<string, unknown> {
  const base = isObject(meta) ? meta : {}
  if (!view) return { ...base, [START_VIEW_META_KEY]: null }
  const clean: Record<string, unknown> = { pageId: view.pageId, x: view.x, y: view.y, w: view.w, h: view.h }
  if (view.frameId) clean.frameId = view.frameId
  return { ...base, [START_VIEW_META_KEY]: clean }
}
