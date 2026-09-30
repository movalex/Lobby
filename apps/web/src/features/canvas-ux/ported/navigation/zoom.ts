// The zoom actions (MAK-10: tldraw's zoom-in, zoom-out, zoom-to-100, zoom-to-fit, zoom-to-selection) on
// Lobby's own camera (canvas/api/parts/navigation.ts): the zoom menu, the navigation panel's buttons and
// the keys run these. Fit goes below Excalidraw's 0.1 when the board needs it (docs/EXCALIDRAW-MIGRATION.md
// §4.2, spike A's A14).
import type { LobbyCanvas } from '../../../../canvas/api/index.ts'
import { contentBounds } from './camera.ts'

const ANIMATE = { animate: true } as const

export const zoomIn = (canvas: LobbyCanvas) => canvas.viewport.zoomStep('in', undefined, ANIMATE)
export const zoomOut = (canvas: LobbyCanvas) => canvas.viewport.zoomStep('out', undefined, ANIMATE)

/** 100% around the view's centre (tldraw's resetZoom). */
export function zoomTo100(canvas: LobbyCanvas) {
  const v = canvas.viewport.get()
  canvas.viewport.zoomTo(
    { x: v.x + v.width / 2, y: v.y + v.height / 2, width: 0, height: 0 },
    { zoom: 1, ...ANIMATE },
  )
}

/** Every item in view (tldraw's zoomToFit: it may zoom in on a small board, up to the top step). */
export function zoomToFit(canvas: LobbyCanvas) {
  const b = contentBounds(canvas)
  if (b) canvas.viewport.zoomTo(b, { maxZoom: canvas.viewport.limits().max, ...ANIMATE })
}

/**
 * tldraw's zoomToSelection: 100% centred on the selection (zooming out when it does not fit), or, when
 * already at 100%, the selection fitted (which may zoom in).
 */
export function zoomToSelection(canvas: LobbyCanvas) {
  const b = canvas.selection.length ? canvas.boundsOf(canvas.selection) : null
  if (!b) return
  const atHundred = Math.abs(canvas.viewport.get().zoom - 1) < 0.01
  canvas.viewport.zoomTo(b, { maxZoom: atHundred ? canvas.viewport.limits().max : 1, ...ANIMATE })
}

/**
 * The single unlocked note a printable key types into (type-to-edit, COL-04): a navigation key that is a
 * printable character (M, =, -, Shift+1…) leaves it to type-to-edit then, as on the tldraw board.
 */
export function typeToEditTarget(canvas: LobbyCanvas): boolean {
  if (canvas.readOnly() || canvas.editingId() !== null || canvas.selection.length !== 1) return false
  const el = canvas.get(canvas.selection[0] as string)
  return !!el && el.type === 'stickynote' && !canvas.isLocked(el.id)
}
