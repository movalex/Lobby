/**
 * Field groups per element kind, the derived-write rule, the `path` unit and user-set geometry
 * (docs/EXCALIDRAW-MIGRATION.md §3.2, §2.5.2, §2.8, §2.9.4 rule 7). Frozen at the spike B contracts step
 * C0: the ONE map (spike A's `apps/web/src/canvas/history/fields.ts` copy now imports it) and the ONE
 * geometry compare that the client's derived test, undo and every test use.
 *
 * The group vocabulary (`GroupName`, `GROUP_FIELDS`, the path field lists) is protocol.ts; this file says
 * which group each field of each element KIND is in (a bound label's `x` is `layout`, an arrow's `x` is
 * `path`, a rectangle's `x` is `pos`).
 *
 * Node-safe: no DOM. Scene coordinates come from Excalidraw's own helper through `engine/linear.ts`.
 */
import { pointAtIndexGlobal } from './engine/linear.ts'
import { GEOMETRY_TOLERANCE_PX } from './limits.ts'
import {
  ARROW_PATH_FIELDS,
  DERIVED_CLOCK,
  ELBOW_PATH_FIELDS,
  GROUP_FIELDS,
  type GroupName,
  LINE_PATH_FIELDS,
  pathUnitProblem,
} from './protocol.ts'

export { type GroupName, pathUnitProblem }

// ---- kinds ---------------------------------------------------------------------------------------------

/** The kinds the map distinguishes: a text is a free text or a bound label (it has a `containerId`). */
export const ELEMENT_KINDS = [
  'rectangle',
  'ellipse',
  'diamond',
  'stickynote',
  'freetext',
  'label',
  'arrow',
  'line',
  'freedraw',
  'image',
  'frame',
] as const
export type ElementKind = (typeof ELEMENT_KINDS)[number]

export interface Kindable {
  readonly type: string
  readonly containerId?: string | null
}

/** The kind of an element, or null for a type Lobby does not store. */
export function kindOf(el: Kindable): ElementKind | null {
  if (el.type === 'text') return el.containerId ? 'label' : 'freetext'
  return (ELEMENT_KINDS as readonly string[]).includes(el.type) ? (el.type as ElementKind) : null
}

// ---- the map (§3.2) ----------------------------------------------------------------------------------

/** Never taken from clients (§3.2). `customData.lobbyServer` is server-owned too (it is inside `customData`). */
export const SERVER_OWNED_FIELDS: readonly string[] = [
  'id',
  'type',
  'version',
  'versionNonce',
  'updated',
  'created',
]
/** Never synced; the server stores `'saved'` (§2.5.5 E1). */
export const LOCAL_ONLY_FIELDS: readonly string[] = ['status']
/** `customData` is classified per key: `lobby.<key>` is group `c:<key>`, `lobbyServer` is server-owned. */
export const CUSTOM_DATA_FIELD = 'customData'
/**
 * Fields the pinned engine writes onto elements by accident (found at C0): `LinearElementEditor.movePoints`
 * spreads its `otherUpdates` argument into the element (E 11536-11540), and Excalidraw's own
 * `updateBoundElements` passes `{ moveMidPointsWithElement }` there (E 9114-9116). So every straight or
 * curved arrow that followed a target carries `moveMidPointsWithElement` in a browser, and so does an arrow
 * a server re-snapped with `movePoints`. They are in no group and never on the wire: the adapter strips
 * them before it diffs or pushes, the server before it stores (the strict element schema refuses them).
 */
export const ENGINE_ARTIFACT_FIELDS: readonly string[] = ['moveMidPointsWithElement']
/** A copy of `el` without the engine's stray fields (or `el` itself when it has none). */
export function stripEngineArtifacts<T extends Readonly<Record<string, unknown>>>(el: T): T {
  if (!ENGINE_ARTIFACT_FIELDS.some((f) => f in el)) return el
  const out: Record<string, unknown> = { ...el }
  for (const f of ENGINE_ARTIFACT_FIELDS) delete out[f]
  return out as T
}

type FieldMap = Readonly<Record<string, GroupName>>

