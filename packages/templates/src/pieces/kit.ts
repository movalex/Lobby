// What the piece builders share: the colours and sizes pieces are drawn in, the helpers that turn a piece's
// plan into its elements (polygons, rounded corners, plain lines, left-aligned labels), and the finishing step
// (kind, group, indices, validation). Pieces are built with the template scene builder (../builder.ts: frames,
// texts, boxes, image slots) and emitted by the template emitter (../scene/emit.ts), so they are the same kind
// of element as a template's: nothing here makes a new element type.
import {
  type IdSource,
  LOBBY_FRAME_STROKE,
  lobbyColor,
  newElementId,
  randomInt31,
} from '@draftroom/board-ops/elements'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import {
  type EngineElement,
  indexKeysBetween,
  layoutBoundText,
  type TextElement,
} from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { round2 } from '@draftroom/canvas-schema/limits'
import type { BoardBuilder, LobbyColor, PlanNode } from '../builder.ts'
import { TemplateError } from '../common.ts'
import type { SceneEmitResult } from '../scene/emit.ts'

export type El = Record<string, unknown>

/** A piece's builder: adds its nodes at the builder's origin and may rework the emitted elements. */
export interface PieceDef {
  /** adds the nodes (at the builder's origin: the piece's top-left); returns the reworking of the result, if any */
  build(b: BoardBuilder): ((out: SceneEmitResult) => El[]) | undefined
}

// ---- looks (theme-safe: every colour is one of Lobby's, so dark mode has a designed shade for it) ------------------

/** Ink for words and outlines. */
export const INK: LobbyColor = 'black'
/** Secondary words: Lobby's readable grey. */
export const MUTED: LobbyColor = 'grey'

/** Words are set on pale tints in the dark ink, never white on a saturated fill (the templates' rule). */
export const ACCENT: LobbyColor = 'blue'

/** The element a plan node became. */
export function elOf(out: SceneEmitResult, node: PlanNode): El {
  const id = out.idOf.get(node)
  const el = out.elements.find((e) => e.id === id)
  if (!el) throw new TemplateError('invalid-output', 'piece: a node has no element')
  return el as unknown as El
}

/** The bound label of container `id` (by `containerId`, never an id suffix). */
export const labelOfEl = (elements: readonly El[], id: unknown): El | undefined =>
  elements.find((e) => e.type === 'text' && e.containerId === id)

/** Rounded corners: Excalidraw's adaptive radius (`radius` px, at most half the shorter side). */
export function round(el: El, radius = 32): void {
  el.roundness = { type: 3, value: radius }
}

/** A label that reads from the left (a text field's placeholder), laid out again inside its container. */
export function alignLabelLeft(elements: readonly El[], container: El): void {
  const label = labelOfEl(elements, container.id)
  if (!label) return
  label.textAlign = 'left'
  const lay = layoutBoundText(container as unknown as EngineElement, label as unknown as TextElement)
  Object.assign(container, lay.container)
  Object.assign(label, lay.text)
}

/** A label that reads from the top left (a notes field's placeholder), laid out again inside its container. */
export function alignLabelTopLeft(elements: readonly El[], container: El): void {
  const label = labelOfEl(elements, container.id)
  if (!label) return
  label.textAlign = 'left'
  label.verticalAlign = 'top'
  const lay = layoutBoundText(container as unknown as EngineElement, label as unknown as TextElement)
  Object.assign(container, lay.container)
  Object.assign(label, lay.text)
}

/** An image slot a person can select and move with its piece (the builder makes slots locked). */
export function unlockSlot(el: El): void {
  el.locked = false
}

// ---- lines and polygons -------------------------------------------------------------------------------------------------

export type Pt = readonly [number, number]

export interface LineStyle {
  stroke: LobbyColor
  fill?: 'none' | 'tint'
  dashed?: boolean
  width?: number
}

/**
 * A `line` element through `points` (scene coordinates). `polygon: true` closes it and fills it with `fill`
 * (the colour's pale tint). It copies the common fields of `like`, an element already emitted (frame,
 * paint-order-neutral fields, `updated`), so it passes the same checks.
 */
