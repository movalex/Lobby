// OWNER: W4 (wave L, L4-1). The connected-shape planner: where the next shape of a flow goes, what it looks like
// and the connector to it, as plain creation props. Pure (it reads the canvas, writes nothing); ./build.ts
// applies a plan.
//
//  - The next shape is the source's kind (a rectangle, an ellipse, a diamond or a sticky note) and style, or the
//    kind asked for (Ctrl/Cmd+Shift+Arrow repeats the last created kind), at the source's size.
//  - It sits a gap G = max(MIN_GAP, half the source's size along the direction) from the source, lined up with
//    it. MIN_GAP is 80, not the brief's 40: the room's elbow router keeps 40 px (Excalidraw's BASE_PADDING) clear of
//    each bound shape, so two shapes closer than 80 px get a connector that loops round (seen in the browser).
//    When that slot is taken, the next free slot is found the way arrange-grid keeps clear of neighbours: first
//    beside it across the direction (a branch: one slot either side, then two), then past whatever is in the way
//    along the direction; never over another element of the same level (a connector or a line may be crossed).
//  - It is placed in the source's frame when the source is in one: the frame grows to hold it, FRAME_PAD clear
//    of its edges (never shrinks; a locked or rotated frame does not grow, and the shape then stays outside it).
//  - The connector is a bound elbow arrow (./connector.ts): its whole path unit in its creation props, from the
//    source's side facing the new shape to the new shape's facing side; ./build.ts binds both ends.
//
// Flow-building is off for frames, locked elements, hidden (collapsed) elements, mind-map topics (they keep Tab
// and Enter) and anything that is not one of the four kinds; read-only roles are refused by the key and the
// handles before this is asked.
import type { CanvasElement, ItemKind, LobbyCanvas } from '../../canvas/api/index.ts'
import { geometry, items } from '../../canvas/api/index.ts'
import { hasMindmapData } from '../mindmap/ported/meta.ts'
import {
  type Box,
  CONNECTOR_INK,
  connectorProps,
  elbowGeometry,
  type FlowDir,
  OPPOSITE,
  SIDE_OF,
  type Side,
} from './connector.ts'

export type FlowKind = 'rectangle' | 'ellipse' | 'diamond' | 'note'
export const FLOW_KINDS: readonly FlowKind[] = ['rectangle', 'ellipse', 'diamond', 'note']

/** What the planner reads: the canvas's elements and their lock and collapse state. */
export type FlowReader = Pick<LobbyCanvas, 'get' | 'items' | 'isLocked' | 'isHidden'>

/** Least gap between a source and the next shape, scene px: twice the elbow router's padding (see the header). */
export const MIN_GAP = 80
/** How far the slot search looks: across (each side) and along. */
const ACROSS_SLOTS = 2
const ALONG_STEPS = 40
/** Frames keep this much room inside their edges for a shape the flow puts there. */
export const FRAME_PAD = 20

const KIND_OF_TYPE: Readonly<Record<string, FlowKind>> = {
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  diamond: 'diamond',
  stickynote: 'note',
}

const isLive = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** The flow kind of an element, or null when flow-building is off for it (see the header). */
export function flowKindOf(reader: FlowReader, el: CanvasElement | undefined): FlowKind | null {
  if (!isLive(el)) return null
  const kind = KIND_OF_TYPE[el.type]
  if (!kind) return null
  if (reader.isLocked(el.id) || reader.isHidden(el.id) || hasMindmapData(el)) return null
  return kind
}

/** The one selected element flows can be built from (a selected label stands for its container), or null. */
export function flowSourceOf(reader: FlowReader, selection: readonly string[]): string | null {
  const ids = [
    ...new Set(
      selection.map((id) => {
        const el = reader.get(id)
        return el ? items.containerOf(el, (x) => reader.get(x)).id : id
      }),
    ),
  ]
  if (ids.length !== 1) return null
  const id = ids[0] as string
  return flowKindOf(reader, reader.get(id)) ? id : null
}

/** An element's axis-aligned box (rotation included; a linear element from its points). */
export function boxOfElement(el: CanvasElement): Box {
  const points = (el as { points?: readonly (readonly [number, number])[] }).points
  const raw =
    points?.length && el.type !== 'image'
      ? (geometry.fromPoints(points.map(([px, py]) => ({ x: el.x + px, y: el.y + py }))) ??
        geometry.rect(el.x, el.y, el.width, el.height))
      : geometry.rect(el.x, el.y, el.width, el.height)
  const b = el.angle ? (geometry.fromPoints(geometry.corners(raw, el.angle)) ?? raw) : raw
  return { x: b.x, y: b.y, w: b.width, h: b.height }
}

const overlaps = (a: Box, b: Box, margin: number) =>
  a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin

