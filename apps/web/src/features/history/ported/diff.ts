// What changed between a checkpoint and the live board (wave L, L7-1; owner W7): the time-travel preview's
// outlines and its counted list. Pure (Node-tested), no engine import: elements are read field by field.
//
// Elements are compared by id, then by version (an equal version is the same element), then by what changed:
//  - `removed`: in the checkpoint, not on the board now (a restore brings it back);
//  - `added`: on the board now, not in the checkpoint;
//  - `geometry`: moved, resized, rotated, or its points changed (beyond GEOMETRY_TOLERANCE_PX);
//  - `text`: its words changed (a note's or a shape's label counts for its container; a frame's name);
//  - `style`: anything else a person sets (colours, stroke, font, lock, link, membership, ...);
//  - `derived`: an arrow whose only change is where its bound ends are, because a target it is bound to moved
//    (the server re-derives them; canvas-schema groups.ts SERVER_DERIVED), so it is not "changed".
// A bound label is part of its container, never an entry of its own. Hidden mind-map branches are respected:
// what is hidden on either side (a topic under a collapsed topic and the line into it; the board's own hidden
// set) is not compared, so collapsing a branch never reads as removing it.

/** canvas-schema limits.ts GEOMETRY_TOLERANCE_PX (restated: this file stays engine- and schema-free). */
export const DIFF_TOLERANCE_PX = 0.5

export type DiffKind = 'removed' | 'added' | 'geometry' | 'text' | 'style' | 'derived'
/** The order of the counted list (what a restore would undo first). */
export const DIFF_KINDS: readonly DiffKind[] = ['removed', 'added', 'geometry', 'text', 'style', 'derived']

export interface DiffBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface DiffEntry {
  readonly id: string
  readonly kind: DiffKind
  /** the element's type (`stickynote`, `arrow`, ...) */
  readonly type: string
  /** a short name for the list: its words or its kind ("Note “Ship it”", "Arrow") */
  readonly name: string
  /** where to outline it in the checkpoint's scene: its checkpoint place (its place now when added) */
  readonly bounds: DiffBounds
}

export interface CheckpointDiff {
  readonly entries: readonly DiffEntry[]
  readonly counts: Readonly<Record<DiffKind, number>>
  /** elements left out because a mind-map branch hides them on one side */
  readonly hidden: number
}

// biome-ignore lint/suspicious/noExplicitAny: elements are JSON, read field by field
type El = Record<string, any> & { id: string; type: string }

const isEl = (v: unknown): v is El =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as El).id === 'string' &&
  typeof (v as El).type === 'string'
const liveOnly = (list: readonly unknown[]): El[] => list.filter(isEl).filter((e) => e.isDeleted !== true)
const isLabel = (e: El) => e.type === 'text' && typeof e.containerId === 'string' && e.containerId.length > 0
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const lobbyOf = (e: El): Record<string, unknown> => {
  const l = isObject(e.customData) ? e.customData.lobby : undefined
  return isObject(l) ? l : {}
}

/**
 * The ids a collapsed mind-map topic hides (customData.lobby.mindmap {rootId, parentId, collapsed}): every topic
 * with a collapsed ancestor, the lines into them (lobby.mindmapEdge.childId) and their labels.
 */
export function hiddenBranchIds(elements: readonly unknown[]): Set<string> {
  const all = liveOnly(elements)
  const parent = new Map<string, string | null>()
  const collapsed = new Set<string>()
  for (const e of all) {
    const m = lobbyOf(e).mindmap
    if (!isObject(m)) continue
    parent.set(e.id, typeof m.parentId === 'string' ? m.parentId : null)
    if (m.collapsed === true) collapsed.add(e.id)
  }
  const hidden = new Set<string>()
  if (!collapsed.size) return hidden
  for (const id of parent.keys()) {
    let p = parent.get(id) ?? null
    for (let guard = 0; p !== null && guard < 10_000; guard++) {
      if (collapsed.has(p)) {
        hidden.add(id)
        break
      }
      p = parent.get(p) ?? null
    }
  }
  for (const e of all) {
    const edge = lobbyOf(e).mindmapEdge
    if (isObject(edge) && typeof edge.childId === 'string' && hidden.has(edge.childId)) hidden.add(e.id)
  }
  for (const e of all) if (isLabel(e) && hidden.has(e.containerId)) hidden.add(e.id)
  return hidden
}

