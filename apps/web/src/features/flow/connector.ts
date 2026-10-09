// OWNER: W4 (wave L, L4-1 and L4-2). The connector both flow paths make: a bound elbow arrow from one box's
// side to another's. Pure.
//
// The arrow invariants (AGENTS.md "Bound arrow endpoints are always server-derived"): the client writes an
// arrow's WHOLE geometry unit once, in its creation props (x, y, points, width, height, angle and, for an
// elbow, elbowed, fixedSegments, startIsSpecial and endIsSpecial: the engine's newArrowElement fills the last
// three), then binds both ends with LobbyTx.bind in a joinPrevious transact. It never computes the bound
// endpoints for a push: the room's re-snap (apps/sync/src/room/fit.ts, trigger 2: an arrow's creation and
// bindings) routes the elbow and writes the ends in the same commit. The geometry here only has to start each
// end on the side it binds to, so the bind's fixed point (the end's place relative to the box) names that side.

/** A scene rectangle: top-left and size. */
export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export type FlowDir = 'right' | 'left' | 'down' | 'up'
export const FLOW_DIRS: readonly FlowDir[] = ['right', 'left', 'down', 'up']
/** A side of a box. */
export type Side = 'right' | 'left' | 'bottom' | 'top'

export const OPPOSITE: Readonly<Record<FlowDir, FlowDir>> = {
  right: 'left',
  left: 'right',
  down: 'up',
  up: 'down',
}
/** The side a connector leaves a box by when it goes `dir`. */
export const SIDE_OF: Readonly<Record<FlowDir, Side>> = {
  right: 'right',
  left: 'left',
  down: 'bottom',
  up: 'top',
}

/** The middle of a box's side. */
export function sidePoint(b: Box, side: Side): { x: number; y: number } {
  switch (side) {
    case 'right':
      return { x: b.x + b.w, y: b.y + b.h / 2 }
    case 'left':
      return { x: b.x, y: b.y + b.h / 2 }
    case 'bottom':
      return { x: b.x + b.w / 2, y: b.y + b.h }
    case 'top':
      return { x: b.x + b.w / 2, y: b.y }
  }
}

const horizontal = (s: Side) => s === 'left' || s === 'right'

/** The connector's whole path unit (the fields of canvas-schema's arrow `path` group that the client gives). */
export interface ConnectorGeometry {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly angle: 0
  readonly points: [number, number][]
}

/**
 * The elbow path from `from`'s `fromSide` to `to`'s `toSide`: straight when the two side points line up,
 * else out along the first side's axis to half-way, across, and in (one bend pair). The room re-routes it
 * on the bind; this is only the unit the creation carries.
 */
export function elbowGeometry(from: Box, fromSide: Side, to: Box, toSide: Side): ConnectorGeometry {
  const s = sidePoint(from, fromSide)
  const e = sidePoint(to, toSide)
  const dx = e.x - s.x
  const dy = e.y - s.y
  let points: [number, number][]
  if (Math.abs(horizontal(fromSide) ? dy : dx) < 0.5)
    points = [[0, 0], horizontal(fromSide) ? [dx, 0] : [0, dy]]
  else if (horizontal(fromSide) === horizontal(toSide))
    points = horizontal(fromSide)
      ? [
          [0, 0],
          [dx / 2, 0],
          [dx / 2, dy],
          [dx, dy],
        ]
      : [
          [0, 0],
          [0, dy / 2],
          [dx, dy / 2],
          [dx, dy],
        ]
  else
    points = horizontal(fromSide)
      ? [
          [0, 0],
          [dx, 0],
          [dx, dy],
        ]
      : [
          [0, 0],
          [0, dy],
          [dx, dy],
        ]
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  return {
    x: s.x,
    y: s.y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    angle: 0,
    points,
  }
}

/**
 * The sides a connector from `a` to `b` takes in a diagram that reads `direction`: down a layer leaves the
 * bottom and enters the top (right: the right side into the left); a connector back up (a cycle's back edge)
 * loops out of the side and back into the same side of its target; across one layer, side to side.
 */
export function sidesFor(a: Box, b: Box, direction: 'down' | 'right'): { from: Side; to: Side } {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  if (direction === 'down') {
    if (b.y >= a.y + a.h - 0.5) return { from: 'bottom', to: 'top' }
    if (b.y + b.h <= a.y + 0.5) return { from: 'right', to: 'right' }
    return bc.x >= ac.x ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' }
  }
  if (b.x >= a.x + a.w - 0.5) return { from: 'right', to: 'left' }
  if (b.x + b.w <= a.x + 0.5) return { from: 'bottom', to: 'bottom' }
  return bc.y >= ac.y ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' }
}

/** The ink connectors take when their source has none of its own (Excalidraw's default stroke). */
export const CONNECTOR_INK = '#1e1e1e'

/** A connector's creation props: its whole path unit, an elbow, an arrowhead at the end (or none). */
export function connectorProps(
  id: string,
  geometry: ConnectorGeometry,
  style: {
    readonly strokeColor?: string
    readonly strokeWidth?: number
    readonly roughness?: number
    readonly strokeStyle?: string
    readonly endArrowhead?: string | null
    readonly frameId?: string | null
    readonly customData?: unknown
  } = {},
): Record<string, unknown> {
  return {
    id,
    ...geometry,
    elbowed: true,
    fixedSegments: null,
    roundness: null,
    strokeColor: style.strokeColor ?? CONNECTOR_INK,
    strokeWidth: style.strokeWidth ?? 2,
    strokeStyle: style.strokeStyle ?? 'solid',
    roughness: style.roughness ?? 0,
    opacity: 100,
    startArrowhead: null,
    endArrowhead: style.endArrowhead === undefined ? 'arrow' : style.endArrowhead,
    frameId: style.frameId ?? null,
    ...(style.customData !== undefined ? { customData: style.customData } : {}),
  }
}