const COMMON: FieldMap = {
  x: 'pos',
  y: 'pos',
  width: 'shape',
  height: 'shape',
  angle: 'shape',
  roundness: 'shape',
  seed: 'shape',
  strokeColor: 'style',
  backgroundColor: 'style',
  fillStyle: 'style',
  strokeWidth: 'style',
  strokeStyle: 'style',
  roughness: 'style',
  opacity: 'style',
  boundElements: 'bound',
  index: 'z',
  groupIds: 'membership',
  frameId: 'membership',
  link: 'meta',
  locked: 'meta',
  isDeleted: 'life',
}
const TEXT: FieldMap = {
  ...COMMON,
  originalText: 'text',
  text: 'layout',
  fontSize: 'textStyle',
  baseFontSize: 'textStyle',
  fontFamily: 'textStyle',
  lineHeight: 'textStyle',
  textAlign: 'textStyle',
  verticalAlign: 'textStyle',
  autoResize: 'textStyle',
  containerId: 'bind',
  labelPosition: 'bind',
}
const LINEAR: FieldMap = {
  ...COMMON,
  x: 'path',
  y: 'path',
  width: 'path',
  height: 'path',
  angle: 'path',
  points: 'path',
  startBinding: 'bind',
  endBinding: 'bind',
  startArrowhead: 'style',
  endArrowhead: 'style',
}

/** Every top-level field of every kind, and its group. Server-owned, local-only and `customData` are not here. */
export const FIELD_GROUPS: Readonly<Record<ElementKind, FieldMap>> = {
  rectangle: COMMON,
  ellipse: COMMON,
  diamond: COMMON,
  stickynote: { ...COMMON, baseHeight: 'shape' },
  /** free text: its box (`width`, `height`) is derived layout; its `x`, `y` are `pos` (typing moves them as fit, 3.5) */
  freetext: { ...TEXT, width: 'layout', height: 'layout' },
  /** a bound label's position, size and font size are derived layout, not user geometry */
  label: { ...TEXT, x: 'layout', y: 'layout', width: 'layout', height: 'layout', fontSize: 'layout' },
  arrow: {
    ...LINEAR,
    elbowed: 'path',
    fixedSegments: 'path',
    startIsSpecial: 'path',
    endIsSpecial: 'path',
  },
  line: { ...LINEAR, polygon: 'path' },
  freedraw: {
    ...COMMON,
    points: 'shape',
    pressures: 'shape',
    simulatePressure: 'shape',
    strokeOptions: 'style',
  },
  image: { ...COMMON, fileId: 'file', scale: 'shape', crop: 'shape' },
  frame: { ...COMMON, name: 'meta' },
}

export type FieldClass = GroupName | 'server-owned' | 'local-only' | 'customData' | 'engine-artifact'

/** The class of a top-level field of `el`: its group, `server-owned`, `local-only`, `customData`; null = unknown. */
export function classifyField(el: Kindable, field: string): FieldClass | null {
  if (SERVER_OWNED_FIELDS.includes(field)) return 'server-owned'
  if (LOCAL_ONLY_FIELDS.includes(field)) return 'local-only'
  if (field === CUSTOM_DATA_FIELD) return 'customData'
  if (ENGINE_ARTIFACT_FIELDS.includes(field)) return 'engine-artifact'
  const kind = kindOf(el)
  return kind ? (FIELD_GROUPS[kind][field] ?? null) : null
}

/** The group of a top-level field of `el`, or null when the field is in no group (server-owned, local-only, customData, unknown). */
export function fieldGroupOf(el: Kindable, field: string): GroupName | null {
  const c = classifyField(el, field)
  return c === null ||
    c === 'server-owned' ||
    c === 'local-only' ||
    c === 'customData' ||
    c === 'engine-artifact'
    ? null
    : c
}

/** The fields of `group` for `kind`, in the map's order. */
export function fieldsOfGroup(kind: ElementKind, group: GroupName): string[] {
  return Object.entries(FIELD_GROUPS[kind])
    .filter(([, g]) => g === group)
    .map(([f]) => f)
}

/**
 * The coverage check (§3.2): the keys of `el` that are in no group and not server-owned, local-only,
 * an engine artifact or `customData` (an engine bump that adds a field fails here), and keys classified twice (a map field
 * that is also server-owned or local-only). Both lists must be empty.
 */