/** What a new shape at the source's level must keep clear of: the level's elements, connectors and labels aside. */
export function obstaclesFor(
  reader: FlowReader,
  source: CanvasElement,
  ignore: ReadonlySet<string> = new Set(),
): Box[] {
  const frame = source.frameId ?? null
  const out: Box[] = []
  for (const el of items.contentItems(reader.items())) {
    if (el.id === source.id || ignore.has(el.id)) continue
    if (el.type === 'arrow' || el.type === 'line') continue
    if (reader.isHidden(el.id)) continue
    // inside a frame: its own elements; on the open canvas: the top-level elements and the frames themselves
    if (frame ? el.frameId !== frame : el.frameId && el.type !== 'frame') continue
    if (frame && el.id === frame) continue
    out.push(boxOfElement(el))
  }
  return out
}

/** The gap to the next shape: max(MIN_GAP, half the source's size along `dir`). */
export const gapFor = (b: Box, dir: FlowDir) =>
  Math.max(MIN_GAP, 0.5 * (dir === 'left' || dir === 'right' ? b.w : b.h))

const along = (dir: FlowDir): [number, number] =>
  dir === 'right' ? [1, 0] : dir === 'left' ? [-1, 0] : dir === 'down' ? [0, 1] : [0, -1]

/**
 * The free slot for a `size` box going `dir` from `src`: the first of (aligned, then a branch beside it on
 * either side, then the same past what is in the way) that overlaps no obstacle (with a gap/2 margin) and stays
 * inside `inside` when given. Falls back to the aligned slot.
 */
export function freeSlot(
  src: Box,
  size: { w: number; h: number },
  dir: FlowDir,
  obstacles: readonly Box[],
  inside: Box | null = null,
): Box {
  const gap = gapFor(src, dir)
  const [ux, uy] = along(dir)
  const horiz = ux !== 0
  // the aligned slot's top-left
  const base = {
    x: horiz ? (ux > 0 ? src.x + src.w + gap : src.x - gap - size.w) : src.x + (src.w - size.w) / 2,
    y: horiz ? src.y + (src.h - size.h) / 2 : uy > 0 ? src.y + src.h + gap : src.y - gap - size.h,
  }
  const stepAlong = (horiz ? size.w : size.h) + gap
  const stepAcross = (horiz ? size.h : size.w) + gap
  const margin = gap / 2
  const fits = (b: Box) =>
    (!inside ||
      (b.x >= inside.x - 0.5 &&
        b.y >= inside.y - 0.5 &&
        b.x + b.w <= inside.x + inside.w + 0.5 &&
        b.y + b.h <= inside.y + inside.h + 0.5)) &&
    !obstacles.some((o) => overlaps(b, o, margin))
  for (let k = 0; k < ALONG_STEPS; k++) {
    for (const j of [0, ...Array.from({ length: ACROSS_SLOTS }, (_, i) => [i + 1, -(i + 1)]).flat()]) {
      const b = {
        x: base.x + ux * k * stepAlong + (horiz ? 0 : j * stepAcross),
        y: base.y + uy * k * stepAlong + (horiz ? j * stepAcross : 0),
        w: size.w,
        h: size.h,
      }
      if (fits(b)) return b
    }
  }
  return { ...base, w: size.w, h: size.h }
}

/** The fields a new shape copies from its source (the shape style; never identity-bearing customData). */
const STYLE_FIELDS = [
  'strokeColor',
  'backgroundColor',
  'fillStyle',
  'strokeWidth',
  'strokeStyle',
  'roughness',
  'opacity',
  'roundness',
] as const

export interface ConnectedPlan {
  readonly sourceId: string
  readonly dir: FlowDir
  readonly kind: FlowKind
  /** the new shape: its tx.create kind and props (id included) */
  readonly shape: { readonly kind: ItemKind; readonly props: Readonly<Record<string, unknown>> }
  readonly shapeId: string
  readonly box: Box
  /** the connector's creation props (id and whole path unit included) */
  readonly arrow: Readonly<Record<string, unknown>>
  readonly arrowId: string
  /** the frame the new shape and its connector go in, or null */
  readonly frameId: string | null
  /** the frame's new size when it grows to hold the shape, else null */
  readonly frameGrow: {
    readonly id: string
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  } | null
}

export interface PlanOptions {
  /** a fresh element id */
  readonly newId: () => string
  /** the next shape's kind (default: the source's) */
  readonly kind?: FlowKind
  /** drop the next shape centred here instead of the free slot (a + handle dragged out) */
  readonly at?: { readonly x: number; readonly y: number }
}

/** The kind of a note when it is the next shape's: its props from the source's (fill and size). */
function noteProps(source: CanvasElement, id: string, b: Box, labelId: string): Record<string, unknown> {
  return {
    id,
    labelId,
    x: b.x,
    y: b.y,
    size: b.w,
    text: '',
    ...(source.type === 'stickynote' ? { backgroundColor: source.backgroundColor } : {}),
  }
}

/** The size the next shape takes: the source's (a note's size is its width; a box from a note is a square). */
function sizeFor(source: CanvasElement, kind: FlowKind): { w: number; h: number } {
  const w = Math.max(20, source.width || 100)
  const h = Math.max(20, source.height || 100)
  if (kind === 'note') return { w, h: w }
  return { w, h }
}

/**
 * The plan for the next connected shape from `sourceId` going `dir` (see the header), or null when flow-building
 * is off for the source.
 */
