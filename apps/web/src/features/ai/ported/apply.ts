// OWNER: 3h. Applies an AI plan to the board on the Excalidraw board page (plan §4.7; the tldraw twin is
// ../apply.ts) as ordinary canvas edits: everything inside ONE `canvas.transact`, so Ctrl+Z undoes the
// whole result in one step and collaborators receive it through the board's sync like any edit. Only
// plain text goes in. Every element AI makes carries `customData.lobby.ai` (`{by}`: create-only, the
// server checks `by` is the writer, canvas-schema custom-data.ts) and `customData.lobby.kind`
// (`ai-theme-label`, `ai-summary`, `ai-heading`, `ai-idea`, `ai-action-item`) so a later run can
// recognise it. The layout math is shared with the tldraw page (../layout.ts), in the space of the frame
// the results belong in (scene coordinates less the frame's origin), exactly as there.
//
// - Group into themes: the notes the plan names (still there, still notes, not locked) move into
//   labelled clusters in the space they occupied and to its right and below, clear of everything that
//   stays. Labels are text measured before the write (`canvas.text.measure`, the server's metrics), so
//   one pass places them. A frame grows only when the clusters cannot fit. Labels a previous run made
//   above these notes are replaced, so grouping twice never stacks labels. Notes beside a map in their
//   frame (connectors and the cards they join, as on the Lobby tour's Brainstorm) are grouped under the
//   map instead, the frame growing downward (DANA-10). A note moves with its label. The labels of
//   clusters side by side share one line (W5-04). Frame membership is read from where notes lie when it
//   is missing (W5-04: a note made with N inside a frame may not be its member, W5-01): the clusters go
//   to the frame most of the notes are in, which a loose note joins, and a note of another frame is
//   grouped in its own frame; no note leaves its frame.
// - Summarize, when an editor adds it from the summary panel: a pale card (a rectangle with its words
//   as the bound label, "Summary" on the first line).
// - Action items / Generate ideas: a heading and a grid of new sticky notes.
// Both stay in the frame the target is, or is in (DANA-07): beside the selection when the frame has room
// there, else at the end of the frame (under its content, aligned with it), the frame growing downwards
// unless that would run into a neighbour. Outside frames: beside the selection, clear of frame labels,
// or in the middle of the view when nothing is selected.
//
// Differences from the tldraw page (the engine has no rich text, no parent spaces and auto-fitting notes):
// labels and headings are not bold; notes keep their square size (their words shrink to fit, they do not
// grow); a regroup recognises an earlier run's label by where it sits (directly above notes that move
// now), since `customData.lobby.ai` has no room for the list of notes it labelled.

import { LOBBY_INK, LOBBY_PALETTE, type LobbyColorName } from '@draftroom/board-ops/elements'
import type { AiTheme } from '@draftroom/contracts'
import { type CanvasElement, items, type LobbyCanvas, type LobbyTx } from '../../../canvas/api/index.ts'
import {
  alignRows,
  appendInFrame,
  BESIDE_GAP,
  bottom,
  type ClusterInput,
  collides,
  FRAME_LABEL_BAND,
  FRAME_MARGIN,
  fitCols,
  frameRegion,
  grid,
  LABEL_GAP,
  layoutThemes,
  openRegion,
  placeAround,
  placeBeside,
  type Rect,
  right,
  type Size,
  type ThemesLayout,
  type ThemesLayoutInput,
  union,
} from '../layout.ts'
import { AI_KIND_PREFIX, aiCustomData } from './provenance.ts'
import { SHIMMER_MAX_TILES, type ShimmerPlan, type ShimmerTile } from './shimmer.ts'
import {
  type AiTarget,
  type FrameIndex,
  frameIndex,
  frameOfElement,
  homeFrameOf,
  idOfRef,
  isLive,
  isNote,
} from './target.ts'

/** Lobby's sans (Nunito), the note font on the new canvas. */
export const FONT_FAMILY = 6
/** tldraw's `m` text size (a theme label, a heading). */
const LABEL_FONT_SIZE = 24
/** tldraw's `s` size (the summary card's words). */
const SUMMARY_FONT_SIZE = 18
const SUMMARY_W = 560
const NOTE_CELL = 200
/** Excalidraw's padding between a container and its bound label (BOUND_TEXT_PADDING). */
const BOUND_TEXT_PADDING = 5

/** The kinds this module makes (wave L: an answer note, the recap's pieces; ../recap/apply.ts makes those). */
export type AiKind =
  | 'theme-label'
  | 'summary'
  | 'heading'
  | 'idea'
  | 'action-item'
  | 'answer'
  | 'recap-heading'
  | 'recap-item'
  | 'recap-table'

/**
 * The `customData.lobby` an AI-made element is created with (./provenance.ts, the one public.ts re-exports):
 * `lobby.ai = { by, run }` (wave L: `run` is the result's run id; none from a wave K api) and the `ai-` kind.
 */
export { aiCustomData }

/** What an AI-made element is (null for anything else). */
export function aiKindOf(el: CanvasElement | undefined): AiKind | null {
  if (!el || items.lobbyValue(el, 'ai') === undefined) return null
  const kind = items.lobbyValue(el, 'kind')
  return typeof kind === 'string' && kind.startsWith(AI_KIND_PREFIX)
    ? (kind.slice(AI_KIND_PREFIX.length) as AiKind)
    : null
}

