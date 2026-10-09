// L8-1 and L8-2: from groups of notes to a plan of writes. Reads the board and decides where everything goes;
// writes nothing (./apply.ts does, in one transact). The layout is ./layout.ts (the theme cluster layout asked
// for columns), so the rules are the ones "Group into themes" keeps:
//  - the columns start where the notes were and go in the room they and their old headings occupied, clear
//    of everything that stays (other shapes and texts, a frame's heading, connectors that stay);
//  - a frame only grows, by what the columns need and no more; no note leaves its frame (each note is sorted
//    in the frame it is in: several frames selected give each its own columns);
//  - the headings an earlier sort made are replaced, never stacked (customData kind 'sort-label');
//  - the client moves only the notes (and their bound labels) and creates the headings: never an arrow's
//    geometry. A connector bound to a note that moves is re-snapped by the server in the same commit.
//
// A plan is built from notes that may be moved (./model.ts `eligibility`); the caller reads that again when it
// applies the plan.
import { type CanvasElement, items, type LobbyCanvas } from '../../canvas/api/index.ts'
import { FRAME_MARGIN, frameRegion, LABEL_GAP } from '../ai/layout.ts'
import {
  boxOf,
  isBoundLabel,
  isFrame,
  isLive,
  isNote,
  LABEL_PAD,
  layoutLabel,
  type Measure,
  type TextBlock,
  unionRects,
  withNameBand,
} from './geom.ts'
import { type ColumnsGroup, layoutColumns, type Rect } from './layout.ts'

/** The `customData.lobby.kind` of a heading a deterministic sort makes. */
export const SORT_LABEL_KIND = 'sort-label'
/** What an AI sort's heading is (aiCustomData prefixes `ai-`). */
export const AI_SORT_LABEL_KIND = 'ai-sort-label'
const LABEL_KINDS: ReadonlySet<string> = new Set([SORT_LABEL_KIND, AI_SORT_LABEL_KIND])

/** Columns a request may make at most (a heading each). */
export const MAX_COLUMNS = 40

export interface PlanGroup {
  readonly key: string
  readonly label: string
  readonly ids: readonly string[]
}

export interface PlannedLabel {
  readonly key: string
  /** scene position of the heading's top-left */
  readonly x: number
  readonly y: number
  /** the width it is wrapped to (its column's) */
  readonly width: number
  readonly block: TextBlock
  /** the words as typed (the heading's `originalText`) */
  readonly name: string
}

export interface PlannedMove {
  readonly id: string
  /** the bound label of the note, moved with it */
  readonly labelId: string | null
  /** where the note was when the plan was made, and where it goes (scene, top-left) */
  readonly fromX: number
  readonly fromY: number
  readonly x: number
  readonly y: number
}

export interface SpacePlan {
  /** the frame the notes are in, or null for the open canvas */
  readonly frameId: string | null
  /** headings an earlier sort made for these notes: deleted */
  readonly stale: readonly string[]
  /** what those headings said and where they were (scene), to tell a sort that changes nothing */
  readonly staleInfo: readonly {
    readonly id: string
    readonly x: number
    readonly y: number
    readonly text: string
  }[]
  readonly labels: readonly PlannedLabel[]
  readonly moves: readonly PlannedMove[]
  /** the frame's new size when the columns do not fit it */
  readonly grow: { readonly id: string; readonly width: number; readonly height: number } | null
  readonly columns: number
}

export interface ColumnsPlan {
  readonly spaces: readonly SpacePlan[]
  /** notes whose position changes */
  readonly moved: number
  /** headings made */
  readonly columns: number
}

interface Space {
  readonly frame: CanvasElement | null
  readonly ox: number
  readonly oy: number
}

const spaceOf = (frame: CanvasElement | null): Space => ({ frame, ox: frame?.x ?? 0, oy: frame?.y ?? 0 })

/** The frame a note is in (its own `frameId`, while that frame is on the board), or null. */
function frameOfNote(canvas: LobbyCanvas, note: CanvasElement): CanvasElement | null {
  if (!note.frameId) return null
  const f = canvas.get(note.frameId)
  return isLive(f) && isFrame(f) ? f : null
}

const inSpace = (canvas: LobbyCanvas, el: CanvasElement, space: Space): boolean =>
  (el.frameId ?? null) === (space.frame?.id ?? null) &&
  (!space.frame || el.id !== space.frame.id) &&
  !isBoundLabel(el) &&
  !canvas.isHidden(el.id)

const rectIn = (el: CanvasElement, space: Space): Rect => {
  const b = boxOf(el)
  return { x: b.x - space.ox, y: b.y - space.oy, w: b.w, h: b.h }
}

