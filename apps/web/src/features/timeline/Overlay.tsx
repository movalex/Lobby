// OWNER: WS5 (wave T). The timeline on the board page: for each timeline frame, an SVG over it (a `scene` overlay layer,
// never an element: the ruler, today marker, lanes and bars are what the cards' `card:start` and `card:due` say, so
// there is nothing stored to keep in sync and nothing a receiving client writes). The layer takes no clicks; each bar
// is a focusable, pointer-active group.
//
//  - drag a bar to move both dates, an edge to change one, a milestone to move its due date; the preview follows the
//    pointer and ONE transaction (one undo step) writes the changed keys when the pointer is released;
//  - click a bar: WS4's card popover (`openCardPopover`); double-click: zoom to the card;
//  - a focused bar takes ←/→ (one unit) and Shift+←/→ (its end edge) here only: the keys are handled on the bar, the
//    board's key allowlist never sees them;
//  - read-only roles, a locked card and a room that does not take planning keys (`planningOffered`) get no drag.
import type { TimelineValue } from '@draftroom/canvas-schema/planning'
import { type KeyboardEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { useValue } from '../../lib/signals.ts'
import { openCardPopover, planningOffered, planningShown, timelinesOn } from '../planning/index.ts'
import { TimelineControls } from './Controls.tsx'
import { timelineCards } from './cards.ts'
import { shortDate, todayOf } from './dates.ts'
import { type Dates, type DragMode, datePatch, nudgeDates, pointerDates, sameDates } from './drag.ts'
import { type Bar, barBox, barDescription, type Layout, layoutTimeline, type TimelineCard } from './layout.ts'
import { setMemberNames } from './names.ts'
import { barPrims, DARK, framePrims, LIGHT, type Palette, type Prim } from './paint.ts'
import './timeline.css'

const UI_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
/** a press that moves less than this many screen pixels is a click */
const CLICK_SLOP_PX = 4
/** the edge grips of a bar, in screen pixels (at most a third of the bar) */
const EDGE_PX = 8

function PrimEl({ p }: { p: Prim }) {
  switch (p.t) {
    case 'rect':
      return (
        <rect
          x={p.x}
          y={p.y}
          width={p.w}
          height={p.h}
          rx={p.rx}
          ry={p.rx}
          fill={p.fill}
          fillOpacity={p.fo}
          stroke={p.stroke}
          strokeWidth={p.stroke ? (p.sw ?? 1) : undefined}
          strokeDasharray={p.dash}
        />
      )
    case 'line':
      return (
        <line
          x1={p.x1}
          y1={p.y1}
          x2={p.x2}
          y2={p.y2}
          stroke={p.stroke}
          strokeWidth={p.sw}
          strokeDasharray={p.dash}
        />
      )
    case 'path':
      return (
        <path
          d={p.d}
          fill={p.fill}
          stroke={p.stroke}
          strokeWidth={p.stroke ? (p.sw ?? 1) : undefined}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )
    case 'text':
      return (
        <text
          x={p.x}
          y={p.y}
          fontSize={p.size}
          fontWeight={p.weight}
          fill={p.fill}
          textAnchor={p.anchor === 'middle' ? 'middle' : p.anchor === 'end' ? 'end' : undefined}
        >
          {p.s}
        </text>
      )
  }
}

function Prims({ prims }: { prims: readonly Prim[] }) {
  return (
    <>
      {prims.map((p, i) => (
        <PrimEl key={i} p={p} />
      ))}
    </>
  )
}

/** The assignees' names for the lanes (loaded once for the board when a timeline needs them; null until then). */
function useMemberNames(ctx: CanvasFeatureContext, needed: boolean): ReadonlyMap<string, string> | null {
  const [names, setNames] = useState<ReadonlyMap<string, string> | null>(null)
  useEffect(() => {
    if (!needed) return
    const ac = new AbortController()
    ctx.api
      .listMembers(ctx.board.id, ac.signal)
      .then((members) => {
        const map = new Map(members.map((m) => [m.user.id, m.user.name]))
        setMemberNames(ctx.canvas, map)
        setNames(map)
      })
      .catch(() => {})
    return () => ac.abort()
  }, [ctx.api, ctx.canvas, ctx.board.id, needed])
  return names
}

interface Gesture {
  readonly id: string
  readonly mode: DragMode
  readonly pointerId: number
  readonly grabX: number
  readonly startClient: { x: number; y: number }
  readonly orig: Dates
  readonly editable: boolean
  moved: boolean
}

export function TimelineLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const shown = planningShown('timeline')
  const timelines = useValue('timeline.frames', () => (shown ? timelinesOn(canvas) : []), [canvas, shown])
  const lanesByAssignee = timelines.some((t) => t.value.lanes === 'assignee')
  const names = useMemberNames(ctx, lanesByAssignee)
  if (!timelines.length) return null
  return (
    <>
      {timelines.map((t) => (
        <TimelineView key={t.el.id} ctx={ctx} frameId={t.el.id} names={names} />
      ))}
    </>
  )
}