export function lineEl(
  like: El,
  newId: IdSource,
  points: readonly Pt[],
  style: LineStyle,
  polygon = false,
): El {
  const abs = points.map(([x, y]) => [round2(x), round2(y)] as const)
  const [x0, y0] = abs[0] as Pt
  const rel = abs.map(([x, y]) => [round2(x - x0), round2(y - y0)] as [number, number])
  const xs = rel.map((p) => p[0])
  const ys = rel.map((p) => p[1])
  const colour = lobbyColor(style.stroke)
  return {
    id: newId(),
    type: 'line',
    x: x0,
    y: y0,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    angle: 0,
    strokeColor: colour.solid,
    backgroundColor: style.fill === 'tint' ? colour.semi : 'transparent',
    fillStyle: 'solid',
    strokeWidth: style.width ?? 2,
    strokeStyle: style.dashed ? 'dashed' : 'solid',
    roundness: null,
    roughness: 0,
    opacity: 100,
    seed: randomInt31(),
    version: 1,
    versionNonce: randomInt31(),
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: like.updated,
    created: null,
    link: null,
    locked: false,
    points: rel,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    polygon,
  }
}

/**
 * Makes a box a polygon, the way canvas-ux's polygon tools do (D4): a closed `line` draws the outline and the
 * fill, and the box over it, now see-through, holds the label and the connectors; the two are grouped by the
 * piece's group. The line goes under the box in paint order. Returns the elements with the line added.
 */
export function asPolygon(
  elements: readonly El[],
  box: El,
  outline: (w: number, h: number) => Pt[],
  style: { stroke: LobbyColor; fill: LobbyColor },
  newId: IdSource,
): El[] {
  const w = box.width as number
  const h = box.height as number
  const x = box.x as number
  const y = box.y as number
  const colour = lobbyColor(style.fill)
  const stroke = lobbyColor(style.stroke)
  const points = outline(w, h).map(([px, py]) => [x + px, y + py] as Pt)
  const line = lineEl(box, newId, points, { stroke: style.stroke, fill: 'none' }, true)
  line.backgroundColor = colour.semi
  line.strokeColor = stroke.solid
  box.strokeColor = 'transparent'
  box.backgroundColor = 'transparent'
  const out = [...elements]
  out.splice(out.indexOf(box), 0, line)
  return out
}

/** A parallelogram leaning right (a flowchart's data; canvas-ux's "rhombus" polygon): the corners of a `w` by `h` box, closed. */
export function parallelogram(w: number, h: number): Pt[] {
  return [
    [w * 0.25, 0],
    [w, 0],
    [w * 0.75, h],
    [0, h],
    [w * 0.25, 0],
  ]
}

/** A document: a box with a wavy bottom edge, the corners of a `w` by `h` box, closed. */
export function documentOutline(w: number, h: number): Pt[] {
  const wave = Math.min(14, h / 8)
  const base = h - wave * 1.5
  const pts: Pt[] = [
    [0, 0],
    [w, 0],
    [w, base],
  ]
  const steps = 16
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    pts.push([w * (1 - t), base + wave * Math.sin(t * Math.PI * 2) * (1 - 0)])
  }
  pts.push([0, 0])
  return pts
}

// ---- finishing ----------------------------------------------------------------------------------------------------------

export interface FinishOptions {
  kind: string
  /** group the elements together (a piece of several elements moves as one) */
  group: boolean
  indexAbove: string | null
  newId: IdSource
}

/**
 * The finished piece: `kind` on every element (create-only, set here at creation), one group over the elements
 * of a multi-element piece, fresh indices above the board's top, and every element and the set passed through the
 * server's own checks, or this throws.
 */
export function finish(elements: readonly El[], o: FinishOptions): WireElement[] {
  const gid = o.group ? o.newId() : null
  const keys = indexKeysBetween(o.indexAbove, null, elements.length)
  const out = elements.map((el, i) => {
    const lobby = {
      ...((el.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}),
      kind: o.kind,
    }
    const next: El = { ...el, index: keys[i], customData: { lobby } }
    if (gid && el.type !== 'frame') next.groupIds = [gid]
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    const check = checkElement(next)
    if (!check.ok)
      throw new TemplateError('invalid-output', `Piece produced an invalid element: ${check.detail}`)
    return next as unknown as WireElement
  })
  const violations = checkInvariants(out)
  if (violations.length)
    throw new TemplateError(
      'invalid-output',
      `Piece elements are inconsistent: ${[...new Set(violations.map((v) => v.code))].join(', ')}`,
    )
  return out
}

export const FRAME_STROKE = LOBBY_FRAME_STROKE
export const freshId: IdSource = newElementId

// ---- arrows, curves and outlines (wave Q: the arrows, callouts and block-arrow kits) -------------------------------------

export type ArrowheadName = 'arrow' | 'bar' | 'circle' | 'circle_outline' | 'triangle' | 'triangle_outline'

export interface ArrowStyle {
  stroke: LobbyColor
  width?: number
  dashed?: boolean
  /** the head at the first point (default none) */
  start?: ArrowheadName | null
  /** the head at the last point (default an open arrowhead) */
  end?: ArrowheadName | null
  /** a curve through three points (Excalidraw's round arrow); two points stay straight */
  curved?: boolean
}

