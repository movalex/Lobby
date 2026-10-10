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
//
// Wave M (M1-3; FTU-2, FTU-11): the bar is placed by lib/overlay-obstacles.ts placePopover, clear of the style
// panel, the bottom toolbar, W2's top-centre stack and the navigation panel, and past the selection's flow '+'
// handles; it registers itself as the 'selection-bar' obstacle. When the full bar fits nowhere it folds to compact,
// and while one of its popovers (More, a style tray) still covers the style panel, the panel steps aside.
import { createContext, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasFeatureContext, SelectionBarItemSpec } from '../../../canvas/api/index.ts'
import {
  OBSTACLE_IDS,
  type Placement,
  type PopoverSide,
  placePopover,
  type Rect,
  registerObstacle,
} from '../../../lib/overlay-obstacles.ts'
import { useValue } from '../../../lib/signals.ts'
import { FeatureBoundary } from '../../FeatureHostCore.tsx'
import { AlignIcons, LockIcon } from '../icons.tsx'
import { unitsOf } from './align.ts'
import { CMD, runCommand, selectedRoots } from './commands.ts'
import { barObstacles, clientRectOf, STYLE_PANEL_SELECTOR, selectionHandlesRect } from './obstacles.ts'
import { uxState } from './state.ts'
import { moveInToolbar, rove } from './toolbar-keys.ts'

/** A11Y2-06: below this canvas width, the arrange row folds into the bar's "More" button. */
export const SELBAR_COMPACT_BELOW = 600
/** Items from this order on form the arrange row. */
export const ARRANGE_ROW_FROM = 100

/** Whether the bar is drawn compact (a narrow canvas, or folded because the full bar fits nowhere): items read it. */
export const SelectionBarCompact = createContext(false)

/** A box in the canvas's overlay coordinates (px from its top-left). */
export interface OverlayRect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * H1 (FTU-1) hysteresis (px): the bar keeps the side it is on while it still fits there with every obstacle this
 * much smaller, so a measure that moves by a few pixels never flips it back and forth.
 */
export const SELBAR_HYSTERESIS = 8
/** Space between the selection (with its flow handles) and the bar (px). */
export const SELBAR_GAP = 14
/** Space kept inside the canvas's edges (px). */
export const SELBAR_MARGIN = 8
/** The canvas's top band the bar never enters: the board menu and the top bar's chips (px). */
export const SELBAR_SAFE_TOP = 60

export type SelectionBarSide = PopoverSide

/** Where the bar is drawn: its centre x (it is drawn translateX(-50%)), its top, the side it chose, whether it fit. */
export interface SelectionBarPlacement {
  readonly left: number
  readonly top: number
  readonly side: SelectionBarSide
  /** the whole bar is inside the canvas and clear of every obstacle (lib/overlay-obstacles.ts placePopover) */
  readonly fits: boolean
}

