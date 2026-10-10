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
import { FeatureBoundary } from '../../FeatureHostCore.tsx'
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

/** Space kept between the selection bar and the style panel it steps aside for (px). */
export const SELBAR_PANEL_GAP = 8

/**
 * H1 (FTU-1) hysteresis (px): the bar keeps the side it is on until its overlap with the style panel (or its room
 * left of it) changes by more than this, so a measure that moves by a few pixels never flips it back and forth.
 */
export const SELBAR_HYSTERESIS = 8

export type SelectionBarSide = 'under' | 'left' | 'below'

/** Where the bar is drawn: its centre x (it is drawn translateX(-50%)), its top, and the side it chose. */
export interface SelectionBarPlacement {
  readonly left: number
  readonly top: number
  readonly side: SelectionBarSide
}

/** How far apart two boxes are (px); negative when they overlap (then: how deep, along the shallower axis). */
function separation(a: OverlayRect, b: OverlayRect): number {
  const sx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
  const sy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))
  return Math.max(sx, sy)
}

/**
 * K2-7 (UXD-09): where the selection's quick actions (this bar: link, lock, tags, AI…) go. Centred on the
 * selection at `top` (under it, or above it near the bottom), inside the canvas; when that box would cover the
 * style panel (`panel`, at the top right), the bar flips to the left of the panel, or, with no room there,
 * below it. `half` includes the bar's edge margin. Returns the bar's centre x and top.
 *
 * H1 (FTU-1): pure and idempotent. `prev` is the placement drawn last for the same selection: the bar keeps its
 * side unless the overlap (or the room left of the panel) changed by more than SELBAR_HYSTERESIS, and feeding a
 * result back as `prev` returns that same result.
 */
export function placeSelectionBar(o: {
  readonly cx: number
  readonly top: number
  readonly half: number
  readonly h: number
  readonly vw: number
  readonly vh: number
  readonly panel: OverlayRect | null
  readonly prev?: SelectionBarPlacement | null
}): SelectionBarPlacement {
  const left = selectionBarLeft(o.cx, o.half, o.vw)
  const box = (l: number, t: number): OverlayRect => ({ x: l - o.half, y: t, w: o.half * 2, h: o.h })
  const p = o.panel
  const was = o.prev?.side ?? null
  if (!p || p.w <= 0 || p.h <= 0) return { left, top: o.top, side: 'under' }
  // under the selection while clear of the panel (already under: until it covers it by more than the hysteresis;
  // stepped aside: until it is clear of it by more than that)
  const d = separation(box(left, o.top), p)
  const under = was === null ? d >= 0 : was === 'under' ? d >= -SELBAR_HYSTERESIS : d > SELBAR_HYSTERESIS
  if (under) return { left, top: o.top, side: 'under' }
  // to the left of the panel, at the same height, when the bar fits between the canvas edge and the panel
  const leftOf = p.x - SELBAR_PANEL_GAP - o.half
  const room = leftOf - o.half
  const fits =
    was === 'left' ? room >= -SELBAR_HYSTERESIS : was === 'below' ? room > SELBAR_HYSTERESIS : room >= 0
  if (fits) return { left: Math.min(left, leftOf), top: o.top, side: 'left' }
  // else under the panel, inside the canvas
  const below = Math.min(p.y + p.h + SELBAR_PANEL_GAP, Math.max(0, o.vh - o.h))
  return { left, top: below, side: 'below' }
}

/** What the bar's layout effect measures: its half width (with the edge margin), its height, the style panel. */
export interface SelectionBarMeasure {
  readonly half: number
  readonly h: number
  readonly panel: OverlayRect | null
}

/** The measure the bar is drawn with, and how many times it changed in the current burst for `key`. */
export interface SelectionBarLayout {
  readonly key: string
  readonly passes: number
  /** when the burst's first pass ran (ms) */
  readonly at: number
  readonly m: SelectionBarMeasure
}

/**
 * H1 (FTU-1): at most this many measure changes per selection (per burst). A third one keeps what is drawn and
 * stops, so a measure that the placement itself changes can never loop (React's update-depth guard blanked the
 * board on a phone).
 */
export const SELBAR_MAX_PASSES = 2
/** One burst: the passes for one key that run closer together than this (a loop runs them within one task). */
export const SELBAR_PASS_WINDOW_MS = 500

export const SELBAR_INITIAL_LAYOUT: SelectionBarLayout = {
  key: '',
  passes: 0,
  at: Number.NEGATIVE_INFINITY,
  m: { half: 150, h: 38, panel: null },
}

const sameRect = (a: OverlayRect | null, b: OverlayRect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)

