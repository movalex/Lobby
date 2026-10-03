// "Show only #tag" on the new canvas (the port of ../Overlay.tsx's filter). tldraw dimmed every shape
// without the tag with one stylesheet rule on its DOM; Excalidraw paints elements on a canvas, so the port
// lays a veil over the canvas instead: the canvas's own background at 86 % opacity (what the rule's
// opacity 0.14 left of a shape), with a hole over every element carrying the tag (its rectangle, rotated
// with it, and its chips). Everything under the veil still takes clicks (the layer takes no pointer), as
// the dimmed shapes did.
//  - FilterVeil: a `scene` layer (hidden in focus mode: presenting suspends "Show only", as
//    html[data-dr-presenting] did), drawn above the chips so the others' chips fade too;
//  - FilterBar: in the tags `screen` layer: "Showing only #Research · 2 items · Zoom to matches · Show
//    all"; it ends by itself when the tag leaves the board (someone deleted it everywhere). F2-08: "Zoom
//    to matches" fits the camera to the elements carrying the tag (some may be off screen).
// Deviation (docs/research/excalidraw/wave3/3D.md): the veil fades by area, so what overlaps a carrier's
// rectangle shows through its hole, and the other elements fade towards the canvas colour rather than
// becoming translucent over what lies under them.

import { useEffect, useMemo, useRef } from 'react'
import type { CanvasElement, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { computed, useValue } from '../../../lib/signals.ts'
import { plural } from '../copy.ts'
import { FilterIcon } from '../icons.tsx'
import { useIsolated } from '../isolate.ts'
import { tagsOf } from './bridge.ts'
import { type ChipBox, chipBoxes, sameBoxes } from './Chips.tsx'
import { useTagRows } from './hooks.ts'
import { type BoardTagRow, elementTags, isTaggable } from './model.ts'
import type { TagsRuntime } from './runtime.ts'

/** What the veil lets through around a carrier (scene px), and above a shape for its chips. */
const HOLE_PAD = 4
const CHIP_ROW = 24
/** The veil's opacity: tldraw's filter left 0.14 of a shape. */
export const VEIL_OPACITY = 0.86
/** The canvas background under the veil (Excalidraw's white; its dark-mode filter makes it #121212). */
export const VEIL_COLOR = { light: '#ffffff', dark: '#121212' } as const

export interface VeilHole {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  /** rotation in degrees about the hole's centre */
  readonly deg: number
}

/** The veil's holes: every chip box carrying `key`, padded (and raised for chips above a shape). */
export function veilHoles(boxes: readonly ChipBox[], key: string): VeilHole[] {
  const out: VeilHole[] = []
  for (const b of boxes) {
    if (!b.tags.some((t) => t.key === key)) continue
    const top = b.placement === 'above' ? CHIP_ROW : 0
    out.push({
      id: b.id,
      x: b.x - HOLE_PAD,
      y: b.y - HOLE_PAD - top,
      w: b.w + 2 * HOLE_PAD,
      h: b.h + 2 * HOLE_PAD + top,
      deg: (b.angle * 180) / Math.PI,
    })
  }
  return out
}

/** F2-08: the elements "Zoom to matches" brings into view: the visible ones carrying `key`. */
export function matchingIds(
  elements: Iterable<CanvasElement>,
  key: string,
  isHidden: (id: string) => boolean,
): string[] {
  const out: string[] = []
  for (const el of elements) {
    if (!isTaggable(el) || isHidden(el.id)) continue
    if (elementTags(el).some((t) => t.key === key)) out.push(el.id)
  }
  return out
}

/** F2-08: moves the camera to fit the matches of `key`; false when there is nothing visible to go to. */
export function zoomToMatches(rt: TagsRuntime, key: string): boolean {
  const ids = matchingIds(rt.canvas.items(), key, (id) => rt.canvas.isHidden(id))
  if (ids.length === 0) return false
  rt.canvas.viewport.fit(ids, { animate: true })
  return true
}

let veils = 0

export function FilterVeilLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const t = useValue('tags.bridge', () => tagsOf(ctx.canvas), [ctx.canvas])
  const key = useValue('tags.filter', () => t?.rt.filter.get() ?? null, [t])
  return t && key ? <FilterVeil rt={t.rt} filterKey={key} /> : null
}

