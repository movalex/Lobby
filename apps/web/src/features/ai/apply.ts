// Applies an AI plan to the board (docs/WAVE4-CONTRACTS.md §4 ai-assist) as ordinary canvas edits: one
// history stopping point, then everything inside one editor.run, so Ctrl+Z undoes the whole result in
// one step and collaborators receive it through the board's sync like any edit. Only plain text goes in
// (tldraw rich text built from it: no links, no marks but the bold labels).
//
// - Group into themes: the notes the plan names (still there, still notes, not locked) move into
//   labelled clusters in the space they occupied and to its right and below, clear of everything that
//   stays (layout.ts). Labels are bold text shapes measured after creation, then the layout runs again
//   with their real heights. A frame grows only when the clusters cannot fit. Labels a previous run made
//   for the same notes are replaced, so grouping twice never stacks labels.
// - Summarize, when an editor adds it from the summary panel: a pale card with a bold "Summary" line.
// - Action items / Generate ideas: a heading and a grid of new sticky notes.
// Both stay in the frame the target is, or is in (DANA-07): beside the selection when the frame has room
// there, else at the end of the frame (under its content, aligned with it), the frame growing downwards
// unless that would run into a neighbour. Outside frames: beside the selection, clear of frame labels,
// or in the middle of the view when nothing is selected.
// AI-made shapes carry `meta.drAi` ({ kind, … }) so a later run can recognise them.

import type { AiTheme } from '@draftroom/contracts'
import {
  Box,
  createShapeId,
  type Editor,
  getFontFamily,
  isShapeId,
  type JsonObject,
  type TLDefaultColorStyle,
  type TLDefaultFontStyle,
  type TLDefaultSizeStyle,
  type TLParentId,
  type TLRichText,
  type TLShape,
  type TLShapeId,
  toRichText,
} from 'tldraw'
import {
  appendInFrame,
  BESIDE_GAP,
  type ClusterInput,
  collides,
  FRAME_LABEL_BAND,
  FRAME_MARGIN,
  fitCols,
  frameRegion,
  grid,
  layoutThemes,
  openRegion,
  placeAround,
  placeBeside,
  type Rect,
  type Size,
  union,
} from './layout.ts'
import type { AiTarget } from './target.ts'

const FONT = 'sans'
/** tldraw's size multipliers (FONT_SIZES in tldraw's shape constants): m = 1.5, s = 1.125. */
const LABEL_SIZE = { name: 'm', factor: 1.5 } as const
const SUMMARY_W = 560
const NOTE_CELL = 200

export type AiMeta =
  | { kind: 'theme-label'; notes: string[] }
  | { kind: 'summary' | 'heading' | 'idea' | 'action-item' }
const meta = (m: AiMeta): JsonObject => ({ drAi: m as unknown as JsonObject })

export function aiMetaOf(shape: TLShape | undefined): AiMeta | null {
  const v = (shape?.meta as { drAi?: unknown } | undefined)?.drAi
  if (typeof v !== 'object' || v === null) return null
  const kind = (v as { kind?: unknown }).kind
  return typeof kind === 'string' ? (v as AiMeta) : null
}

function boldRichText(text: string): TLRichText {
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'bold' }] }] }],
  } as unknown as TLRichText
}

/** A bold first line over plain paragraphs. */
function headedRichText(heading: string, body: string): TLRichText {
  const paragraphs = body
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }))
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: heading, marks: [{ type: 'bold' }] }] },
      ...paragraphs,
    ],
  } as unknown as TLRichText
}

/** Axis-aligned bounds of a shape in its parent's space (rotation included). */
function boundsInParent(editor: Editor, shape: TLShape): Rect {
  const geometry = editor.getShapeGeometry(shape).bounds
  const b = Box.FromPoints(editor.getShapeLocalTransform(shape).applyToPoints(geometry.corners))
  return { x: b.x, y: b.y, w: b.w, h: b.h }
}

function frameOf(editor: Editor, parentId: TLParentId): TLShape | null {
  if (!isShapeId(parentId)) return null
  const p = editor.getShape(parentId)
  return p && p.type === 'frame' ? p : null
}