/** The element's box in the scene (a linear element's from its points). */
export function boundsOf(e: El): DiffBounds {
  if (
    Array.isArray(e.points) &&
    e.points.length &&
    (e.type === 'arrow' || e.type === 'line' || e.type === 'freedraw')
  ) {
    let x1 = Number.POSITIVE_INFINITY
    let y1 = Number.POSITIVE_INFINITY
    let x2 = Number.NEGATIVE_INFINITY
    let y2 = Number.NEGATIVE_INFINITY
    for (const p of e.points as unknown[]) {
      if (!Array.isArray(p)) continue
      x1 = Math.min(x1, num(p[0]))
      y1 = Math.min(y1, num(p[1]))
      x2 = Math.max(x2, num(p[0]))
      y2 = Math.max(y2, num(p[1]))
    }
    if (Number.isFinite(x1))
      return { x: num(e.x) + x1, y: num(e.y) + y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) }
  }
  return { x: num(e.x), y: num(e.y), width: Math.max(1, num(e.width)), height: Math.max(1, num(e.height)) }
}

const NAMES: Record<string, string> = {
  stickynote: 'Note',
  rectangle: 'Rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  text: 'Text',
  arrow: 'Arrow',
  line: 'Line',
  freedraw: 'Drawing',
  image: 'Image',
  frame: 'Frame',
}
const words = (s: unknown, max = 40): string => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// ---- field comparison ---------------------------------------------------------------------------------

/** Fields every write changes or that follow from others: never a change of their own. */
const BOOKKEEPING = new Set([
  'version',
  'versionNonce',
  'updated',
  'created',
  'seed',
  'status',
  'boundElements',
  'index',
])
/** Geometry: where an element is and what shape it has. */
const GEOMETRY = new Set([
  'x',
  'y',
  'width',
  'height',
  'angle',
  'points',
  'scale',
  'crop',
  'baseHeight',
  'fixedSegments',
])
/** A text's own words (its `text` is the wrapped layout of them). */
const TEXT = new Set(['originalText', 'text', 'name'])
/** Fields the server derives for a bound arrow: its ends' place, its route (not a change by itself). */
const ARROW_BIND = new Set(['startBinding', 'endBinding'])

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const near = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= DIFF_TOLERANCE_PX
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => near(v, b[i]))
  if (isObject(a) && isObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    for (const k of keys) if (!near(a[k], b[k])) return false
    return true
  }
  return same(a, b)
}

/** The scene point of point `i` of a linear element (rotation about its box's centre, as the engine does). */
function scenePoint(e: El, i: number): [number, number] {
  const p = (e.points as unknown[])[i] as unknown[]
  const lx = num(e.x) + num(p?.[0])
  const ly = num(e.y) + num(p?.[1])
  const angle = num(e.angle)
  if (!angle) return [lx, ly]
  const b = boundsOf(e)
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [cx + (lx - cx) * c - (ly - cy) * s, cy + (lx - cx) * s + (ly - cy) * c]
}

/**
 * What a person chose about an arrow's geometry (canvas-schema groups.ts `userSetGeometry`, restated): its
 * unbound points in the scene; for an elbow arrow its unbound ends and its fixed segments' cross-axis places.
 */