/** Everything in the space that stays where it is, as rectangles in the space. */
function obstaclesIn(
  canvas: LobbyCanvas,
  space: Space,
  moving: ReadonlySet<string>,
  near: Rect | null,
): Rect[] {
  const out: Rect[] = []
  for (const el of canvas.items()) {
    if (!isLive(el) || !inSpace(canvas, el, space) || moving.has(el.id)) continue
    // connectors attached to moving notes follow them: their old path is no obstacle
    if (el.type === 'arrow') {
      const ends = items.arrowEnds(el)
      if ((ends.start && moving.has(ends.start)) || (ends.end && moving.has(ends.end))) continue
    }
    const b = rectIn(el, space)
    const r = el.type === 'frame' ? withNameBand(b) : b
    if (near && (r.x > near.x + near.w || r.y > near.y + near.h || r.x + r.w < near.x || r.y + r.h < near.y))
      continue
    out.push(r)
  }
  return out
}

/**
 * Headings an earlier sort made for the notes about to move: a heading with a moving note just under it and no
 * staying note in its column (the staying notes below it that no other heading stands over). A heading that
 * still labels notes which stay is kept.
 */
function staleHeadings(
  canvas: LobbyCanvas,
  space: Space,
  noteRects: readonly Rect[],
  moving: ReadonlySet<string>,
): CanvasElement[] {
  const band = LABEL_GAP * 3 + 8
  const heads: { el: CanvasElement; r: Rect }[] = []
  for (const el of canvas.items()) {
    if (!isLive(el) || el.type !== 'text' || el.containerId || !inSpace(canvas, el, space)) continue
    const kind = items.lobbyValue(el, 'kind')
    if (typeof kind === 'string' && LABEL_KINDS.has(kind)) heads.push({ el, r: rectIn(el, space) })
  }
  const staying = canvas
    .items()
    .filter((e) => isLive(e) && isNote(e) && inSpace(canvas, e, space) && !moving.has(e.id))
    .map((e) => rectIn(e, space))
  const sideways = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w
  return heads
    .filter(({ r }) => {
      const under = (n: Rect) => sideways(n, r) && n.y >= r.y && n.y <= r.y + r.h + band
      if (!noteRects.some(under)) return false
      const mine = (n: Rect) =>
        sideways(n, r) &&
        n.y >= r.y &&
        !heads.some((o) => o.r !== r && sideways(n, o.r) && o.r.y > r.y && o.r.y <= n.y)
      return !staying.some(mine)
    })
    .map((h) => h.el)
}

/** Reading order inside a group: rows of 120, then left to right (where the notes were). */
const readingOrder = (a: { r: Rect }, b: { r: Rect }) =>
  Math.floor(a.r.y / 120) - Math.floor(b.r.y / 120) || a.r.x - b.r.x