export function coverageProblems(el: Kindable & Readonly<Record<string, unknown>>): {
  unclassified: string[]
  doubled: string[]
} {
  const kind = kindOf(el)
  const map = kind ? FIELD_GROUPS[kind] : {}
  const unclassified: string[] = []
  const doubled: string[] = []
  for (const key of Object.keys(el)) {
    const inMap = key in map
    const special =
      SERVER_OWNED_FIELDS.includes(key) ||
      LOCAL_ONLY_FIELDS.includes(key) ||
      ENGINE_ARTIFACT_FIELDS.includes(key) ||
      key === CUSTOM_DATA_FIELD
    if (!inMap && !special) unclassified.push(key)
    if (inMap && special) doubled.push(key)
  }
  return { unclassified, doubled }
}

/** The keys of `el` in no group and not server-owned, local-only or `customData` (the coverage test's first list). */
export const unclassifiedKeys = (el: Kindable & Readonly<Record<string, unknown>>): string[] =>
  coverageProblems(el).unclassified

// sanity at module load: every map field is in its group's wire vocabulary (protocol.ts GROUP_FIELDS)
for (const [kind, map] of Object.entries(FIELD_GROUPS))
  for (const [field, group] of Object.entries(map))
    if (!GROUP_FIELDS[group].includes(field))
      throw new Error(`groups.ts: ${kind}.${field} is not a ${group} field`)

// ---- the derived-write rule (§3.2, §2.9.4 rule 7) --------------------------------------------------------

/**
 * Derived writes: a container fit, and the server's re-snaps of bound arrows and their labels. They
 * advance only `gclock.fit` of the element they change, never `gclock.path`, `pos`, `shape`, `layout` or
 * `text`, and are attributed to the server. So they never make another user's later edit `STALE`, never
 * count as "ours changed" in a roll-forward, and never block a container fit.
 */
export const DERIVED_WRITE_CLOCK = DERIVED_CLOCK
export const DERIVED_WRITES_NEVER_ADVANCE: readonly GroupName[] = ['path', 'pos', 'shape', 'layout', 'text']

/**
 * Server-derived, always (revisions 3.3–3.5): the endpoints of an arrow that are bound to a target, the
 * route of a bound elbow arrow, and the position of the arrow's label. Only the server writes them; no
 * client pushes an arrow change that only moved its bound endpoints (`isDerivedArrowChange` below).
 */
export const SERVER_DERIVED = ['bound arrow endpoints', 'elbow routes', 'arrow label positions'] as const

/**
 * The re-snap trigger (revision 3.4): an applied change to any of these fields of a bindable element,
 * whatever group carries it (`pos`, `shape`, a fit, a free text's `layout`), re-snaps both bound
 * endpoints (or the elbow route) of every live arrow bound to it, in the same savepoint and clock. Any
 * applied write to an arrow's own `path` unit re-snaps that arrow's bound ends against the stored targets.
 */
export const RESNAP_TRIGGER_FIELDS = ['x', 'y', 'width', 'height', 'angle'] as const

// ---- the `path` unit ---------------------------------------------------------------------------------

export type PathUnit = Record<string, unknown>

/**
 * The whole `path` unit of an arrow or a line, from one copy (§2.4.2): for an arrow `x`, `y`, `points`,
 * `width`, `height`, `angle`, `elbowed` and, when the element has them, `fixedSegments`,
 * `startIsSpecial`, `endIsSpecial`; for a line `x`, `y`, `points`, `width`, `height`, `angle`, `polygon`.
 * Values are deep copies. Throws for any other type.
 */
export function pathUnitOf(el: Readonly<Record<string, unknown>> & { readonly type: string }): PathUnit {
  const fields: readonly string[] =
    el.type === 'arrow'
      ? [...ARROW_PATH_FIELDS, ...ELBOW_PATH_FIELDS.filter((f) => el[f] !== undefined)]
      : el.type === 'line'
        ? LINE_PATH_FIELDS
        : []
  if (fields.length === 0) throw new Error(`pathUnitOf: ${el.type} has no path unit`)
  const unit: PathUnit = {}
  for (const f of fields) unit[f] = structuredClone(el[f])
  return unit
}

// ---- user-set geometry (§2.9.4 rule 7, §2.8; revision 3.5) -------------------------------------------------