// ---- reading the board -----------------------------------------------------------------------------

const isLabel = (el: CanvasElement) => el.type === 'text' && !!el.containerId

/** The space of a frame (or the page): scene coordinates less its origin. */
interface Space {
  frame: CanvasElement | null
  ox: number
  oy: number
  /**
   * W5-04: in a frame's space, loose elements lying in the frame (no `frameId`, as a note made with N)
   * count as in it: they are in the way, and grouping them brings them in.
   */
  index?: FrameIndex
}
const spaceOf = (frame: CanvasElement | null, index?: FrameIndex): Space => ({
  frame,
  ox: frame?.x ?? 0,
  oy: frame?.y ?? 0,
  index,
})

/** Axis-aligned scene bounds of an element (rotation included) in `space`. */
function rectIn(canvas: LobbyCanvas, id: string, space: Space): Rect | null {
  const b = canvas.bounds(id)
  return b ? { x: b.x - space.ox, y: b.y - space.oy, w: b.width, h: b.height } : null
}

/**
 * The objects directly in `space` (a frame's children, or everything outside frames), labels left out.
 * A frame's space with an index also holds the loose elements lying in it (`frameOfElement`).
 */
function objectsIn(canvas: LobbyCanvas, space: Space): CanvasElement[] {
  const frameId = space.frame?.id ?? null
  const { index } = space
  return canvas
    .items()
    .filter(
      (e) =>
        !isLabel(e) &&
        e.id !== frameId &&
        !canvas.isHidden(e.id) &&
        ((e.frameId ?? null) === frameId ||
          (!!frameId && !!index && !e.frameId && frameOfElement(canvas, e, index)?.id === frameId)),
    )
}

/** Everything in `space` that stays where it is, as rectangles in that space. */
function obstaclesIn(canvas: LobbyCanvas, space: Space, moving: ReadonlySet<string>, near?: Rect): Rect[] {
  const out: Rect[] = []
  for (const el of objectsIn(canvas, space)) {
    if (moving.has(el.id)) continue
    // Connectors attached to moving notes follow them: their old path is no obstacle.
    if (el.type === 'arrow') {
      const ends = items.arrowEnds(el)
      if ((ends.start && moving.has(ends.start)) || (ends.end && moving.has(ends.end))) continue
    }
    const b = rectIn(canvas, el.id, space)
    if (!b) continue
    // A frame's name label sits just over its top edge: nothing goes there either (DANA-07).
    const r = el.type === 'frame' ? { ...b, y: b.y - FRAME_LABEL_BAND, h: b.h + FRAME_LABEL_BAND } : b
    if (near && (r.x > near.x + near.w || r.y > near.y + near.h || r.x + r.w < near.x || r.y + r.h < near.y))
      continue
    out.push(r)
  }
  return out
}

/** `text` wrapped to `maxWidth` (greedy by words; a word longer than a line is cut), as lines. */
export function wrapLines(
  measure: (line: string) => number,
  text: string,
  maxWidth: number | null,
): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (maxWidth === null || measure(next) <= maxWidth) {
        line = next
        continue
      }
      if (line) out.push(line)
      // a single word wider than the line: cut it where it no longer fits
      let rest = word
      while (maxWidth !== null && rest.length > 1 && measure(rest) > maxWidth) {
        let n = rest.length - 1
        while (n > 1 && measure(rest.slice(0, n)) > maxWidth) n--
        out.push(rest.slice(0, n))
        rest = rest.slice(n)
      }
      line = rest
    }
    out.push(line)
  }
  return out
}

export interface TextBlock {
  /** the words as the element stores them (wrapped) */
  text: string
  width: number
  height: number
}

export function layoutText(
  canvas: LobbyCanvas,
  text: string,
  fontSize: number,
  maxWidth: number | null,
): TextBlock {
  const style = { fontFamily: FONT_FAMILY, fontSize }
  const lines = wrapLines((l) => canvas.text.measure(l, style).width, text, maxWidth)
  const wrapped = lines.join('\n')
  const m = canvas.text.measure(wrapped || ' ', style)
  return { text: wrapped, width: Math.ceil(m.width), height: Math.ceil(m.height) }
}