function userSet(e: El): unknown {
  const pts = Array.isArray(e.points) ? (e.points as unknown[]) : []
  const n = pts.length
  if (e.elbowed) {
    const segs = (Array.isArray(e.fixedSegments) ? e.fixedSegments : []) as {
      start?: unknown[]
      end?: unknown[]
      index?: number
    }[]
    return {
      start: e.startBinding || !n ? null : scenePoint(e, 0),
      end: e.endBinding || !n ? null : scenePoint(e, n - 1),
      segments: [...segs]
        .sort((a, b) => num(a.index) - num(b.index))
        .map((s) => {
          const vertical =
            Math.abs(num(s.start?.[0]) - num(s.end?.[0])) <= Math.abs(num(s.start?.[1]) - num(s.end?.[1]))
          return vertical ? ['v', num(e.x) + num(s.start?.[0])] : ['h', num(e.y) + num(s.start?.[1])]
        }),
    }
  }
  const start = e.startBinding?.elementId
  const end = e.endBinding?.elementId
  if (start && end && start === end) {
    const s = scenePoint(e, 0)
    const rel: [number, number][] = []
    for (let i = 1; i < n - 1; i++) {
      const p = scenePoint(e, i)
      rel.push([p[0] - s[0], p[1] - s[1]])
    }
    return { selfloop: rel }
  }
  const out: [number, number, number][] = []
  for (let i = 0; i < n; i++) {
    if ((i === 0 && start) || (i === n - 1 && end)) continue
    const p = scenePoint(e, i)
    out.push([i, p[0], p[1]])
  }
  return { points: out, n }
}

/** What kind of change `now` is of `then` (null: none worth showing). Labels are passed for containers. */
function changeOf(
  then: El,
  now: El,
  labels: { old: El | null; cur: El | null },
  moved: (id: unknown) => boolean,
): DiffKind | null {
  const keys = new Set([...Object.keys(then), ...Object.keys(now)])
  let geometry = false
  let text = false
  let style = false
  const arrow = then.type === 'arrow' || then.type === 'line'
  for (const k of keys) {
    if (BOOKKEEPING.has(k)) continue
    if (k === 'customData') {
      // what people set in it (tags, alt text, a mind map's place); +1s and authorship are not "changes"
      const a = { ...lobbyOf(then) }
      const b = { ...lobbyOf(now) }
      for (const o of [a, b]) for (const key of Object.keys(o)) if (key.startsWith('plusOne:')) delete o[key]
      if (!same(a, b)) style = true
      continue
    }
    if (ARROW_BIND.has(k)) {
      if ((then[k]?.elementId ?? null) !== (now[k]?.elementId ?? null)) geometry = true
      continue
    }
    if (GEOMETRY.has(k)) {
      if (!near(then[k], now[k])) geometry = true
      continue
    }
    if (TEXT.has(k)) {
      if (k === 'text' && then.type === 'text') continue // the layout of originalText
      if (!same(then[k], now[k])) text = true
      continue
    }
    if (!same(then[k], now[k])) style = true
  }
  if (labels.old || labels.cur) {
    const a = labels.old?.originalText ?? labels.old?.text ?? ''
    const b = labels.cur?.originalText ?? labels.cur?.text ?? ''
    if (a !== b) text = true
  }
  if (text) return 'text'
  if (geometry && arrow && then.type === 'arrow') {
    // only the bound ends moved, because a target moved: derived by the server
    const bindingsSame =
      (then.startBinding?.elementId ?? null) === (now.startBinding?.elementId ?? null) &&
      (then.endBinding?.elementId ?? null) === (now.endBinding?.elementId ?? null)
    const targetMoved = moved(then.startBinding?.elementId) || moved(then.endBinding?.elementId)
    if (bindingsSame && targetMoved && near(userSet(then), userSet(now))) return style ? 'style' : 'derived'
  }
  if (geometry) return 'geometry'
  if (style) return 'style'
  return null
}

/** Whether a bindable target's place or size changed (what re-derives the arrows bound to it). */
function targetMoved(then: El | undefined, now: El | undefined): boolean {
  if (!then || !now) return true
  for (const k of ['x', 'y', 'width', 'height', 'angle']) if (!near(then[k], now[k])) return true
  return false
}

/**
 * The diff of a checkpoint's elements against the board now. `liveHidden`: what the board hides now (the
 * canvas's hidden set: a collapsed branch, a feature's own); the mind-map branches are also computed from each
 * side's own data.
 */