/** Everything in `parentId` that stays where it is, as rectangles in that parent's space. */
function obstaclesIn(editor: Editor, parentId: TLParentId, moving: ReadonlySet<string>, near?: Rect): Rect[] {
  const out: Rect[] = []
  for (const id of editor.getSortedChildIdsForParent(parentId)) {
    if (moving.has(id)) continue
    const s = editor.getShape(id)
    if (!s) continue
    // Connectors attached to moving notes follow them: their old path is no obstacle.
    if (s.type === 'arrow' && editor.getBindingsFromShape(s, 'arrow').some((b) => moving.has(b.toId)))
      continue
    const b = boundsInParent(editor, s)
    // A frame's name label sits just over its top edge: nothing goes there either (DANA-07).
    const r = s.type === 'frame' ? { ...b, y: b.y - FRAME_LABEL_BAND, h: b.h + FRAME_LABEL_BAND } : b
    if (near && (r.x > near.x + near.w || r.y > near.y + near.h || r.x + r.w < near.x || r.y + r.h < near.y))
      continue
    out.push(r)
  }
  return out
}

/** The label's natural width and line height at the label size (tldraw's own text measurement). */
function labelMetrics(editor: Editor) {
  const theme = editor.getCurrentTheme()
  const fontSize = theme.fontSize * LABEL_SIZE.factor
  const lineHeight = theme.lineHeight
  const fontFamily = getFontFamily(theme, FONT)
  const natural = (text: string) =>
    editor.textMeasure.measureText(text, {
      fontFamily,
      fontSize,
      fontWeight: 'bold',
      fontStyle: 'normal',
      lineHeight,
      maxWidth: null,
      padding: '0px',
    }).w
  return { natural, line: Math.ceil(fontSize * lineHeight) }
}

export interface ThemesOutcome {
  moved: number
  themes: number
  grew: boolean
  skipped: number
}

