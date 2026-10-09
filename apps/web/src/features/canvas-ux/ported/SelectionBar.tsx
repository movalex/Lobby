// The selection bar on the Excalidraw canvas (host slot `selectionBar`; the tldraw page's SelectionBar in
// ../Overlay.tsx): a small toolbar under the selection with every feature's `selectionBar` items. canvas-ux's
// own: Lock / Unlock (Ctrl+Shift+L), and align / distribute (MAK-03) for two or three movable units.
//
// Order bands (other features choose their `order` by them): below 100 the main row (copy link 10, lock 20,
// tags 30, AI 40), from 100 the arrange row (align and distribute 100, arrange as grid 200). A11Y2-06: on a
// canvas narrower than 600 px the arrange row folds into "More" (a second row when open). A11Y-04: Alt+F10
// on the board lands on the first button; arrows, Home and End move along the bar (ARIA toolbar), Tab
// leaves it, Escape gives the keyboard back to the board. A mouse click never takes the keyboard from the
// board. Hidden while an editor is open, during a drag or a resize, and when the selection is off screen.
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasFeatureContext, SelectionBarItemSpec } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { AlignIcons, LockIcon } from '../icons.tsx'
import { unitsOf } from './align.ts'
import { CMD, runCommand, selectedRoots } from './commands.ts'
import { uxState } from './state.ts'
import { moveInToolbar, rove } from './toolbar-keys.ts'

/** A11Y2-06: below this canvas width, the arrange row folds into the bar's "More" button. */
export const SELBAR_COMPACT_BELOW = 600
/** Items from this order on form the arrange row. */
export const ARRANGE_ROW_FROM = 100
const SELBAR_EDGE = 8

/** The centre (left, with the bar's translateX(-50%)) that keeps a bar `halfWidth` wide inside `vw`. Pure. */
export function selectionBarLeft(cx: number, halfWidth: number, vw: number): number {
  if (halfWidth * 2 >= vw) return vw / 2
  return Math.max(halfWidth, Math.min(vw - halfWidth, cx))
}

/** A box in the canvas's overlay coordinates (px from its top-left). */
export interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