function TimelineView({
  ctx,
  frameId,
  names,
}: {
  ctx: CanvasFeatureContext
  frameId: string
  names: ReadonlyMap<string, string> | null
}) {
  const { canvas } = ctx
  const dark = useValue('timeline.theme', () => canvas.theme() === 'dark', [canvas])
  const palette: Palette = dark ? DARK : LIGHT
  const today = todayOf()

  // what the frame says (its value and size); the layout does not depend on the camera
  const frame = useValue(
    'timeline.frame',
    () => {
      const found = timelinesOn(canvas).find((f) => f.el.id === frameId)
      return found
        ? { value: found.value, w: found.el.width, h: found.el.height, name: frameName(found.el) }
        : null
    },
    [canvas, frameId],
    // (the selector returns a fresh object on every change of the scene: compare by content below)
  )
  const valueKey = frame ? JSON.stringify(frame.value) : ''
  const cards = useValue('timeline.cards', () => timelineCards(canvas), [canvas])
  const layout = useMemo<Layout | null>(
    () =>
      frame
        ? layoutTimeline({ t: frame.value, size: { width: frame.w, height: frame.h }, cards, today, names })
        : null,
    [valueKey, frame?.w, frame?.h, cards, today, names],
  )

  // where the frame is on screen (the camera moves it; the layout does not)
  const place = useValue('timeline.place', () => {
    const f = canvas.get(frameId)
    if (!f) return null
    const vp = canvas.viewport.get()
    const o = canvas.sceneToOverlay({ x: f.x, y: f.y })
    return { x: o.x, y: o.y, zoom: vp.zoom }
  }, [canvas, frameId])
  const selected = useValue(
    'timeline.selected',
    () => canvas.selection.length === 1 && canvas.selection[0] === frameId,
    [canvas, frameId],
  )
  const offered = useValue('timeline.offered', () => planningOffered('timeline', canvas), [canvas])

  const svgRef = useRef<SVGSVGElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const [preview, setPreview] = useState<{ id: string; dates: Dates } | null>(null)
  const setPreviewIf = (next: { id: string; dates: Dates } | null) =>
    setPreview((cur) =>
      cur === next || (cur && next && cur.id === next.id && sameDates(cur.dates, next.dates)) ? cur : next,
    )

  if (!frame || !layout || !place) return null
  const { zoom } = place

  /** the pointer's x in the frame's own units */
  const frameX = (clientX: number): number => {
    const r = svgRef.current?.getBoundingClientRect()
    return r && r.width > 0 ? ((clientX - r.left) / r.width) * layout.width : 0
  }

  const editableBar = (bar: Bar): boolean =>
    offered && !canvas.readOnly() && !canvas.isLocked(bar.id) && !bar.card.locked

  const datesOf = (bar: Bar): Dates => ({
    start: bar.kind === 'milestone' ? null : bar.card.start,
    due: bar.card.due as string,
  })

  const commit = (bar: Bar, to: Dates): void => {
    const from = datesOf(bar)
    const patch = datePatch(from, to)
    if (!Object.keys(patch).length) return
    try {
      // one transaction: one undo step; only this tab writes (a receiving client only redraws)
      canvas.transact('Change card dates', (tx) => tx.update(bar.id, { customData: { lobby: patch } }))
    } catch {
      ctx.notify({ key: 'timeline:dates', tone: 'error', text: "Couldn't change the dates. Try again." })
    }
  }

  const open = (bar: Bar, el: Element | null): void => {
    const r = el?.getBoundingClientRect()
    const anchor = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : undefined
    if (openCardPopover(ctx, { id: bar.id, ...(anchor ? { anchor } : {}) })) return
    // no popover registered (WS4 not on): select the card and bring it into view
    canvas.select([bar.id])
    canvas.viewport.ensureVisible([bar.id], { animate: true })
  }

  const showCard = (bar: Bar): void => {
    const b = canvas.bounds(bar.id)
    canvas.select([bar.id])
    if (b) canvas.viewport.zoomTo(b, { animate: true, maxZoom: 1.5 })
  }

  const zoneOf = (bar: Bar, e: PointerEvent): DragMode => {
    if (bar.kind === 'milestone') return 'move'
    const r = (e.currentTarget as Element).getBoundingClientRect()
    const edge = Math.min(EDGE_PX, r.width / 3)
    if (e.clientX - r.left <= edge) return 'start'
    if (r.right - e.clientX <= edge) return 'end'
    return 'move'
  }

  const onDown = (bar: Bar, e: PointerEvent<SVGGElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const editable = editableBar(bar)
    gesture.current = {
      id: bar.id,
      mode: zoneOf(bar, e),
      pointerId: e.pointerId,
      grabX: frameX(e.clientX),
      startClient: { x: e.clientX, y: e.clientY },
      orig: datesOf(bar),
      editable,
      moved: false,
    }
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    e.currentTarget.focus({ preventScroll: true })
  }

  const onMove = (bar: Bar, e: PointerEvent<SVGGElement>): void => {
    const g = gesture.current
    if (!g || g.id !== bar.id || g.pointerId !== e.pointerId) {
      if (!g && editableBar(bar))
        (e.currentTarget as SVGGElement).style.cursor = zoneOf(bar, e) === 'move' ? 'grab' : 'ew-resize'
      return
    }
    if (!g.moved && Math.hypot(e.clientX - g.startClient.x, e.clientY - g.startClient.y) < CLICK_SLOP_PX)
      return
    g.moved = true
    if (!g.editable || !frame) return
    const next = pointerDates({
      t: frame.value,
      axis: layout.axis,
      orig: g.orig,
      mode: g.mode,
      grabX: g.grabX,
      curX: frameX(e.clientX),
    })
    setPreviewIf(sameDates(next, g.orig) ? null : { id: bar.id, dates: next })
  }

  const end = (bar: Bar, e: PointerEvent<SVGGElement>, cancel: boolean): void => {
    const g = gesture.current
    if (!g || g.id !== bar.id || g.pointerId !== e.pointerId) return
    gesture.current = null
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    const dates = preview?.id === bar.id ? preview.dates : null
    setPreviewIf(null)
    if (cancel) return
    if (!g.moved) {
      open(bar, e.currentTarget)
      return
    }
    if (dates && g.editable) commit(bar, dates)
  }

  const onKey = (bar: Bar, e: KeyboardEvent<SVGGElement>): void => {
    if (e.key === 'Escape' && gesture.current?.id === bar.id) {
      gesture.current = null
      setPreviewIf(null)
      e.stopPropagation()
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      open(bar, e.currentTarget)
      return
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      if (!editableBar(bar)) return
      const next = nudgeDates(
        frame.value,
        datesOf(bar),
        e.shiftKey ? 'end' : 'move',
        e.key === 'ArrowLeft' ? -1 : 1,
      )
      commit(bar, next)
    }
  }

  const who = (bar: Bar): string | null =>
    bar.card.who === null
      ? null
      : names
        ? (names.get(bar.card.who) ?? 'someone no longer on this board')
        : null

  return (
    <>
      group)
      <svg
        ref={svgRef}
        className="dr-tl"
        data-testid="timeline"
        data-frame-id={frameId}
        data-scale={frame.value.scale}
        data-lanes={frame.value.lanes}
        data-bars={layout.shown}
        aria-label={`Timeline ${frame.name}: ${layout.shown} card${layout.shown === 1 ? '' : 's'}`}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        style={{
          left: place.x,
          top: place.y,
          width: layout.width * zoom,
          height: layout.height * zoom,
          fontFamily: UI_FONT,
        }}
      >
        <g data-testid="timeline-frame">
          <Prims prims={framePrims(layout, palette)} />
        </g>
        {layout.bars.map((bar) => {
          const dates = preview?.id === bar.id ? preview.dates : null
          const box = dates ? barBox(frame.value, layout.axis, dates.start, dates.due) : bar
          const live: Bar = dates ? { ...bar, x: box.x, w: box.w } : bar
          const editable = editableBar(bar)
          const head = dates
            ? `${dates.start ? `${shortDate(dates.start)} to ` : ''}${shortDate(dates.due)}`
            : null
          return (
            // biome-ignore lint/a11y/useSemanticElements: a bar of a drawing is a focusable SVG group (a <button> cannot hold SVG shapes)
            <g
              key={bar.id}
              className="dr-tl-bar"
              data-testid="timeline-bar"
              data-card-id={bar.id}
              data-kind={bar.kind}
              data-status={bar.card.status}
              data-start={bar.card.start ?? ''}
              data-due={bar.card.due ?? ''}
              data-editable={editable || undefined}
              data-dragging={dates ? '' : undefined}
              role="button"
              tabIndex={0}
              aria-label={barDescription(bar, who(bar))}
              onPointerDown={(e) => onDown(bar, e)}
              onPointerMove={(e) => onMove(bar, e)}
              onPointerUp={(e) => end(bar, e, false)}
              onPointerCancel={(e) => end(bar, e, true)}
              onLostPointerCapture={() => {
                if (gesture.current?.id === bar.id) {
                  gesture.current = null
                  setPreviewIf(null)
                }
              }}
              onKeyDown={(e) => onKey(bar, e)}
              onDoubleClick={() => showCard(bar)}
            >
              <title>{barDescription(bar, who(bar))}</title>
              <rect
                className="dr-tl-hit"
                x={live.x - 2}
                y={bar.y - 2}
                width={live.w + 4}
                height={bar.h + 4}
                rx={6}
                fill="transparent"
              />
              <Prims prims={barPrims(bar, palette, live)} />
              <rect
                className="dr-tl-focus"
                x={live.x - 3}
                y={bar.y - 3}
                width={live.w + 6}
                height={bar.h + 6}
                rx={7}
                fill="none"
                stroke={palette.today}
                strokeWidth={2}
              />
              {head ? (
                <text
                  className="dr-tl-tip"
                  x={live.x}
                  y={bar.y - 6}
                  fontSize={11}
                  fontWeight={700}
                  fill={palette.ink}
                >
                  {head}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      {selected && offered ? (
        <TimelineControls
          ctx={ctx}
          frameId={frameId}
          value={frame.value}
          at={{ x: place.x, y: place.y + layout.height * zoom + 8 }}
        />
      ) : null}
    </>
  )
}

const frameName = (el: object): string => ((el as { name?: string | null }).name ?? '').trim() || 'timeline'

export type { TimelineCard, TimelineValue }