/** "Group into themes": see the header. Returns null when none of the notes can move any more. */
export function applyThemes(editor: Editor, themes: readonly AiTheme[]): ThemesOutcome | null {
  const seen = new Set<string>()
  const groups = themes
    .map((t) => ({
      name: t.name,
      notes: t.noteIds
        .map((id) => editor.getShape(id as TLShapeId))
        .filter((s): s is TLShape => {
          if (s?.type !== 'note' || seen.has(s.id) || editor.isShapeOrAncestorLocked(s)) return false
          seen.add(s.id)
          return true
        }),
    }))
    .filter((g) => g.notes.length > 0)
  const wanted = themes.reduce((n, t) => n + t.noteIds.length, 0)
  const all = groups.flatMap((g) => g.notes)
  if (!all.length) return null

  const first = all[0]?.parentId ?? editor.getCurrentPageId()
  const parentId: TLParentId = all.every((s) => s.parentId === first)
    ? first
    : (editor.findCommonAncestor(all, (a) => a.type === 'frame') ?? editor.getCurrentPageId())

  let outcome: ThemesOutcome | null = null
  editor.markHistoryStoppingPoint('dr-ai-themes')
  editor.run(() => {
    const outside = all.filter((s) => s.parentId !== parentId).map((s) => s.id)
    if (outside.length) editor.reparentShapes(outside, parentId)
    const moving = new Set<string>(all.map((s) => s.id))
    // Labels an earlier run made for these notes go (they would label the old arrangement).
    const stale = editor
      .getSortedChildIdsForParent(parentId)
      .map((id) => editor.getShape(id))
      .filter((s): s is TLShape => {
        const m = aiMetaOf(s)
        return m?.kind === 'theme-label' && Array.isArray(m.notes) && m.notes.every((id) => moving.has(id))
      })
    // Their place counts as the notes' own: grouping the same notes again gives the same result.
    const staleRects = stale.map((s) => boundsInParent(editor, s))
    if (stale.length) editor.deleteShapes(stale.map((s) => s.id))

    const fresh = new Map(all.map((s) => [s.id, editor.getShape(s.id) ?? s]))
    const rects = new Map([...fresh.values()].map((s) => [s.id, boundsInParent(editor, s)]))
    const notesBounds = union([...rects.values(), ...staleRects]) as Rect
    const anchor = { x: notesBounds.x, y: notesBounds.y }
    // Reading order inside each theme: where the notes were.
    const ordered = groups.map((g) => ({
      name: g.name,
      notes: [...g.notes].sort((a, b) => {
        const ra = rects.get(a.id) as Rect
        const rb = rects.get(b.id) as Rect
        return Math.floor(ra.y / 120) - Math.floor(rb.y / 120) || ra.x - rb.x
      }),
    }))
    const { natural, line } = labelMetrics(editor)
    const estimate = (name: string) => {
      const w0 = natural(name)
      return (w: number) => Math.max(1, Math.ceil(w0 / Math.max(40, w - 4))) * line + 4
    }
    const clusters = (labelH: (i: number) => (w: number) => number): ClusterInput[] =>
      ordered.map((g, i) => ({
        key: String(i),
        notes: g.notes.map((s) => {
          const r = rects.get(s.id) as Rect
          return { id: s.id, w: r.w, h: r.h }
        }),
        labelH: labelH(i),
      }))
    const widest = Math.max(...[...rects.values()].map((r) => r.w))
    const frame = frameOf(editor, parentId)
    const region = frame
      ? frameRegion(
          { w: (frame.props as { w: number }).w, h: (frame.props as { h: number }).h },
          anchor,
          widest,
        )
      : openRegion(anchor, notesBounds, [...rects.values()].reduce((n, r) => n + r.w * r.h, 0) * 2.2, widest)
    const near = frame
      ? undefined
      : { x: anchor.x - 400, y: anchor.y - 400, w: region.maxX - anchor.x + 1600, h: notesBounds.h + 6000 }
    const obstacles = obstaclesIn(editor, parentId, moving, near)
    // Every label gets the tallest label's height, so the first notes of the clusters line up.
    const estimates = ordered.map((g) => estimate(g.name))
    const tallest = (w: number) => Math.max(...estimates.map((e) => e(w)))
    let layout = layoutThemes({
      clusters: clusters(() => tallest),
      anchor,
      region,
      obstacles,
    })

    // Real labels, measured; then the chosen arrangement again with their true heights.
    const labelIds = layout.clusters.map(() => createShapeId())
    editor.createShapes(
      layout.clusters.map((c, i) => ({
        id: labelIds[i],
        type: 'text',
        parentId,
        x: c.label.x,
        y: c.label.y,
        props: {
          richText: boldRichText(ordered[Number(c.key)]?.name ?? ''),
          size: LABEL_SIZE.name,
          font: FONT,
          color: 'black',
          textAlign: 'start',
          autoSize: false,
          w: c.label.w,
        },
        meta: meta({ kind: 'theme-label', notes: (ordered[Number(c.key)]?.notes ?? []).map((s) => s.id) }),
      })),
    )
    const measured = layout.clusters.map((_, i) => {
      const s = editor.getShape(labelIds[i] as TLShapeId)
      return s ? boundsInParent(editor, s).h : 0
    })
    const labelBand = Math.max(1, ...measured)
    layout = layoutThemes(
      {
        clusters: clusters(() => () => labelBand),
        anchor,
        region,
        obstacles,
      },
      { cols: layout.clusters.map((c) => c.cols), gap: layout.gap },
    )

    editor.updateShapes(
      layout.clusters.map((c, i) => ({
        id: labelIds[i] as TLShapeId,
        type: 'text',
        x: c.label.x,
        y: c.label.y,
      })),
    )
    const updates = layout.clusters.flatMap((c) =>
      c.notes.map((n) => {
        const s = fresh.get(n.id as TLShapeId) as TLShape
        const from = rects.get(s.id) as Rect
        return { id: s.id, type: s.type, x: s.x + (n.x - from.x), y: s.y + (n.y - from.y) }
      }),
    )
    editor.updateShapes(updates)
    let grew = false
    if (frame && (layout.overflow.bottom > 0 || layout.overflow.right > 0)) {
      const props = frame.props as { w: number; h: number }
      editor.updateShape({
        id: frame.id,
        type: 'frame',
        props: {
          w: props.w + Math.ceil(layout.overflow.right),
          h: props.h + Math.ceil(layout.overflow.bottom),
        },
      })
      grew = true
    }
    // Nothing stays selected: the clusters read cleanly (no handles, no style panel), and Ctrl+Z or
    // the notice's Undo still takes the whole step back.
    editor.selectNone()
    outcome = {
      moved: updates.length,
      themes: layout.clusters.length,
      grew,
      skipped: Math.max(0, wanted - all.length),
    }
  })
  return outcome
}

