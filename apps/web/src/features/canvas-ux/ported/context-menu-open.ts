// Opening canvas-ux's context menu (A11Y-04): a right-click on the canvas (the board page's `input` stream:
// the engine's own menu never opens), Shift+F10 or the menu key for the selection (else the middle of the
// view). A right-click on an element that is not selected selects it first (a locked one is not
// selected: its menu offers Unlock all); a right-click on empty canvas away from the selection clears it.
// The menu's target is what that right-click selected: the engine applies a select() a render later, so
// reading canvas.selection back here would still give the previous selection (CR 3E-4, the wave-3b
// integration).
import type { CanvasElement, CanvasFeatureContext, ScenePoint } from '../../../canvas/api/index.ts'
import { geometry, items } from '../../../canvas/api/index.ts'
import { uxState } from './state.ts'

export function openContextMenu(
  ctx: CanvasFeatureContext,
  scene: ScenePoint,
  hit: CanvasElement | null,
  fromKeyboard: boolean,
): boolean {
  const { canvas } = ctx
  const s = uxState(canvas)
  s.mainMenuOpen.set(false)
  s.moreOpen.set(false)
  let ids: readonly string[] = canvas.selection
  if (!fromKeyboard) {
    const root = hit ? items.containerOf(hit, (x) => canvas.get(x)) : null
    const sel = canvas.selection
    if (root) {
      const inSelection =
        sel.includes(root.id) ||
        (root.groupIds.length > 0 &&
          sel.some((id) => canvas.get(id)?.groupIds.some((g) => root.groupIds.includes(g))))
      if (!inSelection && !canvas.isLocked(root.id)) {
        canvas.select([root.id])
        ids = [root.id]
      }
    } else {
      const b = canvas.boundsOf()
      if (sel.length && (!b || !geometry.containsPoint(b, scene))) {
        canvas.select([])
        ids = []
      }
    }
  }
  const at = canvas.sceneToOverlay(scene)
  s.contextMenu.set({ target: { ids: [...ids], point: scene, hit }, at, fromKeyboard })
  return true
}

/** Shift+F10 / the menu key: the menu for the selection, at its centre (or the middle of the view). */
export function openContextMenuForSelection(ctx: CanvasFeatureContext): boolean {
  const { canvas } = ctx
  const b = canvas.selection.length ? canvas.boundsOf() : null
  const p = b ? geometry.center(b) : geometry.center(canvas.viewport.get())
  const hit = canvas.selection.length === 1 ? (canvas.get(canvas.selection[0] as string) ?? null) : null
  return openContextMenu(ctx, p, hit, true)
}