/** The plan for the notes of one space. */
function planSpace(
  canvas: LobbyCanvas,
  space: Space,
  groups: readonly { key: string; label: string; notes: CanvasElement[] }[],
  measure: Measure,
): SpacePlan {
  const all = groups.flatMap((g) => g.notes)
  const moving = new Set(all.map((n) => n.id))
  const rects = new Map(all.map((n) => [n.id, rectIn(n, space)]))
  const stale = staleHeadings(canvas, space, [...rects.values()], moving)
  // their place counts as the notes' own: sorting the same notes again gives the same result
  const staleRects = stale.map((s) => rectIn(s, space))
  const notesBounds = unionRects([...rects.values(), ...staleRects]) as Rect
  const widest = Math.max(...[...rects.values()].map((r) => r.w))
  // in a frame the columns start inside its margins (the notes may lie over its edge)
  const anchor = space.frame
    ? {
        x: Math.max(FRAME_MARGIN, notesBounds.x),
        y: Math.max(FRAME_MARGIN, Math.min(notesBounds.y, space.frame.height - FRAME_MARGIN)),
      }
    : { x: notesBounds.x, y: notesBounds.y }
  // on the open canvas: wide enough for the columns to stand side by side
  const trueColumnsW = groups.length * widest + (groups.length - 1) * 64
  const region = space.frame
    ? frameRegion({ w: space.frame.width, h: space.frame.height }, anchor, widest)
    : { minX: anchor.x, maxX: anchor.x + Math.min(6000, Math.max(notesBounds.w, trueColumnsW)), maxY: null }
  const near: Rect | null = space.frame
    ? null
    : { x: anchor.x - 400, y: anchor.y - 400, w: region.maxX - anchor.x + 1600, h: notesBounds.h + 6000 }
  const obstacles = obstaclesIn(canvas, space, new Set([...moving, ...stale.map((s) => s.id)]), near)

  const ordered = groups.map((g) => ({
    key: g.key,
    label: g.label,
    notes: g.notes
      .map((n) => ({ n, r: rects.get(n.id) as Rect }))
      .sort(readingOrder)
      .map((x) => x.n),
  }))
  const columnGroups: ColumnsGroup[] = ordered.map((g) => ({
    key: g.key,
    notes: g.notes.map((n) => {
      const r = rects.get(n.id) as Rect
      return { id: n.id, w: r.w, h: r.h }
    }),
  }))
  const labelH = (index: number, w: number) =>
    layoutLabel(measure, ordered[index]?.label ?? '', Math.max(40, w - 4)).height + LABEL_PAD
  const layout = layoutColumns({ groups: columnGroups, labelH, anchor, region, obstacles })

  const labels: PlannedLabel[] = layout.columns.map((c) => {
    const name = ordered[c.index]?.label ?? ''
    return {
      key: c.key,
      x: space.ox + c.label.x,
      y: space.oy + c.label.y,
      width: c.label.w,
      block: layoutLabel(measure, name, Math.max(40, c.label.w - 4)),
      name,
    }
  })
  const moves: PlannedMove[] = []
  for (const c of layout.columns)
    for (const p of c.notes) {
      const el = canvas.get(p.id)
      const from = rects.get(p.id)
      if (!el || !from) continue
      // `from` is the note's box (rotation included); the element's own x, y move by the same difference
      const dx = p.x - from.x
      const dy = p.y - from.y
      moves.push({
        id: p.id,
        labelId: items.labelOf(el, (x) => canvas.get(x))?.id ?? null,
        fromX: el.x,
        fromY: el.y,
        x: el.x + dx,
        y: el.y + dy,
      })
    }
  const grow =
    space.frame && (layout.overflow.bottom > 0 || layout.overflow.right > 0)
      ? {
          id: space.frame.id,
          width: space.frame.width + Math.ceil(layout.overflow.right),
          height: space.frame.height + Math.ceil(layout.overflow.bottom),
        }
      : null
  return {
    frameId: space.frame?.id ?? null,
    stale: stale.map((s) => s.id),
    staleInfo: stale.map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      text: String((s as { originalText?: string }).originalText ?? ''),
    })),
    labels,
    moves,
    grow,
    columns: labels.length,
  }
}

/**
 * The plan that sorts `groups` (each a heading and the ids of its notes, every one a note that may move) into
 * columns: one set of columns per frame the notes are in, and one for the open canvas.
 */
export function planColumns(
  canvas: LobbyCanvas,
  groups: readonly PlanGroup[],
  measure: Measure,
): ColumnsPlan {
  type Resolved = { key: string; label: string; notes: CanvasElement[] }
  const bySpace = new Map<string | null, { frame: CanvasElement | null; groups: Resolved[] }>()
  for (const g of groups) {
    const here = new Map<string | null, CanvasElement[]>()
    for (const id of g.ids) {
      const el = canvas.get(id)
      if (!isLive(el)) continue
      const frame = frameOfNote(canvas, el)
      const k = frame?.id ?? null
      if (!bySpace.has(k)) bySpace.set(k, { frame, groups: [] })
      here.set(k, [...(here.get(k) ?? []), el])
    }
    for (const [k, notes] of here) bySpace.get(k)?.groups.push({ key: g.key, label: g.label, notes })
  }
  const spaces: SpacePlan[] = []
  for (const { frame, groups: gs } of bySpace.values()) {
    if (!gs.length) continue
    spaces.push(planSpace(canvas, spaceOf(frame), gs, measure))
  }
  const moved = spaces.reduce(
    (n, s) => n + s.moves.filter((m) => m.x !== m.fromX || m.y !== m.fromY).length,
    0,
  )
  return { spaces, moved, columns: spaces.reduce((n, s) => n + s.columns, 0) }
}

/** Whether applying `plan` would change nothing: no note moves, no frame grows, and the headings are the same. */
export function isNoop(plan: ColumnsPlan): boolean {
  if (plan.moved > 0) return false
  return plan.spaces.every(
    (s) =>
      s.grow === null &&
      s.labels.length === s.staleInfo.length &&
      s.labels.every((l) =>
        s.staleInfo.some((o) => o.text === l.name && Math.abs(o.x - l.x) < 1 && Math.abs(o.y - l.y) < 1),
      ),
  )
}