export function planConnected(
  reader: FlowReader,
  sourceId: string,
  dir: FlowDir,
  opts: PlanOptions,
): ConnectedPlan | null {
  const source = reader.get(sourceId)
  const sourceKind = flowKindOf(reader, source)
  if (!source || !sourceKind) return null
  const kind = opts.kind ?? sourceKind
  const src = boxOfElement(source)
  const size = sizeFor(source, kind)
  const frameEl = source.frameId ? reader.get(source.frameId) : undefined
  const frame = isLive(frameEl) && frameEl.type === 'frame' ? frameEl : null
  const obstacles = obstaclesFor(reader, source)
  const box: Box = opts.at
    ? { x: opts.at.x - size.w / 2, y: opts.at.y - size.h / 2, w: size.w, h: size.h }
    : freeSlot(src, size, dir, obstacles)
  let frameGrow: ConnectedPlan['frameGrow'] = null
  let inFrame = false
  if (frame) {
    // the frame grows to hold it, FRAME_PAD clear of its edges (never shrinks; a locked or rotated frame stays
    // as it is, and the shape then goes on the open canvas). Only the frame's own box changes: its children stay.
    const fb = boxOfElement(frame)
    const x1 = Math.min(fb.x, box.x - FRAME_PAD)
    const y1 = Math.min(fb.y, box.y - FRAME_PAD)
    const x2 = Math.max(fb.x + fb.w, box.x + box.w + FRAME_PAD)
    const y2 = Math.max(fb.y + fb.h, box.y + box.h + FRAME_PAD)
    const grows = x1 < fb.x - 0.5 || y1 < fb.y - 0.5 || x2 > fb.x + fb.w + 0.5 || y2 > fb.y + fb.h + 0.5
    inFrame = !grows || (!frame.locked && !frame.angle)
    if (inFrame && grows) frameGrow = { id: frame.id, x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  }
  const frameId = inFrame && frame ? frame.id : null
  const shapeId = opts.newId()
  const arrowId = opts.newId()
  const shapeType = kind === 'note' ? 'note' : kind
  let props: Record<string, unknown>
  if (kind === 'note') props = noteProps(source, shapeId, box, `${shapeId}.t`)
  else {
    props = {
      id: shapeId,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      angle: 0,
      frameId,
    }
    // the shape style of a shape source; a note source gives its fill to a box made from it
    if (source.type !== 'stickynote')
      for (const f of STYLE_FIELDS) {
        const v = (source as unknown as Record<string, unknown>)[f]
        if (v !== undefined) props[f] = v
      }
    else {
      props.backgroundColor = source.backgroundColor
      props.fillStyle = 'solid'
      props.strokeColor = CONNECTOR_INK
      props.roughness = 0
    }
  }
  const fromSide: Side = SIDE_OF[dir]
  const toSide: Side = SIDE_OF[OPPOSITE[dir]]
  const geo = elbowGeometry(src, fromSide, box, toSide)
  const ink = (source as { strokeColor?: string }).strokeColor
  const arrow = connectorProps(arrowId, geo, {
    strokeColor: ink && ink !== 'transparent' && source.type !== 'stickynote' ? ink : CONNECTOR_INK,
    roughness: typeof source.roughness === 'number' ? source.roughness : 0,
    frameId,
  })
  return {
    sourceId,
    dir,
    kind,
    shape: { kind: shapeType as ItemKind, props },
    shapeId,
    box,
    arrow,
    arrowId,
    frameId,
    frameGrow,
  }
}

/** The connector from `fromId` to an existing `toId` (a + handle dropped on a shape): its props, or null. */
export function planConnector(
  reader: FlowReader,
  fromId: string,
  toId: string,
  opts: { readonly newId: () => string },
): {
  readonly arrowId: string
  readonly arrow: Readonly<Record<string, unknown>>
  readonly frameId: string | null
} | null {
  const from = reader.get(fromId)
  const to = reader.get(toId)
  if (
    fromId === toId ||
    !flowKindOf(reader, from) ||
    !isLive(to) ||
    reader.isLocked(toId) ||
    reader.isHidden(toId)
  )
    return null
  if (!['rectangle', 'ellipse', 'diamond', 'stickynote', 'text', 'image', 'frame'].includes(to.type))
    return null
  const a = boxOfElement(from as CanvasElement)
  const b = boxOfElement(to)
  const dx = b.x + b.w / 2 - (a.x + a.w / 2)
  const dy = b.y + b.h / 2 - (a.y + a.h / 2)
  const dir: FlowDir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'down' : 'up'
  const arrowId = opts.newId()
  const frameId =
    (from as CanvasElement).frameId && (from as CanvasElement).frameId === to.frameId
      ? (to.frameId ?? null)
      : null
  const ink = (from as { strokeColor?: string }).strokeColor
  const arrow = connectorProps(arrowId, elbowGeometry(a, SIDE_OF[dir], b, SIDE_OF[OPPOSITE[dir]]), {
    strokeColor: ink && ink !== 'transparent' && from?.type !== 'stickynote' ? ink : CONNECTOR_INK,
    roughness: typeof from?.roughness === 'number' ? from.roughness : 0,
    frameId,
  })
  return { arrowId, arrow, frameId }
}