export type Vec = readonly [number, number]
export interface FixedSegmentGeometry {
  /** a vertical segment's position across its axis is its scene `x`, a horizontal one's its scene `y` */
  readonly orientation: 'vertical' | 'horizontal'
  readonly cross: number
}
/**
 * What a person chose about an arrow's or a line's geometry, in scene coordinates:
 * - `points`: a straight or curved arrow's unbound points (a free end and every midpoint), or every point
 *   of a line, each with its index;
 * - `selfloop`: an arrow with both ends bound to one element: its midpoints relative to its start;
 * - `elbow`: an elbow arrow's unbound ends (null when bound) and its fixed segments in order (by `index`),
 *   each by orientation and cross-axis position, NEVER by index (the router renumbers them when a
 *   target's heading changes).
 * Not part of it: bound endpoints; `width` and `height`; an elbow arrow's other points and its fixed
 * segments' ends along their axis (the router rewrites those when a target moves).
 */
export type UserSetGeometry =
  | { readonly kind: 'points'; readonly points: readonly { readonly index: number; readonly at: Vec }[] }
  | { readonly kind: 'selfloop'; readonly points: readonly { readonly index: number; readonly rel: Vec }[] }
  | {
      readonly kind: 'elbow'
      readonly start: Vec | null
      readonly end: Vec | null
      readonly segments: readonly FixedSegmentGeometry[]
    }

interface Binding {
  readonly elementId: string
}
export interface LinearGeometryInput {
  readonly id: string
  readonly type: string
  readonly x: number
  readonly y: number
  readonly angle: number
  readonly points: readonly (readonly [number, number])[]
  readonly startBinding?: Binding | null
  readonly endBinding?: Binding | null
  readonly elbowed?: boolean
  readonly fixedSegments?:
    | readonly { readonly start: Vec; readonly end: Vec; readonly index: number }[]
    | null
}

/**
 * The user-set geometry of an arrow or a line (throws for other types). Scene coordinates come from
 * `LinearElementEditor.getPointAtIndexGlobalCoordinates` (engine/linear.ts), so rotation counts.
 * Elbow arrows are never rotated in Excalidraw (a rotation re-routes them, E 23053-23056), so a fixed
 * segment's cross-axis position is `x + start[0]` or `y + start[1]`.
 */
export function userSetGeometry(
  el: LinearGeometryInput,
  elementsMap?: ReadonlyMap<string, unknown>,
): UserSetGeometry {
  if (el.type !== 'arrow' && el.type !== 'line') throw new Error(`userSetGeometry: ${el.type} is not linear`)
  const map = elementsMap ?? new Map([[el.id, el]])
  const n = el.points.length
  const at = (i: number): Vec => pointAtIndexGlobal(el, i, map)
  if (el.type === 'arrow' && el.elbowed) {
    const segments = [...(el.fixedSegments ?? [])]
      .sort((a, b) => a.index - b.index)
      .map((s): FixedSegmentGeometry => {
        const vertical = Math.abs(s.start[0] - s.end[0]) <= Math.abs(s.start[1] - s.end[1])
        return vertical
          ? { orientation: 'vertical', cross: el.x + s.start[0] }
          : { orientation: 'horizontal', cross: el.y + s.start[1] }
      })
    return {
      kind: 'elbow',
      start: el.startBinding || n === 0 ? null : at(0),
      end: el.endBinding || n === 0 ? null : at(n - 1),
      segments,
    }
  }
  const start = el.type === 'arrow' ? el.startBinding : null
  const end = el.type === 'arrow' ? el.endBinding : null
  if (start && end && start.elementId === end.elementId) {
    const s = at(0)
    const points: { index: number; rel: Vec }[] = []
    for (let i = 1; i < n - 1; i++) {
      const p = at(i)
      points.push({ index: i, rel: [p[0] - s[0], p[1] - s[1]] })
    }
    return { kind: 'selfloop', points }
  }
  const points: { index: number; at: Vec }[] = []
  for (let i = 0; i < n; i++) {
    if ((i === 0 && start) || (i === n - 1 && end)) continue
    points.push({ index: i, at: at(i) })
  }
  return { kind: 'points', points }
}

const vecDelta = (a: Vec | null, b: Vec | null): number => {
  if (a === null || b === null) return a === b ? 0 : Number.POSITIVE_INFINITY
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))
}