/** The style panel's box grown out to a 4 px grid: it always holds the real box, and sub-pixel moves are no change. */
export function roundPanelRect(r: OverlayRect | null): OverlayRect | null {
  if (!r || r.w <= 0 || r.h <= 0) return null
  const x = Math.floor(r.x / 4) * 4
  const y = Math.floor(r.y / 4) * 4
  return { x, y, w: Math.ceil((r.x + r.w) / 4) * 4 - x, h: Math.ceil((r.y + r.h) / 4) * 4 - y }
}

/**
 * One pass of the bar's layout effect (pure): the next layout state, or `prev` itself when nothing is to change
 * (the same measure, or the pass cap reached), so the effect sets no state and React renders nothing more.
 */
export function foldSelectionBarMeasure(
  prev: SelectionBarLayout,
  key: string,
  m: SelectionBarMeasure,
  now: number,
): SelectionBarLayout {
  if (prev.m.half === m.half && prev.m.h === m.h && sameRect(prev.m.panel, m.panel)) return prev
  const fresh = prev.key !== key || now - prev.at > SELBAR_PASS_WINDOW_MS
  const passes = fresh ? 0 : prev.passes
  if (passes >= SELBAR_MAX_PASSES) return prev
  return { key, passes: passes + 1, at: fresh ? now : prev.at, m }
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
  const [moreOpen, setMoreOpen] = useState(false)
  const moreId = useId()
  const sel = view?.sel ?? ''
  useEffect(() => setMoreOpen(false), [sel])
  // The bar's size and the style panel's box (K2-7: the panel opens for the same selection, at the top right, and
  // the bar steps aside for it). H1 (FTU-1): measured only when what is drawn changed (the view, More, the items,
  // its own last measure), and at most SELBAR_MAX_PASSES changes per selection: on a phone the measure moved the
  // bar and the move changed the measure, until React's update-depth guard blanked the board.
  const [layout, setLayout] = useState(SELBAR_INITIAL_LAYOUT)
  const size = layout.m
  const panel = layout.m.panel
  const itemsKey = view ? view.items.map((i) => i.id).join(',') : ''
  useLayoutEffect(() => {
    const el = ref.current
    if (!view || !el?.offsetWidth) return
    const origin = el.offsetParent?.getBoundingClientRect()
    const styles = el.ownerDocument.querySelector(
      '[data-lobby-slot="stylePanel"] [data-testid="style.panel"]',
    )
    const r = styles?.getBoundingClientRect()
    const m: SelectionBarMeasure = {
      half: Math.ceil(el.offsetWidth / 2) + SELBAR_EDGE,
      h: el.offsetHeight,
      panel:
        origin && r
          ? roundPanelRect({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height })
          : null,
    }
    const key = `${view.sel}|${view.vw}x${view.vh}|${moreOpen ? 1 : 0}|${itemsKey}`
    const next = foldSelectionBarMeasure(layout, key, m, performance.now())
    if (next !== layout) setLayout(next)
  }, [view, moreOpen, itemsKey, layout])
  // the placement drawn last for this selection (placeSelectionBar's hysteresis keeps its side); recorded after
  // the commit, a ref only (no state)
  const placed = useRef<{ sel: string; at: SelectionBarPlacement } | null>(null)
  const under = !view ? 0 : size.h > 44 ? Math.max(60, Math.min(view.y, view.vh - 100 - size.h)) : view.y
  const placement = view
    ? placeSelectionBar({
        cx: view.cx,
        top: under,
        half: size.half,
        h: size.h,
        vw: view.vw,
        vh: view.vh,
        panel,
        prev: placed.current?.sel === view.sel ? placed.current.at : null,
      })
    : null
  useLayoutEffect(() => {
    placed.current = view && placement ? { sel: view.sel, at: placement } : null
  })
  // W5-42: the bar is one Tab stop (a roving tab index over its own buttons; a popover's are left alone). It runs
  // after every render on purpose (the buttons come and go with the items) and only writes tabIndex, never state,
  // so it cannot loop (checked for H1).
  useLayoutEffect(() => rove(ref.current))
  // Alt+F10: the first button takes the keyboard (with a ring, even after a mouse selection)
  const focusTick = useValue(state.selectionBarFocus)
  useEffect(() => {
    if (!focusTick) return
    ref.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ focusVisible: true } as FocusOptions)
  }, [focusTick])
  if (!view || !placement) return null
  const { items } = view
  const main = items.filter((i) => i.order < ARRANGE_ROW_FROM)
  const arrange = items.filter((i) => i.order >= ARRANGE_ROW_FROM)
  const { left, top, side } = placement
  const compact = view.vw < SELBAR_COMPACT_BELOW
  const render = (list: readonly SelectionBarItemSpec[]) =>
    list.map((i) => (
      // H1 (M1-2): an item that throws drops out of the bar; the bar and the other items stay
      <FeatureBoundary key={i.id} featureId={`selectionBar:${i.id}`} resetKey={`${ctx.board.id}|${view.sel}`}>
        <i.component ctx={ctx} selection={view.ids} />
      </FeatureBoundary>
    ))
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