export function diffCheckpoint(
  checkpoint: readonly unknown[],
  live: readonly unknown[],
  opts: { liveHidden?: (id: string) => boolean } = {},
): CheckpointDiff {
  const then = liveOnly(checkpoint)
  const now = liveOnly(live)
  const thenById = new Map(then.map((e) => [e.id, e]))
  const nowById = new Map(now.map((e) => [e.id, e]))
  const hiddenThen = hiddenBranchIds(then)
  const hiddenNow = hiddenBranchIds(now)
  const hidden = (id: string) => hiddenThen.has(id) || hiddenNow.has(id) || !!opts.liveHidden?.(id)
  const labelOf = (list: El[]) => {
    const out = new Map<string, El>()
    for (const e of list) if (isLabel(e) && !out.has(e.containerId)) out.set(e.containerId, e)
    return (id: string) => out.get(id) ?? null
  }
  const thenLabel = labelOf(then)
  const nowLabel = labelOf(now)
  const nameOf = (e: El, label: El | null) => {
    const kind = NAMES[e.type] ?? 'Object'
    const w =
      e.type === 'frame'
        ? words(e.name)
        : e.type === 'text'
          ? words(e.originalText ?? e.text)
          : words(label?.originalText ?? label?.text)
    return w ? `${kind} “${w}”` : kind
  }
  const moved = (id: unknown) => typeof id === 'string' && targetMoved(thenById.get(id), nowById.get(id))

  const entries: DiffEntry[] = []
  let hiddenCount = 0
  const push = (e: El, kind: DiffKind, label: El | null, at: El) =>
    entries.push({ id: e.id, kind, type: e.type, name: nameOf(e, label), bounds: boundsOf(at) })
  for (const e of then) {
    if (isLabel(e)) continue
    if (hidden(e.id)) {
      hiddenCount++
      continue
    }
    const cur = nowById.get(e.id)
    if (!cur || cur.type !== e.type) {
      push(e, 'removed', thenLabel(e.id), e)
      continue
    }
    const labels = { old: thenLabel(e.id), cur: nowLabel(e.id) }
    if (
      e.version === cur.version &&
      e.version !== undefined &&
      (labels.old?.version ?? null) === (labels.cur?.version ?? null)
    )
      continue
    const kind = changeOf(e, cur, labels, moved)
    if (kind) push(e, kind, labels.old, e)
  }
  for (const e of now) {
    if (isLabel(e) || thenById.has(e.id)) continue
    if (hidden(e.id)) {
      hiddenCount++
      continue
    }
    push(e, 'added', nowLabel(e.id), e)
  }
  const counts = Object.fromEntries(DIFF_KINDS.map((k) => [k, 0])) as Record<DiffKind, number>
  for (const e of entries) counts[e.kind]++
  entries.sort((a, b) => DIFF_KINDS.indexOf(a.kind) - DIFF_KINDS.indexOf(b.kind) || (a.id < b.id ? -1 : 1))
  return { entries, counts, hidden: hiddenCount }
}

/** What a restore of `entry` would bring back: everything but what was added since and derived arrows. */
export const isRestorable = (entry: Pick<DiffEntry, 'kind'>) =>
  entry.kind !== 'added' && entry.kind !== 'derived'

const PHRASES: Record<DiffKind, [string, string]> = {
  removed: ['removed since', 'removed since'],
  added: ['added since', 'added since'],
  geometry: ['moved or resized', 'moved or resized'],
  text: ['with other words now', 'with other words now'],
  style: ['restyled or otherwise changed', 'restyled or otherwise changed'],
  derived: ['connector that only followed its shapes', 'connectors that only followed their shapes'],
}

/** "2 removed since · 1 moved or resized" (the counted list's summary, for the screen and screen readers). */
export function diffSummary(diff: Pick<CheckpointDiff, 'counts'>): string {
  const parts: string[] = []
  for (const k of DIFF_KINDS) {
    const n = diff.counts[k]
    if (!n) continue
    const [one, many] = PHRASES[k]
    parts.push(`${n} ${n === 1 ? one : many}`)
  }
  return parts.length ? parts.join(' · ') : 'No differences from the board now'
}
