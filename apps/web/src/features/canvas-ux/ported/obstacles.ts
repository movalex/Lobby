// Wave M (M1-3; FTU-2 core, FTU-11): canvas-ux's board chrome as obstacles for popovers (lib/overlay-obstacles.ts),
// and the reads the selection bar places itself with.
//  - registers the style panel ('style-panel', top right on a wide canvas) and the bottom toolbar ('bottom-toolbar':
//    the tools row with the quick actions above it on a narrow canvas) with client-pixel boxes; the selection bar
//    registers itself ('selection-bar') from its component;
//  - the selection's flow '+' handles: W4's 'flow-handles' obstacle when it is registered and plausible, else the
//    handle buttons in the DOM, only while they belong to the selection. The bar treats them as part of the
//    selection (it goes past them), so it never sits on the bottom '+' again (wave L follow-up).
// Boxes are read when asked, never cached.
import { OBSTACLE_IDS, obstacleRects, type Rect, registerObstacle } from '../../../lib/overlay-obstacles.ts'

/** An element's box in client pixels, or null when it is not shown (no element, no size). */
export function clientRectOf(el: Element | null | undefined): Rect | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (!(r.width > 0 && r.height > 0)) return null
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

/** The style panel's selector: the panel in its host slot (the phone's sheet is the toolbar's, and hides the bar). */
export const STYLE_PANEL_SELECTOR = '[data-lobby-slot="stylePanel"] [data-testid="style.panel"]'
/** The bottom toolbar: its wrap holds the tools row and, on a narrow canvas, the quick actions above it. */
export const BOTTOM_TOOLBAR_SELECTOR = '[data-lobby-slot="toolbar"] .cux-toolbar-wrap'
/** The navigation panel (zoom, minimap) at the bottom left: a plain obstacle of the bar's own (no registry id). */
export const NAVIGATION_SELECTOR = '[data-lobby-slot="navigation"] > *'
/**
 * The workshop's bottom-centre stack (the vote banner, the vote bar and the rows above the toolbar): each shown item a
 * plain obstacle of the bar's own, as the navigation panel. Since the bar goes past the selection's '+' handles (M1-3)
 * it otherwise landed on the vote banner's "Join and vote" (the wave M integration, K3-1).
 */
export const WORKSHOP_STACK_SELECTOR = '[data-testid="workshop-stack"] > *'
/**
 * The storyboard strip (wave T, features/storyboard/Strip.tsx), docked along the bottom while a panel is selected: a
 * plain obstacle of the bar's own, as the workshop stack. The wave T integration: a panel low on the screen put the
 * bar (and its "Play animatic") under the strip.
 */
export const STORYBOARD_STRIP_SELECTOR = '[data-testid="sb-strip"]'

/** Registers canvas-ux's chrome (the style panel, the bottom toolbar); returns the unregister. */
export function installChromeObstacles(doc: Document): () => void {
  const offs = [
    registerObstacle(OBSTACLE_IDS.stylePanel, 'panel', () =>
      clientRectOf(doc.querySelector(STYLE_PANEL_SELECTOR)),
    ),
    registerObstacle(OBSTACLE_IDS.bottomToolbar, 'toolbar', () =>
      clientRectOf(doc.querySelector(BOTTOM_TOOLBAR_SELECTOR)),
    ),
  ]
  return () => {
    for (const off of offs) off()
  }
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  }
}

/**
 * How far a box of flow handles may reach past the selection's box and still be the selection's (px): a button sits
 * 22 px out and is 24 px across, and the up one moves further out past the rotation handle (28 px on a touch screen).
 */
export const HANDLES_REACH = 96

/** Whether `handles` is the box of handles around `selection` (it holds it and reaches at most HANDLES_REACH out). */
export function handlesOf(selection: Rect, handles: Rect | null | undefined): boolean {
  if (!handles) return false
  const u = union(selection, handles)
  return (
    selection.x - u.x <= HANDLES_REACH &&
    selection.y - u.y <= HANDLES_REACH &&
    u.x + u.width - (selection.x + selection.width) <= HANDLES_REACH &&
    u.y + u.height - (selection.y + selection.height) <= HANDLES_REACH &&
    // it is around the selection, not somewhere else on the board
    handles.x < selection.x + selection.width + HANDLES_REACH &&
    handles.x + handles.width > selection.x - HANDLES_REACH &&
    handles.y < selection.y + selection.height + HANDLES_REACH &&
    handles.y + handles.height > selection.y - HANDLES_REACH
  )
}

/**
 * The client box of the selection's flow '+' handles, or null: W4's registered obstacle when it is a box around the
 * selection, else the handle buttons on screen while their source is selected.
 */
export function selectionHandlesRect(
  doc: Document,
  selection: readonly string[],
  selectionBox: Rect,
): Rect | null {
  const registered = obstacleRects().find((o) => o.id === OBSTACLE_IDS.flowHandles)?.rect ?? null
  if (registered && handlesOf(selectionBox, registered)) return registered
  const layer = doc.querySelector('[data-testid="flow-handles"]')
  const source = layer?.getAttribute('data-flow-source')
  if (!layer || !source || !selection.includes(source)) return null
  let box: Rect | null = null
  for (const b of layer.querySelectorAll('[data-testid^="flow-handle-"]')) {
    const r = clientRectOf(b)
    if (r) box = box ? union(box, r) : r
  }
  return box && handlesOf(selectionBox, box) ? box : null
}

/**
 * The other chrome the bar keeps clear of, in client pixels: every registered obstacle but the bar and the handles,
 * the navigation panel, the workshop's bottom-centre stack and the storyboard strip.
 */
export function barObstacles(doc: Document): Rect[] {
  const out = obstacleRects([OBSTACLE_IDS.selectionBar, OBSTACLE_IDS.flowHandles]).map((o) => o.rect)
  for (const selector of [NAVIGATION_SELECTOR, WORKSHOP_STACK_SELECTOR, STORYBOARD_STRIP_SELECTOR])
    for (const el of doc.querySelectorAll(selector)) {
      const r = clientRectOf(el)
      if (r) out.push(r)
    }
  return out
}