/** Element ids AI creates (ELEMENT_ID_PATTERN); a note's label id is the note's with `.t`. */
export function newId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return `ai${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
}

/** Moves an element and its bound label by (dx, dy): the engine keeps a label's own x, y. */
function moveBy(canvas: LobbyCanvas, tx: LobbyTx, el: CanvasElement, dx: number, dy: number) {
  if (!dx && !dy) return
  tx.update(el.id, { x: el.x + dx, y: el.y + dy })
  const label = items.labelOf(el, (id) => canvas.get(id))
  if (label) tx.update(label.id, { x: label.x + dx, y: label.y + dy })
}

/**
 * A frame grown to `h` would not run into anything beside or below it on the page (`moving`: what goes
 * into it in the same step, so no obstacle).
 */
function mayGrow(
  canvas: LobbyCanvas,
  frame: CanvasElement,
  h: number,
  moving: ReadonlySet<string> = new Set(),
): boolean {
  const page = spaceOf(null)
  const now = rectIn(canvas, frame.id, page)
  if (!now) return false
  const grown = { x: now.x, y: now.y, w: now.w, h: now.h + (h - frame.height) }
  const extra = { x: grown.x, y: now.y + now.h, w: grown.w, h: grown.h - now.h }
  return obstaclesIn(canvas, page, new Set([frame.id, ...moving]), grown).every(
    (o) => !(collides(extra, o, BESIDE_GAP / 2) && !collides(now, o)),
  )
}

/** DANA-10: between an existing map and the clusters grouped under it. */
const MAP_GAP = 96

/**
 * DANA-10: the map the notes sit beside, if any: the connectors that stay in `space` (attached at both
 * ends to objects that stay there) and the objects they join, as one rectangle. Only when it shares the
 * notes' rows (beside them, as the tour's theme cards are).
 */
function mapBesideNotes(
  canvas: LobbyCanvas,
  space: Space,
  moving: ReadonlySet<string>,
  notes: Rect,
): Rect | null {
  const parts: Rect[] = []
  const inSpace = new Set(objectsIn(canvas, space).map((e) => e.id))
  for (const el of objectsIn(canvas, space)) {
    if (el.type !== 'arrow' || moving.has(el.id)) continue
    const { start, end } = items.arrowEnds(el)
    if (!start || !end || moving.has(start) || moving.has(end)) continue
    if (!inSpace.has(start) || !inSpace.has(end)) continue
    for (const id of [el.id, start, end]) {
      const r = rectIn(canvas, id, space)
      if (r) parts.push(r)
    }
  }
  const map = union(parts)
  if (!map) return null
  return map.y < bottom(notes) && notes.y < bottom(map) ? map : null
}

/**
 * DANA-10: the clusters under a map, as wide as the frame at most (it grows downward only):
 * layoutThemes' own choice when that fits, else the lowest of the uniform column counts that fit.
 */
function narrowestFit(input: ThemesLayoutInput, counts: readonly number[]): ThemesLayout | null {
  const own = layoutThemes(input)
  if (own.overflow.right <= 0) return own
  let pick: ThemesLayout | null = null
  for (const c of [4, 3, 2, 1]) {
    const l = layoutThemes(input, { cols: counts.map((n) => Math.max(1, Math.min(c, n))) })
    if (l.overflow.right > 0) continue
    if (!pick || l.bounds.h < pick.bounds.h) pick = l
  }
  return pick
}

/**
 * Labels an earlier run made for these notes (they would label the old arrangement): AI theme labels in
 * `space` sitting just above a moving note that overlaps them sideways, with no staying note there.
 */
function staleThemeLabels(
  canvas: LobbyCanvas,
  space: Space,
  moving: ReadonlySet<string>,
  rects: ReadonlyMap<string, Rect>,
): CanvasElement[] {
  const objects = objectsIn(canvas, space)
  const staying = objects
    .filter((e) => isNote(e) && !moving.has(e.id))
    .map((e) => rectIn(canvas, e.id, space))
    .filter((r): r is Rect => !!r)
  const out: CanvasElement[] = []
  for (const el of objects) {
    if (aiKindOf(el) !== 'theme-label') continue
    const r = rectIn(canvas, el.id, space)
    if (!r) continue
    const band = { x: r.x, y: bottom(r), w: r.w, h: LABEL_GAP * 3 + 8 }
    const below = (n: Rect) => n.x < right(band) && band.x < right(n) && n.y >= r.y && n.y <= bottom(band)
    if ([...rects.values()].some(below) && !staying.some(below)) out.push(el)
  }
  return out
}

export interface ThemesOutcome {
  moved: number
  themes: number
  grew: boolean
  skipped: number
  /** every element the step wrote (labels made and replaced, notes moved, the frame grown) */
  written: string[]
}

/** What "Group into themes" would write for `themes` right now, per space (null: no note can move any more). */
function themesPlans(
  canvas: LobbyCanvas,
  themes: readonly AiTheme[],
): { plans: ThemesPlan[]; wanted: number; all: CanvasElement[] } | null {
  const seen = new Set<string>()
  const groups = themes
    .map((t, theme) => ({
      theme,
      name: t.name,
      notes: t.noteIds
        .map((ref) => canvas.get(idOfRef(ref)))
        .filter((el): el is CanvasElement => {
          if (!isLive(el) || !isNote(el) || seen.has(el.id) || canvas.isLocked(el.id)) return false
          seen.add(el.id)
          return true
        }),
    }))
    .filter((g) => g.notes.length > 0)
  const wanted = themes.reduce((n, t) => n + t.noteIds.length, 0)
  const all = groups.flatMap((g) => g.notes)
  if (!all.length) return null

  // W5-04: where the clusters go. Frames never nest on this canvas, and a note made with N inside a frame
  // may not be its member (W5-01). Each note is in its own frame or, a loose note, in the frame it lies
  // in (frameOfElement); the clusters go to the frame most of them are in (homeFrameOf). A loose note, or
  // one on the open canvas, joins that frame; a note of another frame is grouped in its own frame:
  // grouping never takes a note out of its frame.
  const index = frameIndex(canvas)
  const home = homeFrameOf(canvas, all, index)
  const keyOf = (n: CanvasElement) => frameOfElement(canvas, n, index)?.id ?? home?.id ?? null
  const keys = [...new Set([home?.id ?? null, ...all.map(keyOf)])]
  const plans = keys
    .map((key) => {
      const frame = key ? (index.byId.get(key) ?? null) : null
      const mine = groups
        .map((g) => ({ ...g, notes: g.notes.filter((n) => keyOf(n) === key) }))
        .filter((g) => g.notes.length > 0)
      return mine.length ? planThemes(canvas, spaceOf(frame, index), mine) : null
    })
    .filter((p): p is ThemesPlan => p !== null)
  return { plans, wanted, all }
}

/** The preview of a themes result (L2-1b): where each note goes and where each label lands; nothing written. */
export interface ThemesPreview {
  /** each moving note's new top-left (scene units) */
  moves: { id: string; x: number; y: number }[]
  /** the theme labels' boxes (scene units) */
  labels: { x: number; y: number; w: number; h: number }[]
  notes: number
  themes: number
  /** a frame grows to hold the clusters */
  grows: boolean
}

/** "Group into themes" as it would land right now, for the preview (null: none of the notes can move). */
export function previewThemes(canvas: LobbyCanvas, themes: readonly AiTheme[]): ThemesPreview | null {
  const planned = themesPlans(canvas, themes)
  if (!planned) return null
  const moves: ThemesPreview['moves'] = []
  const labels: ThemesPreview['labels'] = []
  for (const plan of planned.plans) {
    const { space } = plan
    for (const m of plan.moves) moves.push({ id: m.el.id, x: m.el.x + m.dx, y: m.el.y + m.dy })
    for (const l of plan.labels)
      labels.push({ x: space.ox + l.x, y: space.oy + l.y, w: l.block.width, h: l.block.height })
  }
  return {
    moves,
    labels,
    notes: planned.all.length,
    themes: new Set(planned.plans.flatMap((p) => p.labels.map((l) => l.theme))).size,
    grows: planned.plans.some((p) => p.grow !== null),
  }
}

/** "Group into themes": see the header. Returns null when none of the notes can move any more. */
export function applyThemes(
  canvas: LobbyCanvas,
  themes: readonly AiTheme[],
  by: string,
  run: string | null = null,
): ThemesOutcome | null {
  const planned = themesPlans(canvas, themes)
  if (!planned) return null
  const { plans, wanted, all } = planned
  let outcome: ThemesOutcome | null = null
  const written: string[] = []
  canvas.transact('ai: group into themes', (tx) => {
    let moved = 0
    let grew = false
    for (const plan of plans) {
      const { space } = plan
      const frameId = space.frame?.id ?? null
      const outside = plan.notes.filter((n) => (n.frameId ?? null) !== frameId).map((n) => n.id)
      if (outside.length) tx.setFrame(outside, frameId)
      for (const s of plan.stale) {
        tx.delete(s.id)
        written.push(s.id)
      }
      for (const l of plan.labels) {
        const id = tx.create('text', {
          id: newId(),
          x: space.ox + l.x,
          y: space.oy + l.y,
          text: l.block.text,
          originalText: l.name,
          fontFamily: FONT_FAMILY,
          fontSize: LABEL_FONT_SIZE,
          textAlign: 'left',
          verticalAlign: 'top',
          strokeColor: LOBBY_INK,
          frameId,
          // wrapped at the cluster's width: it keeps its lines when someone edits it
          autoResize: l.block.text === l.name,
          customData: aiCustomData(by, 'theme-label', run),
        })
        written.push(id)
      }
      for (const m of plan.moves) {
        moveBy(canvas, tx, m.el, m.dx, m.dy)
        written.push(m.el.id)
        moved++
      }
      if (space.frame && plan.grow) {
        tx.update(space.frame.id, plan.grow)
        written.push(space.frame.id)
        grew = true
      }
    }
    outcome = {
      moved,
      themes: new Set(plans.flatMap((p) => p.labels.map((l) => l.theme))).size,
      grew,
      skipped: Math.max(0, wanted - all.length),
      written,
    }
  })
  // Nothing stays selected: the clusters read cleanly, and Ctrl+Z or the notice's Undo still takes the
  // whole step back.
  canvas.select([])
  // A frame that grew (or whose clusters went under its map), whole, so the result is on screen (never
  // zoomed past 100%).
  const show = plans.flatMap((p) => (p.space.frame && (p.show || p.grow) ? [p.space.frame.id] : []))
  if (show.length) bringIntoView(canvas, show, { inset: 96 })
  return outcome
}

/** What "Group into themes" writes in one space (a frame, or the open canvas). */
interface ThemesPlan {
  space: Space
  /** the notes grouped here */
  notes: CanvasElement[]
  /** labels an earlier run made for these notes: replaced */
  stale: CanvasElement[]
  /** the theme labels, in `space` (`theme`: the theme's index in the plan) */
  labels: { x: number; y: number; theme: number; name: string; block: TextBlock }[]
  moves: { el: CanvasElement; dx: number; dy: number }[]
  /** the frame's new size when the clusters do not fit in it */
  grow: { width: number; height: number } | null
  /** the clusters went under the frame's map (DANA-10) */
  show: boolean
}

/** Lays out `groups` (the themes, with the notes of this space) in `space`: see the header. */
function planThemes(
  canvas: LobbyCanvas,
  space: Space,
  groups: readonly { theme: number; name: string; notes: CanvasElement[] }[],
): ThemesPlan {
  const all = groups.flatMap((g) => g.notes)
  const moving = new Set(all.map((n) => n.id))
  const rects = new Map(all.map((n) => [n.id, rectIn(canvas, n.id, space) as Rect]))
  const stale = staleThemeLabels(canvas, space, moving, rects)
  // Their place counts as the notes' own: grouping the same notes again gives the same result.
  const staleRects = stale.map((s) => rectIn(canvas, s.id, space)).filter((r): r is Rect => !!r)
  const notesBounds = union([...rects.values(), ...staleRects]) as Rect
  // In a frame the clusters start inside its margins (a note joining it may lie over its edge).
  const anchor = space.frame
    ? {
        x: Math.max(FRAME_MARGIN, notesBounds.x),
        y: Math.max(FRAME_MARGIN, Math.min(notesBounds.y, space.frame.height - FRAME_MARGIN)),
      }
    : { x: notesBounds.x, y: notesBounds.y }
  // Reading order inside each theme: where the notes were.
  const ordered = groups.map((g) => ({
    theme: g.theme,
    name: g.name,
    notes: [...g.notes].sort((a, b) => {
      const ra = rects.get(a.id) as Rect
      const rb = rects.get(b.id) as Rect
      return Math.floor(ra.y / 120) - Math.floor(rb.y / 120) || ra.x - rb.x
    }),
  }))
  const labelHeight = (name: string, w: number) =>
    layoutText(canvas, name, LABEL_FONT_SIZE, Math.max(40, w - 4)).height + 4
  const clusters = (labelH: (i: number) => (w: number) => number): ClusterInput[] =>
    ordered.map((g, i) => ({
      key: String(i),
      notes: g.notes.map((n) => {
        const r = rects.get(n.id) as Rect
        return { id: n.id, w: r.w, h: r.h }
      }),
      labelH: labelH(i),
    }))
  const widest = Math.max(...[...rects.values()].map((r) => r.w))
  const regionAt = (at: { x: number; y: number }) =>
    space.frame
      ? frameRegion({ w: space.frame.width, h: space.frame.height }, at, widest)
      : openRegion(at, notesBounds, [...rects.values()].reduce((n, r) => n + r.w * r.h, 0) * 2.2, widest)
  const near = space.frame
    ? undefined
    : {
        x: anchor.x - 400,
        y: anchor.y - 400,
        w: regionAt(anchor).maxX - anchor.x + 1600,
        h: notesBounds.h + 6000,
      }
  const obstacles = obstaclesIn(canvas, space, new Set([...moving, ...stale.map((s) => s.id)]), near)
  // Every label gets the tallest label's height, so the first notes of the clusters line up.
  const tallest = (w: number) => Math.max(...ordered.map((g) => labelHeight(g.name, w)))
  const firstInput = (at: { x: number; y: number }) => ({
    clusters: clusters(() => tallest),
    anchor: at,
    region: regionAt(at),
    obstacles,
  })
  let region = regionAt(anchor)
  let layout = layoutThemes(firstInput(anchor))
  let show = false
  // DANA-10: notes beside a map in the frame are grouped in clear space under that map.
  const map = space.frame ? mapBesideNotes(canvas, space, moving, notesBounds) : null
  if (space.frame && map) {
    const below = { x: Math.max(FRAME_MARGIN, Math.min(map.x, notesBounds.x)), y: bottom(map) + MAP_GAP }
    const under = narrowestFit(
      firstInput(below),
      ordered.map((g) => g.notes.length),
    )
    const h = space.frame.height + Math.ceil(under?.overflow.bottom ?? 0)
    if (under && mayGrow(canvas, space.frame, h, moving)) {
      anchor.x = below.x
      anchor.y = below.y
      region = regionAt(below)
      layout = under
      show = true
    }
  }
  // The labels as they will be (measured at their cluster's width), then the arrangement again with
  // the tallest one's true height.
  const labelBlocks = layout.clusters.map((c) =>
    layoutText(canvas, ordered[Number(c.key)]?.name ?? '', LABEL_FONT_SIZE, Math.max(40, c.label.w - 4)),
  )
  const labelBand = Math.max(1, ...labelBlocks.map((b) => b.height + 4))
  const final = { clusters: clusters(() => () => labelBand), anchor, region, obstacles }
  // One line for the labels of clusters side by side (W5-04).
  layout = alignRows(
    layoutThemes(final, { cols: layout.clusters.map((c) => c.cols), gap: layout.gap }),
    final,
  )
  const labels = layout.clusters.map((c, i) => ({
    x: c.label.x,
    y: c.label.y,
    theme: ordered[Number(c.key)]?.theme ?? -1,
    name: ordered[Number(c.key)]?.name ?? '',
    block: labelBlocks[i] ?? layoutText(canvas, '', LABEL_FONT_SIZE, null),
  }))
  const moves: ThemesPlan['moves'] = []
  for (const c of layout.clusters)
    for (const n of c.notes) {
      const el = canvas.get(n.id)
      const from = rects.get(n.id)
      if (el && from) moves.push({ el, dx: n.x - from.x, dy: n.y - from.y })
    }
  const grow =
    space.frame && (layout.overflow.bottom > 0 || layout.overflow.right > 0)
      ? {
          width: space.frame.width + Math.ceil(layout.overflow.right),
          height: space.frame.height + Math.ceil(layout.overflow.bottom),
        }
      : null
  return { space, notes: all, stale, labels, moves, grow, show }
}

/** Moves the camera to show `ids` when they are not wholly on screen (3b's camera members). */
function bringIntoView(canvas: LobbyCanvas, ids: readonly string[], opts: { inset: number }) {
  try {
    const b = canvas.boundsOf(ids)
    const v = canvas.viewport.get()
    if (!b) return
    const inside =
      b.x >= v.x && b.y >= v.y && b.x + b.width <= v.x + v.width && b.y + b.height <= v.y + v.height
    if (!inside) canvas.viewport.zoomTo(b, { inset: opts.inset, maxZoom: 1, animate: { durationMs: 320 } })
  } catch (e) {
    // a stub until 3b lands the camera members: the result is on the board either way
    console.warn('ai: could not bring the result into view', e)
  }
}

// ---- new blocks beside the target ----------------------------------------------------------------

interface Spot {
  space: Space
  /** top-left in `space` */
  x: number
  y: number
  /** The frame must first grow to this height to hold the block. */
  growTo?: number
}

/**
 * The frame results belong in (reviewer finding DANA-07): the target itself when it is one frame, else
 * the frame the target's objects are in (homeFrameOf: most of them, a note made with N inside a frame
 * counting as in it, W5-04); null on the open canvas.
 */
function homeFrame(
  canvas: LobbyCanvas,
  target: AiTarget,
): { frame: CanvasElement; isTarget: boolean; index: FrameIndex } | null {
  const els = target.ids.map((id) => canvas.get(id)).filter(isLive)
  const index = frameIndex(canvas)
  // a frame target names the loose elements lying in it beside the frame (target.ts frameTarget)
  const asked = target.kind === 'frame' ? els[0] : undefined
  if (asked?.type === 'frame') return { frame: asked, isTarget: true, index }
  const frame = homeFrameOf(canvas, els, index)
  if (!frame) return null
  return { frame, isTarget: els.length === 1 && els[0]?.id === frame.id, index }
}

/** The inner width a block may take in its home frame (null: no limit on the open canvas). */
function roomIn(home: ReturnType<typeof homeFrame>): number | null {
  return home ? Math.max(NOTE_CELL, home.frame.width - 2 * FRAME_MARGIN) : null
}

function spotFor(
  canvas: LobbyCanvas,
  target: AiTarget,
  size: Size,
  home: ReturnType<typeof homeFrame>,
): Spot {
  const page = spaceOf(null)
  const els = target.ids.map((id) => canvas.get(id)).filter(isLive)
  if (!els.length || !target.bounds) {
    const v = canvas.viewport.get()
    const c = { x: v.x + v.width / 2, y: v.y + v.height / 2 }
    const at = placeAround(
      size,
      c,
      obstaclesIn(canvas, page, new Set(), { x: c.x - 3000, y: c.y - 3000, w: 6000, h: 6000 }),
    )
    return { space: page, ...at }
  }
  if (home) {
    const { frame } = home
    const space = spaceOf(frame, home.index)
    const inFrame = obstaclesIn(canvas, space, new Set())
    if (!home.isTarget) {
      const anchor = union(els.map((e) => rectIn(canvas, e.id, space)).filter((r): r is Rect => !!r)) as Rect
      const region = {
        x: FRAME_MARGIN,
        y: FRAME_MARGIN,
        w: frame.width - 2 * FRAME_MARGIN,
        h: frame.height - 2 * FRAME_MARGIN,
      }
      // Right of or below the selection (where people read on to), when the frame has room there.
      const at = placeBeside(size, anchor, inFrame, region, ['right', 'below'])
      if (at) return { space, ...at }
    }
    const end = appendInFrame(size, { w: frame.width, h: frame.height }, inFrame)
    if (end.h <= frame.height) return { space, x: end.x, y: end.y }
    if (mayGrow(canvas, frame, end.h)) return { space, x: end.x, y: end.y, growTo: end.h }
  }
  // Outside: beside the frames around the target (or the target itself), on the page.
  const index = home?.index ?? frameIndex(canvas)
  const outer = els
    .map((e) => frameOfElement(canvas, e, index) ?? e)
    .map((e) => {
      const b = rectIn(canvas, e.id, page)
      // A frame's name label sits over its top edge: keep clear of it too.
      return b && e.type === 'frame' ? { ...b, y: b.y - FRAME_LABEL_BAND, h: b.h + FRAME_LABEL_BAND } : b
    })
    .filter((b): b is Rect => !!b)
  const anchorBox = union(outer) ?? {
    x: target.bounds.x,
    y: target.bounds.y,
    w: target.bounds.width,
    h: target.bounds.height,
  }
  const near = { x: anchorBox.x - 4000, y: anchorBox.y - 4000, w: anchorBox.w + 8000, h: anchorBox.h + 8000 }
  const at = placeBeside(size, anchorBox, obstaclesIn(canvas, page, new Set(), near), null) ?? {
    x: anchorBox.x + anchorBox.w + BESIDE_GAP,
    y: anchorBox.y,
  }
  return { space: page, ...at }
}

/**
 * A free spot for new content of `size` near the elements `near` (public.ts `findSpot`, for W4's diagrams and
 * W8's matrix): the same rules as a block of AI notes (`spotFor`): inside their home frame when it has room
 * beside them or at its end, else beside the frames around them on the page; with nothing near, around the
 * middle of the view, clear of what is there. Reads the board only: a frame that would have to grow to hold it
 * is not grown, the spot goes beside it instead.
 */
export function spotNear(
  canvas: LobbyCanvas,
  size: Size,
  near: readonly string[],
): { x: number; y: number; frameId: string | null } {
  const ids = near.filter((id) => isLive(canvas.get(id)))
  const target: AiTarget = {
    kind: ids.length ? 'selection' : 'none',
    ids,
    label: '',
    notes: 0,
    prompts: 0,
    groups: [],
    texts: 0,
    bounds: ids.length ? canvas.boundsOf(ids) : null,
  }
  const home = ids.length ? homeFrame(canvas, target) : null
  const spot = spotFor(canvas, target, size, home)
  if (spot.growTo !== undefined) {
    const page = spotFor(canvas, target, size, null)
    return { x: page.space.ox + page.x, y: page.space.oy + page.y, frameId: null }
  }
  return { x: spot.space.ox + spot.x, y: spot.space.oy + spot.y, frameId: spot.space.frame?.id ?? null }
}

/** One element of a block, positioned relative to the block's top-left. */
type Piece =
  | { kind: 'text'; dx: number; dy: number; block: TextBlock; original: string; width?: number; ai: AiKind }
  | { kind: 'note'; dx: number; dy: number; text: string; fill: string; size: number; ai: AiKind }
  | {
      kind: 'card'
      dx: number
      dy: number
      width: number
      height: number
      block: TextBlock
      original: string
      fill: string
      stroke: string
      ai: AiKind
    }

/** Creates `pieces` at the spot found for a `size` block, in one step; returns the new ids (selected). */
function createBlock(
  canvas: LobbyCanvas,
  target: AiTarget,
  label: string,
  by: string,
  run: string | null,
  build: (maxW: number | null) => { pieces: Piece[]; size: Size },
): string[] {
  const home = homeFrame(canvas, target)
  const { pieces, size } = build(roomIn(home))
  const spot = spotFor(canvas, target, size, home)
  const frameId = spot.space.frame?.id ?? null
  const created: string[] = []
  const notes: string[] = []
  canvas.transact(label, (tx) => {
    if (spot.growTo !== undefined && spot.space.frame) tx.update(spot.space.frame.id, { height: spot.growTo })
    for (const p of pieces) {
      const x = spot.space.ox + spot.x + p.dx
      const y = spot.space.oy + spot.y + p.dy
      if (p.kind === 'note') {
        const id = newId()
        const labelId = `${id}.t`
        tx.create('note', {
          id,
          labelId,
          x,
          y,
          size: p.size,
          text: p.text,
          backgroundColor: p.fill,
          customData: aiCustomData(by, p.ai, run),
        })
        notes.push(id)
        created.push(id)
      } else if (p.kind === 'text') {
        const id = tx.create('text', {
          id: newId(),
          x,
          y,
          text: p.block.text,
          originalText: p.original,
          fontFamily: FONT_FAMILY,
          fontSize: LABEL_FONT_SIZE,
          textAlign: 'left',
          verticalAlign: 'top',
          strokeColor: LOBBY_INK,
          frameId,
          autoResize: p.block.text === p.original,
          customData: aiCustomData(by, p.ai, run),
        })
        created.push(id)
      } else {
        const id = newId()
        const textId = `${id}.t`
        tx.create('rectangle', {
          id,
          x,
          y,
          width: p.width,
          height: p.height,
          backgroundColor: p.fill,
          fillStyle: 'solid',
          strokeColor: p.stroke,
          strokeWidth: 1,
          roughness: 0,
          roundness: { type: 3 },
          frameId,
          boundElements: [{ id: textId, type: 'text' }],
          customData: aiCustomData(by, p.ai, run),
        })
        tx.create('text', {
          id: textId,
          x: x + BOUND_TEXT_PADDING,
          y: y + BOUND_TEXT_PADDING,
          text: p.block.text,
          originalText: p.original,
          fontFamily: FONT_FAMILY,
          fontSize: SUMMARY_FONT_SIZE,
          textAlign: 'left',
          verticalAlign: 'top',
          strokeColor: LOBBY_INK,
          containerId: id,
          frameId,
          customData: aiCustomData(by, p.ai, run),
        })
        created.push(id)
      }
    }
  })
  // The note builder takes no frame, and the port drops a change to an element created in the same
  // step (CR-3H-3): the notes and their labels go into the frame as a derived write of the same undo step.
  if (frameId && notes.length)
    canvas.transact(label, (tx) => tx.setFrame(notes, frameId), { joinPrevious: true })
  canvas.select(created)
  // Outside the view (below a frame, say): bring it in, gently. Only the camera moves.
  if (created.length) bringIntoView(canvas, created, { inset: 64 })
  return created
}

const paragraphs = (body: string) =>
  body
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)

/**
 * Summarize, added to the board from the summary panel: a card (a pale rounded box with a "Summary"
 * line over the text, left-aligned), so it reads as a deliberate result, not stray text.
 */
export function applySummary(
  canvas: LobbyCanvas,
  target: AiTarget,
  summary: string,
  by: string,
  run: string | null = null,
): string[] {
  return createBlock(canvas, target, 'ai: add summary', by, run, (maxW) => {
    const width = Math.min(SUMMARY_W, maxW ?? SUMMARY_W)
    const original = ['Summary', ...paragraphs(summary)].join('\n')
    const block = layoutText(canvas, original, SUMMARY_FONT_SIZE, width - 2 * BOUND_TEXT_PADDING)
    const height = Math.max(120, block.height + 2 * BOUND_TEXT_PADDING)
    const violet = LOBBY_PALETTE['light-violet']
    return {
      pieces: [
        {
          kind: 'card',
          dx: 0,
          dy: 0,
          width,
          height,
          block,
          original,
          // tldraw's 'solid' fill is its pale tint of the colour (the tour's cards use it too)
          fill: violet.semi,
          stroke: violet.solid,
          ai: 'summary',
        },
      ],
      size: { w: width, h: height },
    }
  })
}

/** New notes are as large as the notes they come from: the first sticky note of the target, if any. */
function noteSizeOf(canvas: LobbyCanvas, target: AiTarget): number {
  const all = canvas.items()
  const stack = target.ids.map((id) => canvas.get(id)).filter(isLive)
  for (let seen = 0; stack.length && seen < 200; seen++) {
    const el = stack.shift() as CanvasElement
    if (isNote(el)) return Math.max(50, Math.min(800, el.width || NOTE_CELL))
    if (el.type === 'frame')
      for (const id of items.childrenOf(el.id, all)) {
        const c = canvas.get(id)
        if (isLive(c)) stack.push(c)
      }
  }
  return NOTE_CELL
}

interface NotesOptions {
  heading: string
  texts: readonly string[]
  color: LobbyColorName
  kind: 'idea' | 'action-item' | 'answer' | 'recap-item'
}

/** The block of a heading over a grid of new sticky notes (what `applyNotes` writes), for `maxW` of room. */
function notesBlock(canvas: LobbyCanvas, target: AiTarget, opts: NotesOptions) {
  return (maxW: number | null) => {
    const cell = noteSizeOf(canvas, target)
    const wanted = opts.texts.length <= 4 ? opts.texts.length : opts.texts.length <= 9 ? 3 : 4
    // As many columns as the frame has room for.
    const cols = fitCols(opts.texts.length, wanted, cell, maxW)
    const g = grid(opts.texts.length, cols, { w: cell, h: cell })
    const headW = Math.max(g.w, 200)
    const head = layoutText(canvas, opts.heading, LABEL_FONT_SIZE, headW)
    const top = head.height + 12
    const pieces: Piece[] = [
      { kind: 'text', dx: 0, dy: 0, block: head, original: opts.heading, width: headW, ai: 'heading' },
    ]
    opts.texts.forEach((text, i) => {
      const c = g.cells[i] ?? { x: 0, y: 0 }
      pieces.push({
        kind: 'note',
        dx: c.x,
        dy: top + c.y,
        text,
        fill: LOBBY_PALETTE[opts.color].noteFill,
        size: cell,
        ai: opts.kind,
      })
    })
    return { pieces, size: { w: headW, h: top + g.h } }
  }
}

/** Action items / Generate ideas: a heading over a grid of new sticky notes, beside the target. */
export function applyNotes(
  canvas: LobbyCanvas,
  target: AiTarget,
  opts: NotesOptions,
  by: string,
  run: string | null = null,
): string[] {
  const label =
    opts.kind === 'idea'
      ? 'ai: generate ideas'
      : opts.kind === 'answer'
        ? 'ai: add answer'
        : 'ai: action items'
  return createBlock(canvas, target, label, by, run, notesBlock(canvas, target, opts))
}

/**
 * Where `applyNotes` would put `count` notes under `heading` right now, without writing anything: the
 * placeholder shown while the request runs (K7-4), a block for the heading and one for each note, in scene
 * space.
 */
export function previewNotes(
  canvas: LobbyCanvas,
  target: AiTarget,
  opts: { heading: string; count: number; kind: NotesOptions['kind'] },
): ShimmerPlan | null {
  try {
    const home = homeFrame(canvas, target)
    const { pieces, size } = notesBlock(canvas, target, {
      heading: opts.heading,
      texts: Array.from({ length: Math.max(1, opts.count) }, () => '…'),
      color: 'yellow',
      kind: opts.kind,
    })(roomIn(home))
    const spot = spotFor(canvas, target, size, home)
    const at = { x: spot.space.ox + spot.x, y: spot.space.oy + spot.y }
    const tiles: ShimmerTile[] = []
    for (const p of pieces) {
      if (tiles.length >= SHIMMER_MAX_TILES) break
      if (p.kind === 'note')
        tiles.push({ x: at.x + p.dx, y: at.y + p.dy, w: p.size, h: p.size, shape: 'note' })
      else if (p.kind === 'text')
        tiles.push({ x: at.x + p.dx, y: at.y + p.dy, w: Math.min(p.width ?? 200, 240), h: 18, shape: 'pill' })
    }
    return { rect: { ...at, w: size.w, h: size.h }, tiles }
  } catch {
    // a placeholder is a nicety: never a reason for a request to fail
    return null
  }
}