// ---- new blocks beside the target ----------------------------------------------------------------

interface Spot {
  parentId: TLParentId
  x: number
  y: number
  /** The frame (parentId) must first grow to this height to hold the block. */
  growTo?: number
}

/**
 * The frame results belong in (reviewer finding DANA-07): the target itself when it is one frame, else
 * the frame all of the target's shapes sit in; null on the open canvas.
 */
function homeFrame(editor: Editor, target: AiTarget): { frame: TLShape; isTarget: boolean } | null {
  const shapes = target.ids.map((id) => editor.getShape(id)).filter((s): s is TLShape => !!s)
  if (shapes.length === 1 && shapes[0]?.type === 'frame') return { frame: shapes[0], isTarget: true }
  const parent = shapes[0]?.parentId
  const frame = parent && shapes.every((s) => s.parentId === parent) ? frameOf(editor, parent) : null
  return frame ? { frame, isTarget: false } : null
}

const frameSize = (frame: TLShape) => frame.props as { w: number; h: number }

/** The inner width a block may take in its home frame (null: no limit on the open canvas). */
function roomIn(home: ReturnType<typeof homeFrame>): number | null {
  return home ? Math.max(NOTE_CELL, frameSize(home.frame).w - 2 * FRAME_MARGIN) : null
}

/** A frame grown to `h` would not run into anything beside or below it on its parent. */
function mayGrow(editor: Editor, frame: TLShape, h: number): boolean {
  const now = boundsInParent(editor, frame)
  const grown = { x: now.x, y: now.y, w: now.w, h: now.h + (h - frameSize(frame).h) }
  const extra = { x: grown.x, y: now.y + now.h, w: grown.w, h: grown.h - now.h }
  return obstaclesIn(editor, frame.parentId, new Set([frame.id]), grown).every(
    (o) => !(collides(extra, o, BESIDE_GAP / 2) && !collides(now, o)),
  )
}

/**
 * Where a `size` block goes (see the header): in its home frame (beside the selection when there is
 * room, else at the end of the frame, which grows downwards), else beside the target on the page, never
 * over a frame's name label; in the middle of the view when there is no target.
 */
function spotFor(editor: Editor, target: AiTarget, size: Size, home: ReturnType<typeof homeFrame>): Spot {
  const pageId = editor.getCurrentPageId()
  const shapes = target.ids.map((id) => editor.getShape(id)).filter((s): s is TLShape => !!s)
  if (!shapes.length || !target.bounds) {
    const c = editor.getViewportPageBounds().center
    const at = placeAround(
      size,
      c,
      obstaclesIn(editor, pageId, new Set(), {
        x: c.x - 3000,
        y: c.y - 3000,
        w: 6000,
        h: 6000,
      }),
    )
    return { parentId: pageId, ...at }
  }
  if (home) {
    const { frame } = home
    const props = frameSize(frame)
    const inFrame = obstaclesIn(editor, frame.id, new Set())
    if (!home.isTarget) {
      const anchor = union(shapes.map((s) => boundsInParent(editor, s))) as Rect
      const region = {
        x: FRAME_MARGIN,
        y: FRAME_MARGIN,
        w: props.w - 2 * FRAME_MARGIN,
        h: props.h - 2 * FRAME_MARGIN,
      }
      // Right of or below the selection (where people read on to), when the frame has room there.
      const at = placeBeside(size, anchor, inFrame, region, ['right', 'below'])
      if (at) return { parentId: frame.id, ...at }
    }
    const end = appendInFrame(size, props, inFrame)
    if (end.h <= props.h) return { parentId: frame.id, x: end.x, y: end.y }
    if (mayGrow(editor, frame, end.h)) return { parentId: frame.id, x: end.x, y: end.y, growTo: end.h }
  }
  // Outside: beside the outermost frame around the target, or the target itself, on the page.
  const outer = shapes
    .map((s) => editor.getShapeAncestors(s).find((a) => a.type === 'frame' && a.parentId === pageId) ?? s)
    .map((s) => {
      const b = editor.getShapePageBounds(s)
      // A frame's name label sits over its top edge: keep clear of it too.
      return b && s.type === 'frame' ? new Box(b.x, b.y - FRAME_LABEL_BAND, b.w, b.h + FRAME_LABEL_BAND) : b
    })
    .filter((b): b is Box => !!b)
  const anchorBox = union(outer.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))) ?? {
    x: target.bounds.x,
    y: target.bounds.y,
    w: target.bounds.w,
    h: target.bounds.h,
  }
  const near = { x: anchorBox.x - 4000, y: anchorBox.y - 4000, w: anchorBox.w + 8000, h: anchorBox.h + 8000 }
  const at = placeBeside(size, anchorBox, obstaclesIn(editor, pageId, new Set(), near), null) ?? {
    x: anchorBox.x + anchorBox.w + BESIDE_GAP,
    y: anchorBox.y,
  }
  return { parentId: pageId, ...at }
}

