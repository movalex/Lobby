// Tag chips on the new canvas (a `scene` layer of the board page's overlay root; the port of
// ../ShapeWrapper.tsx). tldraw drew the chips inside each shape; Excalidraw draws elements on a canvas, so
// the chips are DOM in one layer over it (docs/EXCALIDRAW-MIGRATION.md §2 `canvas/overlay/`):
//  - one container in scene coordinates, moved and scaled with the camera by ONE transform: a pan or a
//    zoom re-renders nothing but that container, and the chips keep their tldraw size in scene units
//    (16 px high at 100 %, 32 px at 200 %);
//  - one box per tagged element at its scene rectangle, rotated with it; the chips sit in it as they sat
//    in the shape (inside a note, a card or media; above a shape or free text: ../tags.css);
//  - level of detail (full chips, colour dots, nothing) from the zoom, as one attribute on the container;
//  - R2-10: a minimum screen size. Chips keep their tldraw size in scene units from 100 % up, but below it
//    they grow (--dr-tag-scale) so their text stays about 11 px on screen, and from 75 % down a note shows
//    its first tag and "+N" instead of several names; the colour dots keep at least 10 px on screen too;
//  - hidden elements (a collapsed mind-map branch) show no chips.
// Deviation from tldraw (written down in docs/research/excalidraw/wave3/3D.md): the layer is above every
// element, so a note lying on another note no longer covers the chips of the one below; and a remote
// drag's preview moves the note before its chips (they follow on the drop, like the hit test, §2.7).

import { TAG_KEY_PREFIX } from '@draftroom/canvas-schema/custom-data'
import type { TagDef } from '@draftroom/contracts'
import { type CSSProperties, memo, useMemo } from 'react'
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { computed, type Signal, useValue } from '../../../lib/signals.ts'
import { chipLayout, isShortTagName } from '../tag-core.ts'
import '../tags.css'
import './tags.css'
import { tagsOf } from './bridge.ts'
import { TAG_COLOR_CSS } from './colors.ts'
import {
  type ChipPlacement,
  chipPlacement,
  displayTags,
  isTaggable,
  LOD_FULL_ZOOM,
  tagsLodFor,
  tagTokens,
} from './model.ts'
import type { TagsRuntime } from './runtime.ts'

/** One tagged element's chips, as drawn (compared field by field, so a move re-renders one box). */
export interface ChipBox {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly angle: number
  readonly placement: ChipPlacement
  /** the element's tag keys, space-separated (`data-dr-tags`, what "Show only" matches) */
  readonly tokens: string
  readonly tags: readonly TagDef[]
}

/** R2-10: a chip's text never reads smaller than this on screen (px; it is 11 px at 100 % and up). */
export const MIN_CHIP_TEXT_PX = 11
/** R2-10: a colour dot (22 scene px at 100 %) never shows smaller than this on screen (px). */
export const MIN_DOT_PX = 10
/** R2-10: below this zoom a note shows its first tag and "+N", not several names. */
export const CHIP_COMPACT_BELOW = 0.75
const CHIP_TEXT_PX = 11
const DOT_SCENE_PX = 22

/**
 * R2-10: the factor chips and dots are drawn at in scene units (`--dr-tag-scale`): 1 from 100 % up, then
 * large enough that their text (full chips) or the dot itself keeps its minimum size on screen.
 */
export function chipScaleFor(zoom: number): number {
  if (!(zoom > 0)) return 1
  const full = tagsLodFor(zoom) === 'full'
  const needed = full ? MIN_CHIP_TEXT_PX / (CHIP_TEXT_PX * zoom) : MIN_DOT_PX / (DOT_SCENE_PX * zoom)
  return Math.max(1, Math.round(needed * 100) / 100)
}

/** R2-10: whether notes show their first tag and "+N" at this zoom (full chips only; dots show every tag). */
export const chipsCompactAt = (zoom: number): boolean => zoom >= LOD_FULL_ZOOM && zoom < CHIP_COMPACT_BELOW

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

/** The chip boxes of every visible tagged element, in paint order. */
export function chipBoxes(
  elements: Iterable<CanvasElement>,
  board: Parameters<typeof displayTags>[1],
  isHidden: (id: string) => boolean,
): ChipBox[] {
  const out: ChipBox[] = []
  for (const el of elements) {
    if (!isTaggable(el)) continue
    const tokens = tagTokens(el)
    if (!tokens || isHidden(el.id)) continue
    out.push({
      id: el.id,
      x: num(el.x),
      y: num(el.y),
      w: Math.abs(num(el.width)),
      h: Math.abs(num(el.height)),
      angle: num(el.angle),
      placement: chipPlacement(el),
      tokens,
      tags: displayTags(el, board),
    })
  }
  return out
}

const sameTags = (a: readonly TagDef[], b: readonly TagDef[]) =>
  a.length === b.length &&
  a.every((t, i) => {
    const o = b[i]
    return o !== undefined && o.key === t.key && o.name === t.name && o.color === t.color
  })

