// The logic of ./ViewHelpers.tsx (the navigation overlay's "Back to content" button, W5-54, and the outline
// of a connector this feature selected by code, W5-39), apart from React so Node tests reach it.
import type { LobbyCanvas } from '../../../../canvas/api/index.ts'
import { contentBounds, viewportHasContent } from './camera.ts'
import { codeSelection } from './state.ts'

/** tldraw's BACK_TO_CONTENT_APPEAR_DELAY_MS: the button waits this long after the view emptied. */
export const BACK_TO_CONTENT_DELAY_MS = 1000

/** tldraw's back-to-content: the selection, else all content, at no more than the zoom now (and 100%). */
export function backToContent(canvas: LobbyCanvas): void {
  const b = (canvas.selection.length ? canvas.boundsOf(canvas.selection) : null) ?? contentBounds(canvas)
  if (!b) return
  const zoom = canvas.viewport.get().zoom
  canvas.viewport.zoomTo(b, { maxZoom: Math.min(1, zoom), animate: { durationMs: 220 } })
}

/** Whether "Back to content" should show now: the board has content and none of it is in view. */
export const viewIsEmpty = (canvas: LobbyCanvas): boolean =>
  contentBounds(canvas) !== null && !viewportHasContent(canvas)

const LINEAR = new Set(['arrow', 'line'])
export const sameIds = (a: readonly string[], b: readonly string[]) => {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((id) => s.has(id))
}

/** Records that this feature selects `ids` by code (W5-39), then selects them. */
export function selectByCode(canvas: LobbyCanvas, ids: readonly string[]): void {
  codeSelection(canvas).set([...ids])
  canvas.select(ids)
}

/** Drops the record once the selection is something else (the engine's own selection drawing takes over). */
export function installCodeSelectionReset(canvas: LobbyCanvas): () => void {
  return canvas.on('selectionChanged', (ids) => {
    const own = codeSelection(canvas).get()
    if (own.length && !sameIds(ids, own)) codeSelection(canvas).set([])
  })
}

/**
 * The outline boxes (overlay pixels) of the linear elements of the code selection, while it stands. A lone
 * unlocked connector or line gets none: `select` gives it the engine's own point handles (CR 3b-11), so only
 * the connectors of a selection of several (which the engine draws no handles for) are outlined.
 */
export function codeSelectionBoxes(
  canvas: LobbyCanvas,
): { id: string; x: number; y: number; w: number; h: number }[] {
  const own = codeSelection(canvas).get()
  if (!own.length || !sameIds(canvas.selection, own)) return []
  const zoom = canvas.viewport.get().zoom
  const out: { id: string; x: number; y: number; w: number; h: number }[] = []
  for (const id of own) {
    const el = canvas.get(id)
    if (!el || el.isDeleted || !LINEAR.has(el.type)) continue
    if (own.length === 1 && !el.locked) continue
    const b = canvas.bounds(id)
    if (!b) continue
    const tl = canvas.sceneToOverlay({ x: b.x, y: b.y })
    out.push({ id, x: tl.x - 8, y: tl.y - 8, w: b.width * zoom + 16, h: b.height * zoom + 16 })
  }
  return out
}