/** Creates `records` (positions relative to the block's top-left) at the spot found for the block. */
function createBlock(
  editor: Editor,
  target: AiTarget,
  build: (
    parentId: TLParentId,
    maxW: number | null,
  ) => {
    ids: TLShapeId[]
    size: Size
    offsets: Map<TLShapeId, { x: number; y: number }>
  },
  historyName: string,
): TLShapeId[] {
  let created: TLShapeId[] = []
  editor.markHistoryStoppingPoint(historyName)
  editor.run(() => {
    // Built on the page first (to measure), then moved to its spot (and into a frame when it fits there).
    const pageId = editor.getCurrentPageId()
    const home = homeFrame(editor, target)
    const { ids, size, offsets } = build(pageId, roomIn(home))
    const spot = spotFor(editor, target, size, home)
    if (spot.growTo !== undefined && home)
      editor.updateShape({ id: home.frame.id, type: 'frame', props: { h: spot.growTo } })
    if (spot.parentId !== pageId) editor.reparentShapes(ids, spot.parentId)
    editor.updateShapes(
      ids.map((id) => {
        const s = editor.getShape(id) as TLShape
        const o = offsets.get(id) ?? { x: 0, y: 0 }
        return { id, type: s.type, x: spot.x + o.x, y: spot.y + o.y }
      }),
    )
    editor.select(...ids)
    created = ids
  })
  // Outside the view (below a frame, say): bring it in, gently. Only the camera moves.
  if (created.length) editor.zoomToSelectionIfOffscreen(64, { animation: { duration: 240 } })
  return created
}

/**
 * Summarize, added to the board from the summary panel: a card (a pale rounded box with a bold
 * "Summary" line over the text, left-aligned), so it reads as a deliberate result, not stray text.
 */
export function applySummary(editor: Editor, target: AiTarget, summary: string): TLShapeId[] {
  return createBlock(
    editor,
    target,
    (pageId, maxW) => {
      const id = createShapeId()
      editor.createShape({
        id,
        type: 'geo',
        parentId: pageId,
        x: 0,
        y: 0,
        props: {
          geo: 'rectangle',
          w: Math.min(SUMMARY_W, maxW ?? SUMMARY_W),
          // tldraw grows the box to fit the text (growY).
          h: 120,
          richText: headedRichText('Summary', summary),
          size: 's',
          font: FONT,
          color: 'light-violet',
          labelColor: 'black',
          // 'solid' is tldraw's pale tint of the colour (the tour's cards use it too).
          fill: 'solid',
          dash: 'solid',
          align: 'start',
          verticalAlign: 'start',
        },
        meta: meta({ kind: 'summary' }),
      })
      const s = editor.getShape(id) as TLShape
      const b = boundsInParent(editor, s)
      return { ids: [id], size: { w: b.w, h: b.h }, offsets: new Map([[id, { x: 0, y: 0 }]]) }
    },
    'dr-ai-summary',
  )
}

interface NoteStyle {
  size: TLDefaultSizeStyle
  font: TLDefaultFontStyle
  scale: number
}