/** How far the selection's flow '+' handles reach past its box on each side (px, 0 or more). */
export interface HandlesReach {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

const toRect = (r: OverlayRect): Rect => ({ x: r.x, y: r.y, width: r.w, height: r.h })
const grow = (a: OverlayRect, by: HandlesReach): OverlayRect => ({
  x: a.x - by.left,
  y: a.y - by.top,
  w: a.w + by.left + by.right,
  h: a.h + by.top + by.bottom,
})
const shrink = (r: OverlayRect, by: number): OverlayRect | null =>
  r.w > by * 2 && r.h > by * 2 ? { x: r.x + by, y: r.y + by, w: r.w - by * 2, h: r.h - by * 2 } : null

/**
 * K2-7 / wave M (M1-3; FTU-2, FTU-11): where the selection's quick actions go. Under the selection, centred, else
 * above it, else beside it, slid along a side to keep clear of the board's chrome (`obstacles`: the style panel,
 * the bottom toolbar, W2's top-centre stack, the navigation panel), all in overlay pixels; lib/overlay-obstacles.ts
 * placePopover decides. The selection's flow '+' handles (`reach`) count as part of the selection, so the bar
 * goes past them. A selection taller than the canvas gets the bar inside it, near its bottom.
 *
 * H1 (FTU-1): pure and idempotent. `prev` is the placement drawn last for the same selection: the bar keeps its
 * side while it still fits there with every obstacle SELBAR_HYSTERESIS smaller, and feeding a result back as `prev`
 * returns that same result.
 */
export function placeSelectionBar(o: {
  /** the selection's box */
  readonly anchor: OverlayRect
  /** the bar's size */
  readonly w: number
  readonly h: number
  /** the canvas's size */
  readonly vw: number
  readonly vh: number
  readonly obstacles: readonly OverlayRect[]
  /** how far the selection's flow '+' handles reach past it, if they are shown */
  readonly reach?: HandlesReach | null
  readonly prev?: SelectionBarPlacement | null
}): SelectionBarPlacement {
  let a = o.reach ? grow(o.anchor, o.reach) : o.anchor
  // inside the canvas sideways; when neither above nor below has room (a selection taller than the canvas), the
  // part of it on screen, kept a bar's height from the band's edges
  const top = SELBAR_SAFE_TOP
  const bottom = o.vh - SELBAR_MARGIN
  const x0 = Math.min(Math.max(a.x, 0), o.vw)
  const x1 = Math.max(x0, Math.min(a.x + a.w, o.vw))
  a = { ...a, x: x0, w: x1 - x0 }
  const lo = top + o.h + SELBAR_GAP
  const hi = bottom - o.h - SELBAR_GAP
  if (a.y < lo && a.y + a.h > hi) {
    const y1 = Math.max(lo, hi)
    const y0 = Math.min(Math.max(a.y, lo), y1)
    a = { ...a, y: y0, h: y1 - y0 }
  }
  /**
   * placePopover with every obstacle `slack` px bigger (smaller when negative) than the chrome with SELBAR_MARGIN
   * round it, and the canvas's margin `slack` px bigger: the bar keeps SELBAR_MARGIN clear of the chrome.
   */
  const place = (slack: number, prefer: readonly PopoverSide[]) => {
    const by = SELBAR_MARGIN + slack
    return placePopover({
      anchor: toRect(a),
      size: { width: o.w, height: o.h },
      viewport: { x: 0, y: top - SELBAR_MARGIN, width: o.vw, height: o.vh - top + SELBAR_MARGIN },
      obstacles: o.obstacles
        .map((r) => (by >= 0 ? grow(r, { left: by, top: by, right: by, bottom: by }) : shrink(r, -by)))
        .filter((r): r is OverlayRect => r !== null)
        .map(toRect),
      prefer,
      gap: SELBAR_GAP,
      margin: Math.max(0, SELBAR_MARGIN + slack),
      // the bar never scrolls: every place is judged at its whole height
      minHeight: o.h,
    })
  }
  const at = (p: Placement): SelectionBarPlacement => ({
    left: p.x + o.w / 2,
    top: p.y,
    side: p.side,
    fits: p.fits,
  })
  const ORDER: readonly PopoverSide[] = ['below', 'above']
  const natural = place(0, ORDER)
  const was = o.prev?.side
  if (!was || was === natural.side) return at(natural)
  // Hysteresis. Back to a side it prefers (below over above over right over left) only once that side fits with the
  // chrome HYSTERESIS px bigger; off the side it is on only once that side no longer fits with the chrome
  // HYSTERESIS px smaller.
  if (SIDE_RANK.indexOf(natural.side) < SIDE_RANK.indexOf(was)) {
    const clearly = place(SELBAR_HYSTERESIS, ORDER)
    if (clearly.side === natural.side && clearly.fits) return at(natural)
  }
  const kept = place(-SELBAR_HYSTERESIS, [was, ...ORDER])
  return kept.side === was && kept.fits ? at(kept) : at(natural)
}

/** The sides in the order the bar prefers them (placePopover's default order after below and above). */
const SIDE_RANK: readonly PopoverSide[] = ['below', 'above', 'right', 'left']

/**
 * What the bar's layout effect measures: its size, the chrome it keeps clear of (fixed on screen, so a pan changes
 * none of it), the style panel's box among them, and how far the selection's flow handles reach past it.
 */
export interface SelectionBarMeasure {
  readonly w: number
  readonly h: number
  readonly obstacles: readonly OverlayRect[]
  readonly panel: OverlayRect | null
  readonly reach: HandlesReach | null
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
/** M1-3: a new selection is measured again this long after it is drawn (chrome that opens with it, drawn later). */
export const SELBAR_SETTLE_MS = 250

export const SELBAR_INITIAL_LAYOUT: SelectionBarLayout = {
  key: '',
  passes: 0,
  at: Number.NEGATIVE_INFINITY,
  m: { w: 284, h: 38, obstacles: [], panel: null, reach: null },
}

const sameRect = (a: OverlayRect | null, b: OverlayRect | null) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
const sameRects = (a: readonly OverlayRect[], b: readonly OverlayRect[]) =>
  a.length === b.length && a.every((r, i) => sameRect(r, b[i] ?? null))
const sameReach = (a: HandlesReach | null, b: HandlesReach | null) =>
  a === b ||
  (!!a && !!b && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom)

/** A box grown out to a 4 px grid: it always holds the real box, and sub-pixel moves are no change. */
export function roundOutRect(r: OverlayRect | null): OverlayRect | null {
  if (!r || !(r.w > 0) || !(r.h > 0)) return null
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
  if (
    prev.m.w === m.w &&
    prev.m.h === m.h &&
    sameRects(prev.m.obstacles, m.obstacles) &&
    sameRect(prev.m.panel, m.panel) &&
    sameReach(prev.m.reach, m.reach)
  )
    return prev
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
  /** the selection's box (overlay px) */
  readonly anchor: OverlayRect
  readonly vw: number
  readonly vh: number
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
  const tl = canvas.sceneToOverlay({ x: b.x, y: b.y })
  const br = canvas.sceneToOverlay({ x: b.x + b.width, y: b.y + b.height })
  const cx = (tl.x + br.x) / 2
  if (br.y < 0 || tl.y > vp.height || cx < -200 || cx > vp.width + 200) return null
  const items = ctx.registries
    .sorted(ctx.registries.selectionBar)
    .filter((i) => (i.visible ? i.visible(ctx, ids) : true))
  if (!items.length) return null
  const anchor = {
    x: Math.min(tl.x, br.x),
    y: Math.min(tl.y, br.y),
    w: Math.abs(br.x - tl.x),
    h: Math.abs(br.y - tl.y),
  }
  return { sel: ids.join(' '), ids, anchor, vw: vp.width, vh: vp.height, items }
}

const intersects = (a: OverlayRect, b: OverlayRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

/** The bar's measure now (its layout effect): its size, the chrome in overlay px, the handles' reach. */
function measureBar(el: HTMLElement, view: SelectionBarView): SelectionBarMeasure {
  const doc = el.ownerDocument
  const origin = el.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 }
  const toOverlay = (r: Rect) =>
    roundOutRect({ x: r.x - origin.left, y: r.y - origin.top, w: r.width, h: r.height })
  const obstacles = barObstacles(doc)
    .map(toOverlay)
    .filter((r): r is OverlayRect => r !== null)
  const panel = toOverlay(
    clientRectOf(doc.querySelector(STYLE_PANEL_SELECTOR)) ?? { x: 0, y: 0, width: 0, height: 0 },
  )
  const a = view.anchor
  const box = { x: a.x + origin.left, y: a.y + origin.top, width: a.w, height: a.h }
  const handles = selectionHandlesRect(doc, view.ids, box)
  const reach = handles
    ? {
        left: Math.max(0, Math.ceil(box.x - handles.x)),
        top: Math.max(0, Math.ceil(box.y - handles.y)),
        right: Math.max(0, Math.ceil(handles.x + handles.width - (box.x + box.width))),
        bottom: Math.max(0, Math.ceil(handles.y + handles.height - (box.y + box.height))),
      }
    : null
  return { w: el.offsetWidth, h: el.offsetHeight, obstacles, panel, reach }
}

export function SelectionBar({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const ref = useRef<HTMLDivElement>(null)
  const view = useValue('cux-selbar', () => selectionBarView(ctx), [ctx])
  const [moreOpen, setMoreOpen] = useState(false)
  const tray = useValue(state.selectionTray)
  const moreId = useId()
  const sel = view?.sel ?? ''
  useEffect(() => {
    setMoreOpen(false)
    state.selectionTray.set(null)
  }, [sel, state])
  // M1-3: the bar is chrome other popovers keep clear of (W4's flow and AI popovers read it)
  useEffect(() => registerObstacle(OBSTACLE_IDS.selectionBar, 'bar', () => clientRectOf(ref.current)), [])
  // The bar's size and the chrome it keeps clear of (K2-7, M1-3). H1 (FTU-1): measured only when what is drawn
  // changed (the view, More, a style tray, the items, its own last measure), and at most SELBAR_MAX_PASSES changes
  // per selection: on a phone the measure moved the bar and the move changed the measure, until React's
  // update-depth guard blanked the board.
  const [layout, setLayout] = useState(SELBAR_INITIAL_LAYOUT)
  const itemsKey = view ? view.items.map((i) => i.id).join(',') : ''
  // M1-3: the chrome that opens for the same selection (the style panel, the flow handles) may draw after the bar:
  // measured again on the next frame and once more a moment later (SELBAR_SETTLE_MS), each a fresh key, so at most
  // SELBAR_MAX_PASSES changes each and a bounded number per selection
  const [settle, setSettle] = useState(0)
  useEffect(() => {
    if (!sel) return
    const frame = requestAnimationFrame(() => setSettle((n) => n + 1))
    const later = setTimeout(() => setSettle((n) => n + 1), SELBAR_SETTLE_MS)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(later)
    }
  }, [sel])
  useLayoutEffect(() => {
    const el = ref.current
    if (!view || !el?.offsetWidth) return
    const m = measureBar(el, view)
    const key = `${view.sel}|${view.vw}x${view.vh}|${moreOpen ? 1 : 0}|${tray ?? ''}|${itemsKey}|${settle}`
    const next = foldSelectionBarMeasure(layout, key, m, performance.now())
    if (next !== layout) setLayout(next)
  }, [view, moreOpen, tray, itemsKey, layout, settle])
  // the placement drawn last for this selection (placeSelectionBar's hysteresis keeps its side); recorded after
  // the commit, a ref only (no state)
  const placed = useRef<{ sel: string; at: SelectionBarPlacement } | null>(null)
  const placement = view
    ? placeSelectionBar({
        anchor: view.anchor,
        w: layout.m.w,
        h: layout.m.h,
        vw: view.vw,
        vh: view.vh,
        obstacles: layout.m.obstacles,
        reach: layout.m.reach,
        prev: placed.current?.sel === view.sel ? placed.current.at : null,
      })
    : null
  useLayoutEffect(() => {
    placed.current = view && placement ? { sel: view.sel, at: placement } : null
  })
  // M1-3: when the full bar fits nowhere clear of the chrome, it folds to compact for this selection and canvas size
  // (sticky: a folded bar that would fit unfolded stays folded, so the fold never flips back and forth)
  const fitKey = view ? `${view.sel}|${view.vw}x${view.vh}` : ''
  const [foldedFor, setFoldedFor] = useState<string | null>(null)
  const compact = !!view && (view.vw < SELBAR_COMPACT_BELOW || foldedFor === fitKey)
  const fits = placement?.fits ?? true
  useLayoutEffect(() => {
    if (view && !fits && !compact) setFoldedFor(fitKey)
  }, [view, fits, compact, fitKey])
  // M1-3: a popover of the bar (More, a style tray) that still covers the style panel: the panel steps aside
  // until the popover closes or the selection changes (sticky for the same reason)
  const popoverOpen = moreOpen || tray !== null
  const panel = layout.m.panel
  const coversPanel =
    !!placement &&
    !!panel &&
    intersects({ x: placement.left - layout.m.w / 2, y: placement.top, w: layout.m.w, h: layout.m.h }, panel)
  useLayoutEffect(() => {
    if (popoverOpen && !fits && coversPanel && !state.stylePanelYield.get()) state.stylePanelYield.set(true)
  }, [popoverOpen, fits, coversPanel, state])
  useEffect(() => {
    void sel
    if (!popoverOpen) state.stylePanelYield.set(false)
  }, [popoverOpen, sel, state])
  useEffect(() => () => state.stylePanelYield.set(false), [state])
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
      data-fits={fits ? undefined : 'false'}
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
      <SelectionBarCompact.Provider value={compact}>
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
      </SelectionBarCompact.Provider>
    </div>
  )
}