/**
 * The largest coordinate difference between two user-set geometries, or Infinity when their shapes
 * differ (another kind, other unbound points, another number of fixed segments, or another orientation
 * at the same place in the order).
 */
export function userSetGeometryDelta(a: UserSetGeometry, b: UserSetGeometry): number {
  if (a.kind !== b.kind) return Number.POSITIVE_INFINITY
  if (a.kind === 'elbow' && b.kind === 'elbow') {
    if (a.segments.length !== b.segments.length) return Number.POSITIVE_INFINITY
    let d = Math.max(vecDelta(a.start, b.start), vecDelta(a.end, b.end))
    for (let i = 0; i < a.segments.length; i++) {
      const x = a.segments[i] as FixedSegmentGeometry
      const y = b.segments[i] as FixedSegmentGeometry
      if (x.orientation !== y.orientation) return Number.POSITIVE_INFINITY
      d = Math.max(d, Math.abs(x.cross - y.cross))
    }
    return d
  }
  const pa = (a as { points: readonly { index: number; at?: Vec; rel?: Vec }[] }).points
  const pb = (b as { points: readonly { index: number; at?: Vec; rel?: Vec }[] }).points
  if (pa.length !== pb.length) return Number.POSITIVE_INFINITY
  let d = 0
  for (let i = 0; i < pa.length; i++) {
    const x = pa[i] as { index: number; at?: Vec; rel?: Vec }
    const y = pb[i] as { index: number; at?: Vec; rel?: Vec }
    if (x.index !== y.index) return Number.POSITIVE_INFINITY
    d = Math.max(d, vecDelta(x.at ?? x.rel ?? null, y.at ?? y.rel ?? null))
  }
  return d
}

/**
 * THE geometry compare (revision 3.5): equal when both have the same shape and every coordinate differs
 * by at most `tolerance` (default `GEOMETRY_TOLERANCE_PX`, 0.5 px). The derived test, undo's
 * compare-and-set of `path`, and every geometry assertion of the tests use this function.
 */
export function sameUserSetGeometry(
  a: UserSetGeometry,
  b: UserSetGeometry,
  tolerance: number = GEOMETRY_TOLERANCE_PX,
): boolean {
  return userSetGeometryDelta(a, b) <= tolerance
}

// ---- the structural derived test (§2.5.2, revision 3.4; tolerance 3.5) --------------------------------------

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ra = a as Record<string, unknown>
  const rb = b as Record<string, unknown>
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined)
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!deepEqual(ra[k], rb[k])) return false
  return true
}

export interface ArrowChangeComparison {
  /** the change is derived: held locally, never pushed, never recorded by undo */
  readonly derived: boolean
  /** `userSetGeometryDelta` of local against confirmed (Infinity: another shape) */
  readonly userSetDelta: number
  /** fields of the arrow's other groups that differ (`c:<key>` for `customData.lobby` keys) */
  readonly otherGroupsChanged: readonly string[]
}

type ArrowLike = LinearGeometryInput & Readonly<Record<string, unknown>>

/**
 * The structural derived test itself: an arrow's local change is DERIVED only if its user-set geometry
 * equals `confirmed` within `GEOMETRY_TOLERANCE_PX` and every field of its other groups (§3.2; server-
 * owned and local-only fields are in no group) equals `confirmed` exactly, whatever caused the change.
 * A derived change moved only bound endpoints and what the rebase or the elbow router derives from them
 * (for an elbow arrow possibly flipped `startIsSpecial`/`endIsSpecial` and renumbered segments, which are
 * in `path`). Anything else (the user's own point edit, a frame drag or group move that translated the
 * arrow) is the user's own write, pushed as the whole `path` unit.
 *
 * O2's engine core calls this unchanged; the C0 arrow acceptance tests call it directly. Pass the scenes
 * the two copies live in when available (a curved arrow's bounds do not need them). Non-arrows: false.
 */