/**
 * A free `arrow` element through `points` (scene coordinates): bound to nothing, so a person can drag its ends onto
 * shapes afterwards (the room then derives the bound ends). Straight, or curved with three points. `updated` comes
 * from `like`, an element already emitted, else the clock.
 */
export function arrowEl(like: El | undefined, newId: IdSource, points: readonly Pt[], style: ArrowStyle): El {
  const abs = points.map(([x, y]) => [round2(x), round2(y)] as const)
  const [x0, y0] = abs[0] as Pt
  const rel = abs.map(([x, y]) => [round2(x - x0), round2(y - y0)] as [number, number])
  const xs = rel.map((p) => p[0])
  const ys = rel.map((p) => p[1])
  return {
    id: newId(),
    type: 'arrow',
    x: x0,
    y: y0,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    angle: 0,
    strokeColor: lobbyColor(style.stroke).solid,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: style.width ?? 3.5,
    strokeStyle: style.dashed ? 'dashed' : 'solid',
    roundness: style.curved && rel.length > 2 ? { type: 2 } : null,
    roughness: 0,
    opacity: 100,
    seed: randomInt31(),
    version: 1,
    versionNonce: randomInt31(),
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: like?.updated ?? Date.now(),
    created: null,
    link: null,
    locked: false,
    points: rel,
    startBinding: null,
    endBinding: null,
    startArrowhead: style.start ?? null,
    endArrowhead: style.end === undefined ? 'arrow' : style.end,
    elbowed: false,
  }
}

/** `n` points of the quarter circle around (`cx`, `cy`) from `from` to `to` degrees, inclusive (0 = right, 90 = down). */
export function arcPoints(cx: number, cy: number, r: number, from: number, to: number, n = 6): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / n) * Math.PI) / 180
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt
  })
}

export interface BubbleTail {
  /** where its base starts, as a fraction of the width */
  at: number
  /** how far it reaches past the bottom edge, and how wide its base is */
  length: number
  width: number
  /** where its tip sits across, in board units from the left (default: over the middle of its base) */
  tipX?: number
}

/** `pts` without a point equal to the one before it (the arcs of neighbouring corners share their ends). */
function dedupe(pts: readonly Pt[]): Pt[] {
  return pts.filter((p, i) => i === 0 || p[0] !== (pts[i - 1] as Pt)[0] || p[1] !== (pts[i - 1] as Pt)[1])
}

/**
 * The closed outline of a rounded `w` by `h` box with an optional tail under it, clockwise from the top edge,
 * smooth (the corners are drawn from short segments) and ending on its first point. The tail points past the
 * bottom edge, so the outline is taller than `h`.
 */
export function bubbleOutline(w: number, h: number, radius: number, tail?: BubbleTail): Pt[] {
  const r = Math.min(radius, w / 2, h / 2)
  const pts: Pt[] = [[r, 0]]
  pts.push(...arcPoints(w - r, r, r, -90, 0))
  pts.push(...arcPoints(w - r, h - r, r, 0, 90))
  if (tail) {
    const left = w * tail.at
    pts.push([left + tail.width, h], [tail.tipX ?? left + tail.width / 2, h + tail.length], [left, h])
  }
  pts.push(...arcPoints(r, h - r, r, 90, 180))
  pts.push(...arcPoints(r, r, r, 180, 270))
  pts.push([r, 0])
  return dedupe(pts.map(([x, y]) => [round2(x), round2(y)] as Pt))
}

export type Direction = 'right' | 'left' | 'up' | 'down'

/**
 * A block arrow pointing `dir`, the corners of a `w` by `h` box, closed: a shaft `shaft` (0-1) of the cross
 * size thick, and a head `head` (0-1) of the length long.
 */
export function blockArrow(dir: Direction, w: number, h: number, shaft = 0.46, head = 0.38): Pt[] {
  if (dir === 'up' || dir === 'down') {
    // drawn pointing right in the turned box, then turned a quarter (right becomes down), and flipped for up
    const down = blockArrow('right', h, w, shaft, head).map(([x, y]) => [w - y, x] as Pt)
    return dir === 'down' ? down : down.map(([x, y]) => [x, h - y] as Pt)
  }
  const y0 = (h * (1 - shaft)) / 2
  const y1 = h - y0
  const neck = w * (1 - head)
  const right: Pt[] = [
    [0, y0],
    [neck, y0],
    [neck, 0],
    [w, h / 2],
    [neck, h],
    [neck, y1],
    [0, y1],
    [0, y0],
  ]
  return dir === 'right' ? right : right.map(([x, y]) => [w - x, y] as Pt)
}