export const sameBox = (a: ChipBox, b: ChipBox) =>
  a.id === b.id &&
  a.x === b.x &&
  a.y === b.y &&
  a.w === b.w &&
  a.h === b.h &&
  a.angle === b.angle &&
  a.placement === b.placement &&
  a.tokens === b.tokens &&
  sameTags(a.tags, b.tags)

export const sameBoxes = (a: readonly ChipBox[], b: readonly ChipBox[]) =>
  a === b || (a.length === b.length && a.every((x, i) => sameBox(x, b[i] as ChipBox)))

/** The runtime's chip boxes as a signal (stable while nothing a chip shows changed). */
function useChipBoxes(rt: TagsRuntime): Signal<ChipBox[]> {
  return useMemo(
    () =>
      computed(
        'tags.chip-boxes',
        // wave N.1: the elements with a `tag:` key, from the scene index (no walk of the whole scene per change)
        () =>
          chipBoxes(rt.canvas.index.withLobbyKeyPrefix(TAG_KEY_PREFIX), rt.board.get(), (id) =>
            rt.canvas.isHidden(id),
          ),
        { isEqual: sameBoxes },
      ),
    [rt],
  )
}

export function TagChipsLayer({ ctx }: { ctx: CanvasFeatureContext }) {
  const t = useValue('tags.bridge', () => tagsOf(ctx.canvas), [ctx.canvas])
  return (
    <>
      {/* the tag colours for the chips, the panel, the picker and the bar (one stylesheet, both themes) */}
      <style data-testid="tag-colors">{TAG_COLOR_CSS}</style>
      {t ? <ChipScene rt={t.rt} /> : null}
    </>
  )
}

function ChipScene({ rt }: { rt: TagsRuntime }) {
  const boxes = useValue(useChipBoxes(rt))
  return (
    <SceneContainer canvas={rt.canvas} testId="tag-scene" className="dr-tags-scene">
      {boxes.map((b) => (
        <ChipBoxView key={b.id} box={b} />
      ))}
    </SceneContainer>
  )
}

/** A container in scene coordinates: one transform follows the camera; `data-dr-tags-lod` the zoom. */
export function SceneContainer({
  canvas,
  testId,
  className,
  children,
}: {
  canvas: LobbyCanvas
  testId: string
  className: string
  children: React.ReactNode
}) {
  const v = useValue('tags.viewport', () => canvas.viewport.get(), [canvas])
  return (
    <div
      className={className}
      data-testid={testId}
      data-dr-tags-lod={tagsLodFor(v.zoom)}
      data-dr-tags-compact={chipsCompactAt(v.zoom) || undefined}
      style={
        {
          transform: `scale(${v.zoom}) translate(${-v.x}px, ${-v.y}px)`,
          '--dr-tag-scale': chipScaleFor(v.zoom),
        } as CSSProperties
      }
    >
      {children}
    </div>
  )
}

const ChipBoxView = memo(
  function ChipBoxView({ box }: { box: ChipBox }) {
    const { shown, more } = chipLayout(box.tags)
    return (
      <div
        className="dr-tags-box"
        data-testid="tag-box"
        data-element-id={box.id}
        data-dr-tags={box.tokens}
        style={{
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          transform: box.angle ? `rotate(${box.angle}rad)` : undefined,
        }}
      >
        <ul
          className="dr-tag-chips"
          data-kind={box.placement}
          data-testid="tag-chips"
          data-tags={box.tags.map((t) => t.key).join(' ')}
          aria-label={`Tags: ${box.tags.map((t) => t.name).join(', ')}`}
        >
          {box.tags.map((t, i) => (
            <Chip key={t.key} tag={t} overflow={i >= shown.length} />
          ))}
          {more > 0 && (
            <li
              className="dr-tag-chip dr-tag-chip--more"
              data-testid="tag-chip-more"
              data-dr-tag-color="grey"
            >
              +{more}
            </li>
          )}
          {/* R2-10: what a note shows in place of its other names when zoomed out (tags.css) */}
          {box.tags.length > 1 && (
            <li
              className="dr-tag-chip dr-tag-chip--compact"
              data-testid="tag-chip-compact-more"
              data-dr-tag-color="grey"
              aria-hidden="true"
            >
              +{box.tags.length - 1}
            </li>
          )}
        </ul>
      </div>
    )
  },
  (a, b) => sameBox(a.box, b.box),
)

/** `overflow`: behind "+N" at full size, but still a dot when zoomed out (every tag's colour shows). */
function Chip({ tag, overflow }: { tag: TagDef; overflow: boolean }) {
  return (
    <li
      className="dr-tag-chip"
      data-testid={overflow ? 'tag-chip-overflow' : 'tag-chip'}
      data-tag-key={tag.key}
      data-dr-tag-color={tag.color}
      data-overflow={overflow || undefined}
      // Short names never shrink: a long neighbour takes the ellipsis instead.
      data-whole={isShortTagName(tag.name) || undefined}
    >
      {tag.name}
    </li>
  )
}