export function compareArrowChange(
  local: ArrowLike,
  confirmed: ArrowLike,
  localMap?: ReadonlyMap<string, unknown>,
  confirmedMap?: ReadonlyMap<string, unknown>,
): ArrowChangeComparison {
  if (local.type !== 'arrow' || confirmed.type !== 'arrow')
    return { derived: false, userSetDelta: Number.POSITIVE_INFINITY, otherGroupsChanged: ['type'] }
  const userSetDelta = userSetGeometryDelta(
    userSetGeometry(local, localMap),
    userSetGeometry(confirmed, confirmedMap),
  )
  const otherGroupsChanged: string[] = []
  const map = FIELD_GROUPS.arrow
  for (const field of new Set([...Object.keys(local), ...Object.keys(confirmed)])) {
    const group = map[field]
    if (!group || group === 'path') continue
    if (!deepEqual(local[field], confirmed[field])) otherGroupsChanged.push(field)
  }
  const la = ((local.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}) as Record<
    string,
    unknown
  >
  const lb = ((confirmed.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ??
    {}) as Record<string, unknown>
  for (const key of new Set([...Object.keys(la), ...Object.keys(lb)]))
    if (!deepEqual(la[key], lb[key])) otherGroupsChanged.push(`c:${key}`)
  return {
    derived: userSetDelta <= GEOMETRY_TOLERANCE_PX && otherGroupsChanged.length === 0,
    userSetDelta,
    otherGroupsChanged,
  }
}

/** `compareArrowChange(...).derived`. */
export function isDerivedArrowChange(
  local: ArrowLike,
  confirmed: ArrowLike,
  localMap?: ReadonlyMap<string, unknown>,
  confirmedMap?: ReadonlyMap<string, unknown>,
): boolean {
  return compareArrowChange(local, confirmed, localMap, confirmedMap).derived
}

// ---- applying a patch (mechanical; no merge policy) ---------------------------------------------------------

export interface ElementPatch {
  readonly g?: Readonly<Partial<Record<GroupName, Readonly<Record<string, unknown>>>>>
  readonly c?: Readonly<Record<string, unknown>>
  readonly b?: {
    readonly add: readonly { readonly id: string; readonly type: 'arrow' | 'text' }[]
    readonly rm: readonly string[]
  }
  readonly lobbyServer?: unknown
}

/**
 * The mechanical overlay of a patch's values onto a copy of `el` (no merge policy, no clocks, no
 * versions): `g` groups are assigned field by field, except `path`, which is applied WHOLE (an elbow
 * field the unit leaves out is removed); `c` sets or (null) removes `customData.lobby` keys; `b` adds
 * and removes `boundElements` by id; `lobbyServer` replaces `customData.lobbyServer`. The server's merge
 * (O1) decides WHAT to apply; this is how a chosen patch lands, on the server and on clients alike.
 */
export function overlayPatch<T extends Readonly<Record<string, unknown>>>(el: T, patch: ElementPatch): T {
  const out: Record<string, unknown> = { ...el }
  for (const [group, fields] of Object.entries(patch.g ?? {}) as [GroupName, Record<string, unknown>][]) {
    if (group === 'path') for (const f of ELBOW_PATH_FIELDS) if (!(f in fields)) delete out[f]
    for (const [f, v] of Object.entries(fields)) out[f] = structuredClone(v)
  }
  if (patch.c || patch.lobbyServer !== undefined) {
    const cd = { ...((el.customData as Record<string, unknown> | undefined) ?? {}) }
    if (patch.c) {
      const lobby = { ...((cd.lobby as Record<string, unknown> | undefined) ?? {}) }
      for (const [k, v] of Object.entries(patch.c)) {
        if (v === null) delete lobby[k]
        else lobby[k] = structuredClone(v)
      }
      if (Object.keys(lobby).length) cd.lobby = lobby
      else delete cd.lobby
    }
    if (patch.lobbyServer !== undefined) cd.lobbyServer = structuredClone(patch.lobbyServer)
    out.customData = Object.keys(cd).length ? cd : undefined
    if (out.customData === undefined) delete out.customData
  }
  if (patch.b) {
    const rm = new Set(patch.b.rm)
    const added = new Map(patch.b.add.map((r) => [r.id, r]))
    const kept = (
      (el.boundElements as { id: string; type: 'arrow' | 'text' }[] | null | undefined) ?? []
    ).filter((r) => !rm.has(r.id) && !added.has(r.id))
    const next = [
      ...kept,
      ...[...added.values()].filter((r) => !rm.has(r.id)).map((r) => ({ id: r.id, type: r.type })),
    ]
    out.boundElements = next.length ? next : null
  }
  return out as T
}