const overlaps = (a: OverlayRect, b: OverlayRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** Space kept between the selection bar and the style panel it steps aside for (px). */
export const SELBAR_PANEL_GAP = 8

/**
 * K2-7 (UXD-09): where the selection's quick actions (this bar: link, lock, tags, AI…) go. Centred on the
 * selection at `top` (under it, or above it near the bottom), inside the canvas; when that box would cover the
 * style panel (`panel`, at the top right), the bar flips to the left of the panel, or, with no room there,
 * below it. `half` includes the bar's edge margin. Returns the bar's centre x and top. Pure.
 */
export function placeSelectionBar(o: {
  readonly cx: number
  readonly top: number
  readonly half: number
  readonly h: number
  readonly vw: number
  readonly vh: number
  readonly panel: OverlayRect | null
}): { left: number; top: number; side: 'under' | 'left' | 'below' } {
  const left = selectionBarLeft(o.cx, o.half, o.vw)
  const box = (l: number, t: number): OverlayRect => ({ x: l - o.half, y: t, w: o.half * 2, h: o.h })
  const p = o.panel
  if (!p || p.w <= 0 || p.h <= 0 || !overlaps(box(left, o.top), p)) return { left, top: o.top, side: 'under' }
  // to the left of the panel, at the same height, when the bar fits between the canvas edge and the panel
  const leftOf = p.x - SELBAR_PANEL_GAP - o.half
  if (leftOf - o.half >= 0) return { left: Math.min(left, leftOf), top: o.top, side: 'left' }
  // else under the panel, inside the canvas
  const below = Math.min(p.y + p.h + SELBAR_PANEL_GAP, Math.max(0, o.vh - o.h))
  return { left, top: below, side: 'below' }
}

export function BarButton(props: {
  label: string
  testId?: string
  onClick(): void
  children: ReactNode
  pressed?: boolean
  expanded?: boolean
  controls?: string
}) {
  return (
    <button
      type="button"
      className="dr-cux-selbar__btn"
      aria-label={props.label}
      title={props.label}
      data-testid={props.testId}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

const canEdit = (ctx: CanvasFeatureContext) => !ctx.canvas.readOnly()

/** canvas-ux's own selection-bar items. */
export const SELECTION_BAR_ITEMS: readonly SelectionBarItemSpec[] = [
  {
    id: 'canvas-ux.lock',
    order: 20,
    visible: (ctx) => canEdit(ctx),
    component: function LockItem({ ctx }) {
      const locked = useValue('cux-selbar-locked', () => {
        const roots = selectedRoots(ctx.canvas)
        return roots.length > 0 && roots.every((r) => r.locked)
      }, [ctx])
      return (
        <BarButton
          label={locked ? 'Unlock (Ctrl+Shift+L)' : 'Lock (Ctrl+Shift+L)'}
          testId="selection-lock"
          pressed={locked}
          onClick={() => runCommand(ctx, CMD.toggleLock, 'selection-bar')}
        >
          <LockIcon />
        </BarButton>
      )
    },
  },
  {
    id: 'canvas-ux.align',
    order: 100,
    visible: (ctx, selection) => canEdit(ctx) && unitsOf(ctx.canvas, selection).length >= 2,
    component: function AlignItem({ ctx, selection }) {
      const three = unitsOf(ctx.canvas, selection).length >= 3
      const run = (id: string) => runCommand(ctx, id, 'selection-bar')
      return (
        <>
          <BarButton label="Align left" testId="align-left" onClick={() => run(CMD.alignLeft)}>
            <AlignIcons.left />
          </BarButton>
          <BarButton
            label="Align center"
            testId="align-center-horizontal"
            onClick={() => run(CMD.alignCenterH)}
          >
            <AlignIcons.centerH />
          </BarButton>
          <BarButton label="Align right" testId="align-right" onClick={() => run(CMD.alignRight)}>
            <AlignIcons.right />
          </BarButton>
          <BarButton label="Align top" testId="align-top" onClick={() => run(CMD.alignTop)}>
            <AlignIcons.top />
          </BarButton>
          <BarButton
            label="Align middle"
            testId="align-center-vertical"
            onClick={() => run(CMD.alignCenterV)}
          >
            <AlignIcons.centerV />
          </BarButton>
          <BarButton label="Align bottom" testId="align-bottom" onClick={() => run(CMD.alignBottom)}>
            <AlignIcons.bottom />
          </BarButton>
          {three && (
            <>
              <BarButton
                label="Distribute horizontally"
                testId="distribute-horizontal"
                onClick={() => run(CMD.distributeH)}
              >
                <AlignIcons.distH />
              </BarButton>
              <BarButton
                label="Distribute vertically"
                testId="distribute-vertical"
                onClick={() => run(CMD.distributeV)}
              >
                <AlignIcons.distV />
              </BarButton>
            </>
          )}
        </>
      )
    },
  },
]

function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="19" cy="12" r="1.8" fill="currentColor" />
    </svg>
  )
}

/** What the bar draws now: the selection, where, and the items it holds (null: no bar). */
export interface SelectionBarView {
  readonly sel: string
  readonly ids: readonly string[]
  readonly cx: number
  readonly vw: number
  readonly vh: number
  readonly y: number
  readonly items: readonly SelectionBarItemSpec[]
}

/**
 * The bar's view (reactive: read inside `useValue`). Wave K.1 (with K7, follow-up 9): each item's `visible` is
 * evaluated here, inside the selector, so whatever it reads (K7's AI status arriving after an idle moment, a role
 * change) re-renders the bar. It was evaluated only at render: a read-only person who selected before the AI
 * status landed got no AI button until they selected again.
 */
export function selectionBarView(ctx: CanvasFeatureContext): SelectionBarView | null {
  const { canvas } = ctx
  const state = uxState(canvas)
  const ids = canvas.selection
  if (!ids.length || canvas.editingId() !== null) return null
  // the style panel opened from the phone toolbar's Styles button covers the board's lower half
  if (state.stylesOpen.get()) return null
  const g = canvas.gesture()
  if (g !== 'idle' && g !== 'pressing' && g !== 'tool') return null
  const b = canvas.boundsOf(ids)
  if (!b) return null
  const vp = canvas.viewport.screenRect()
  const bottom = canvas.sceneToOverlay({ x: b.x + b.width / 2, y: b.y + b.height })
  const top = canvas.sceneToOverlay({ x: b.x + b.width / 2, y: b.y })
  if (bottom.y < 0 || top.y > vp.height || bottom.x < -200 || bottom.x > vp.width + 200) return null
  const items = ctx.registries
    .sorted(ctx.registries.selectionBar)
    .filter((i) => (i.visible ? i.visible(ctx, ids) : true))
  if (!items.length) return null
  // clear of the board menu and style panel at the top and the toolbar at the bottom
  const safeTop = 60
  const safeBottom = vp.height - 100
  let y = bottom.y + 14
  if (y + 40 > safeBottom) {
    y = top.y - 54
    if (y < safeTop) y = Math.max(safeTop, Math.min(safeBottom - 40, bottom.y - 54))
  }
  return { sel: ids.join(' '), ids, cx: bottom.x, vw: vp.width, vh: vp.height, y, items }
}

export function SelectionBar({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const ref = useRef<HTMLDivElement>(null)
  const view = useValue('cux-selbar', () => selectionBarView(ctx), [ctx])
  const [size, setSize] = useState({ half: 150, h: 38 })
  // K2-7: the style panel's box (it opens for the same selection, at the top right), to step aside for it
  const [panel, setPanel] = useState<OverlayRect | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el?.offsetWidth) return
    const half = Math.ceil(el.offsetWidth / 2) + SELBAR_EDGE
    const h = el.offsetHeight
    if (half !== size.half || h !== size.h) setSize({ half, h })
    const origin = el.offsetParent?.getBoundingClientRect()
    const styles = el.ownerDocument.querySelector(
      '[data-lobby-slot="stylePanel"] [data-testid="style.panel"]',
    )
    const r = styles?.getBoundingClientRect()
    const next =
      origin && r && r.width > 0 && r.height > 0
        ? { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
        : null
    const same =
      next === panel ||
      (!!next &&
        !!panel &&
        next.x === panel.x &&
        next.y === panel.y &&
        next.w === panel.w &&
        next.h === panel.h)
    if (!same) setPanel(next)
  })
  const [moreOpen, setMoreOpen] = useState(false)
  const moreId = useId()
  const sel = view?.sel ?? ''
  useEffect(() => setMoreOpen(false), [sel])
  // W5-42: the bar is one Tab stop (a roving tab index over its own buttons; a popover's are left alone)
  useLayoutEffect(() => rove(ref.current))
  // Alt+F10: the first button takes the keyboard (with a ring, even after a mouse selection)
  const focusTick = useValue(state.selectionBarFocus)
  useEffect(() => {
    if (!focusTick) return
    ref.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ focusVisible: true } as FocusOptions)
  }, [focusTick])
  if (!view) return null
  const { items } = view
  const main = items.filter((i) => i.order < ARRANGE_ROW_FROM)
  const arrange = items.filter((i) => i.order >= ARRANGE_ROW_FROM)
  const under = size.h > 44 ? Math.max(60, Math.min(view.y, view.vh - 100 - size.h)) : view.y
  const { left, top, side } = placeSelectionBar({
    cx: view.cx,
    top: under,
    half: size.half,
    h: size.h,
    vw: view.vw,
    vh: view.vh,
    panel,
  })
  const compact = view.vw < SELBAR_COMPACT_BELOW
  const render = (list: readonly SelectionBarItemSpec[]) =>
    list.map((i) => <i.component key={i.id} ctx={ctx} selection={view.ids} />)
  return (
    <div
      ref={ref}
      className="dr-cux-selbar cux-selbar"
      role="toolbar"
      aria-label="Selection"
      data-testid="selection-bar"
      data-compact={compact ? 'true' : undefined}
      data-side={side}
      style={{ left, top }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          canvas.focus({ preventScroll: true })
          return
        }
        moveInToolbar(e.nativeEvent, ref.current)
      }}
      onFocus={(e) => rove(ref.current, e.target)}
    >
      {render(main)}
      {arrange.length > 0 && !compact && (
        <>
          {main.length > 0 && <span className="dr-cux-selbar__sep" aria-hidden="true" />}
          {render(arrange)}
        </>
      )}
      {arrange.length > 0 && compact && (
        <>
          {main.length > 0 && <span className="dr-cux-selbar__sep" aria-hidden="true" />}
          <BarButton
            label="More: align, distribute and arrange"
            testId="selection-more"
            expanded={moreOpen}
            controls={moreOpen ? moreId : undefined}
            onClick={() => setMoreOpen((o) => !o)}
          >
            <MoreIcon />
          </BarButton>
          {moreOpen && (
            <div id={moreId} className="dr-cux-selbar__more" data-testid="selection-more-row">
              {render(arrange)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