function FilterVeil({ rt, filterKey }: { rt: TagsRuntime; filterKey: string }) {
  const canvas = rt.canvas
  const boxes = useValue(
    useMemo(
      () =>
        computed(
          'tags.veil-boxes',
          () => chipBoxes(canvas.items(), rt.board.get(), (id) => canvas.isHidden(id)),
          {
            isEqual: sameBoxes,
          },
        ),
      [rt, canvas],
    ),
  )
  const v = useValue('tags.viewport', () => canvas.viewport.get(), [canvas])
  const theme = useValue('tags.theme', () => canvas.theme(), [canvas])
  const maskId = useRef(`dr-tags-veil-${++veils}`).current
  const holes = veilHoles(boxes, filterKey)
  return (
    <svg
      className="dr-tags-veil"
      width="100%"
      height="100%"
      aria-hidden="true"
      data-testid="tag-filter-veil"
      data-tag-key={filterKey}
      data-holes={holes.map((h) => h.id).join(' ')}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <rect x="0" y="0" width="100%" height="100%" fill="white" />
          <g transform={`scale(${v.zoom}) translate(${-v.x} ${-v.y})`}>
            {holes.map((h) => (
              <rect
                key={h.id}
                x={h.x}
                y={h.y}
                width={h.w}
                height={h.h}
                rx={6}
                fill="black"
                transform={h.deg ? `rotate(${h.deg} ${h.x + h.w / 2} ${h.y + h.h / 2})` : undefined}
              />
            ))}
          </g>
        </mask>
      </defs>
      <rect
        x="0"
        y="0"
        width="100%"
        height="100%"
        fill={VEIL_COLOR[theme]}
        fillOpacity={VEIL_OPACITY}
        mask={`url(#${maskId})`}
      />
    </svg>
  )
}

export function FilterBar({ rt }: { rt: TagsRuntime }) {
  const key = useValue('tags.filter', () => rt.filter.get(), [rt])
  return key ? <FilterBarRow rt={rt} filterKey={key} /> : null
}

function FilterBarRow({ rt, filterKey }: { rt: TagsRuntime; filterKey: string }) {
  // Only while a filter is on (the count needs the rows: throttled, see hooks.ts).
  const row = useTagRows(rt).find((r) => r.key === filterKey) ?? null
  // The tag is gone (deleted everywhere, perhaps by someone else): nothing left to show only.
  useEffect(() => {
    if (!row && rt.filter.get() === filterKey) rt.filter.set(null)
  }, [rt, row, filterKey])
  return row ? <FilterBarView rt={rt} row={row} /> : null
}

function FilterBarView({ rt, row }: { rt: TagsRuntime; row: BoardTagRow }) {
  const ref = useIsolated<HTMLDivElement>()
  return (
    <div
      ref={ref}
      className="dr-tags-filterbar"
      role="status"
      data-testid="tag-filter-bar"
      data-tag-key={row.key}
    >
      <span className="dr-tags-filterbar__icon" aria-hidden="true">
        <FilterIcon size={15} />
      </span>
      <span className="dr-tags-filterbar__text">
        {/* On a phone the funnel and the pill say it; screen readers still hear the words. */}
        <span className="dr-tags-filterbar__label">Showing only</span>{' '}
        <span className="dr-tag-pill" data-dr-tag-color={row.color} title={row.name}>
          {row.name}
        </span>
        <span className="dr-tags-filterbar__count"> · {plural(row.count, 'item')}</span>
      </span>
      <button
        type="button"
        className="dr-btn dr-btn--sm dr-tags-filterbar__zoom"
        data-testid="tag-filter-zoom"
        title="Move the view to the items with this tag"
        onClick={() => {
          zoomToMatches(rt, row.key)
          rt.canvas.focus({ preventScroll: true })
        }}
      >
        Zoom to matches
      </button>
      <button
        type="button"
        className="dr-btn dr-btn--sm dr-tags-filterbar__clear"
        data-testid="tag-filter-clear"
        onClick={() => {
          rt.filter.set(null)
          rt.canvas.focus({ preventScroll: true })
        }}
      >
        Show all
      </button>
    </div>
  )
}