const SIZES: readonly string[] = ['s', 'm', 'l', 'xl']
const FONTS: readonly string[] = ['draw', 'sans', 'serif', 'mono']

/** New notes look like the notes they come from: the first sticky note of the target, if any. */
function noteStyleOf(editor: Editor, target: AiTarget): NoteStyle {
  const fallback: NoteStyle = { size: 'm', font: FONT, scale: 1 }
  const stack = target.ids.map((id) => editor.getShape(id)).filter((s): s is TLShape => !!s)
  for (let seen = 0; stack.length && seen < 200; seen++) {
    const s = stack.shift() as TLShape
    if (s.type === 'note') {
      const p = s.props as { size?: unknown; font?: unknown; scale?: unknown }
      const scale = typeof p.scale === 'number' && p.scale >= 0.25 && p.scale <= 4 ? p.scale : 1
      return {
        size:
          typeof p.size === 'string' && SIZES.includes(p.size)
            ? (p.size as TLDefaultSizeStyle)
            : fallback.size,
        font:
          typeof p.font === 'string' && FONTS.includes(p.font)
            ? (p.font as TLDefaultFontStyle)
            : fallback.font,
        scale,
      }
    }
    if (s.type === 'frame' || s.type === 'group')
      for (const id of editor.getSortedChildIdsForParent(s.id)) {
        const c = editor.getShape(id)
        if (c) stack.push(c)
      }
  }
  return fallback
}

/** Action items / Generate ideas: a heading over a grid of new sticky notes, beside the target. */
export function applyNotes(
  editor: Editor,
  target: AiTarget,
  opts: {
    heading: string
    texts: readonly string[]
    color: TLDefaultColorStyle
    kind: 'idea' | 'action-item'
  },
): TLShapeId[] {
  return createBlock(
    editor,
    target,
    (pageId, maxW) => {
      const headingId = createShapeId()
      const style = noteStyleOf(editor, target)
      const cell = NOTE_CELL * style.scale
      const wanted = opts.texts.length <= 4 ? opts.texts.length : opts.texts.length <= 9 ? 3 : 4
      // As many columns as the frame has room for.
      const cols = fitCols(opts.texts.length, wanted, cell, maxW)
      const g = grid(opts.texts.length, cols, { w: cell, h: cell })
      editor.createShape({
        id: headingId,
        type: 'text',
        parentId: pageId,
        x: 0,
        y: 0,
        props: {
          richText: boldRichText(opts.heading),
          size: 'm',
          font: FONT,
          color: 'black',
          textAlign: 'start',
          autoSize: false,
          w: Math.max(g.w, 200),
        },
        meta: meta({ kind: 'heading' }),
      })
      const headH = boundsInParent(editor, editor.getShape(headingId) as TLShape).h
      const top = headH + 12
      const noteIds = opts.texts.map(() => createShapeId())
      editor.createShapes(
        opts.texts.map((text, i) => ({
          id: noteIds[i],
          type: 'note',
          parentId: pageId,
          x: g.cells[i]?.x ?? 0,
          y: top,
          props: {
            richText: toRichText(text),
            color: opts.color,
            font: style.font,
            size: style.size,
            scale: style.scale,
          },
          meta: meta({ kind: opts.kind }),
        })),
      )
      // Long texts make notes grow: each row is as tall as its tallest note.
      const heights = noteIds.map((id) => boundsInParent(editor, editor.getShape(id) as TLShape).h)
      const c = Math.max(1, Math.min(cols, opts.texts.length))
      const offsets = new Map<TLShapeId, { x: number; y: number }>([[headingId, { x: 0, y: 0 }]])
      let y = top
      for (let r = 0; r * c < noteIds.length; r++) {
        const row = noteIds.slice(r * c, r * c + c)
        row.forEach((id, k) => {
          offsets.set(id, { x: g.cells[r * c + k]?.x ?? 0, y })
        })
        y += Math.max(...heights.slice(r * c, r * c + c)) + 16
      }
      return { ids: [headingId, ...noteIds], size: { w: Math.max(g.w, 200), h: y - 16 }, offsets }
    },
    opts.kind === 'idea' ? 'dr-ai-ideas' : 'dr-ai-actions',
  )
}
