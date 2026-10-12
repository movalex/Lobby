// OWNER: WS5 (wave N, N5-3). Notes from a photo of a sticky wall, in the wall's own layout: the api's normalised
// boxes (0..1 of the photo) are scaled so a typical note is the board's note size, snapped to the board grid and moved
// to the nearest free cell where two would overlap (never on top of each other); each note takes the Lobby colour
// its photo colour names (M3-4's note destinations: yellow is Butter, pink is Blush). A group the photo shows may
// become a frame around its notes, when that frame holds only its own notes and touches no other frame.
//
// Planned here (pure), written by applyCaptureNotes in ONE undo step: one transact makes the frames and the notes,
// a joinPrevious transact puts the notes in their frames (the note builder takes no frame, and the port drops a
// change to an element made in the same step: CR-3H-3, as ../recap/apply.ts does). Every element carries the
// create-only `ai` provenance (aiCustomData: this person and the capture's run id).

import { LOBBY_PALETTE, type LobbyColorName } from '@draftroom/board-ops/elements'
import type { AiColorName, CaptureResult } from '@draftroom/contracts'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'
import { colourWord, destinationIn } from '../command/colours.ts'
import { captureNotesLine } from '../copy.ts'
import { collides, type Rect } from '../layout.ts'
import { aiCustomData } from '../ported/provenance.ts'
import type { AiPreviewPlan } from '../ported/public.ts'

type NotesResult = Extract<CaptureResult, { kind: 'notes' }>

/** A captured note on the board, scene px: the size of Lobby's default note. */
export const CAPTURE_NOTE_SIZE = 200
/** The board grid notes snap to. */
export const CAPTURE_GRID = 20
/** The least space between two notes. */
export const CAPTURE_NOTE_GAP = 20
/** A group frame's margin around its notes, and the band its name sits in above them. */
export const CAPTURE_FRAME_PAD = 40

/** The Lobby note colour a photo's colour name lands as (M3-4: the note destination of the word). */
export function noteColourOf(name: AiColorName): LobbyColorName {
  const word = colourWord(name.replace(/-/g, ' '))
  const to = word ? destinationIn(word, 'note') : null
  return (to ?? 'black') as LobbyColorName
}

const snap = (v: number, grid: number) => Math.round(v / grid) * grid

export interface LayoutOptions {
  readonly size?: number
  readonly gap?: number
  readonly grid?: number
}

/**
 * Each note's square on the board (relative to the layout's top-left, which is 0,0), in `notes` order: see the header.
 * No two squares come closer than `gap`. Notes without a usable box go in rows under the others.
 */
export function layoutNoteBoxes(notes: NotesResult['notes'], opts: LayoutOptions = {}): Rect[] {
  const size = opts.size ?? CAPTURE_NOTE_SIZE
  const gap = opts.gap ?? CAPTURE_NOTE_GAP
  const grid = opts.grid ?? CAPTURE_GRID
  const sides = notes.map((n) => Math.max(n.box.w, n.box.h)).filter((s) => s > 0.001)
  sides.sort((a, b) => a - b)
  const median = sides.length ? (sides[Math.floor(sides.length / 2)] ?? 0) : 0
  // a typical note is `size` px; a wall of tiny boxes is not blown up past 40 notes across
  const scale = median > 0 ? Math.min(size / median, size * 40) : 0
  const step = size + gap
  // the rings move by half a note step, kept on the grid
  const half = Math.ceil(step / 2 / grid) * grid
  const placed: Rect[] = []
  const out: Rect[] = new Array(notes.length)
  const free = (r: Rect) => !placed.some((p) => collides(p, r, gap - 0.5))
  // reading order: the wall's top rows first, left to right
  const order = notes
    .map((n, i) => ({
      i,
      boxed: scale > 0 && (n.box.w > 0.001 || n.box.h > 0.001),
      cy: n.box.y + n.box.h / 2,
      x: n.box.x,
    }))
    .sort((a, b) => Number(b.boxed) - Number(a.boxed) || a.cy - b.cy || a.x - b.x || a.i - b.i)
  let bottom = 0
  const unboxed: number[] = []
  for (const o of order) {
    const n = notes[o.i]
    if (!n) continue
    if (!o.boxed) {
      unboxed.push(o.i)
      continue
    }
    const cx = (n.box.x + n.box.w / 2) * scale
    const cy = (n.box.y + n.box.h / 2) * scale
    const want: Rect = { x: snap(cx - size / 2, grid), y: snap(cy - size / 2, grid), w: size, h: size }
    let best: Rect | null = free(want) ? want : null
    // the nearest free cell: rings of half a note step around where the photo put it
    for (let ring = 1; !best && ring < 200; ring++) {
      let bestD = Number.POSITIVE_INFINITY
      for (let dx = -ring; dx <= ring; dx++)
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const r = { ...want, x: want.x + dx * half, y: want.y + dy * half }
          const d = Math.hypot(r.x - want.x, r.y - want.y)
          if (d < bestD && free(r)) {
            best = r
            bestD = d
          }
        }
    }
    const r = best ?? { ...want, y: bottom + gap }
    placed.push(r)
    out[o.i] = r
    bottom = Math.max(bottom, r.y + r.h)
  }
  // notes the photo gave no place: rows under the rest
  const left = placed.length ? Math.min(...placed.map((p) => p.x)) : 0
  const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(unboxed.length))))
  unboxed.forEach((i, k) => {
    const r = {
      x: left + (k % cols) * step,
      y: (placed.length ? bottom + gap * 2 : 0) + Math.floor(k / cols) * step,
      w: size,
      h: size,
    }
    out[i] = r
  })
  // the layout's top-left is 0,0
  const all = out.filter(Boolean)
  const x0 = all.length ? Math.min(...all.map((r) => r.x)) : 0
  const y0 = all.length ? Math.min(...all.map((r) => r.y)) : 0
  return out.map((r) => ({ x: r.x - x0, y: r.y - y0, w: r.w, h: r.h }))
}

export interface GroupFrame {
  readonly name: string
  /** indexes into the notes */
  readonly notes: readonly number[]
  readonly rect: Rect
}

const around = (rs: readonly Rect[], pad: number): Rect => {
  const x = Math.min(...rs.map((r) => r.x)) - pad
  const y = Math.min(...rs.map((r) => r.y)) - pad
  return {
    x,
    y,
    w: Math.max(...rs.map((r) => r.x + r.w)) + pad - x,
    h: Math.max(...rs.map((r) => r.y + r.h)) + pad - y,
  }
}

/**
 * The frames groups may become (see the header): a group's frame around its notes, only when it overlaps no note of
 * another group and no frame already kept (in the groups' order). A group whose frame cannot be clean gets none.
 */
export function groupFrames(
  boxes: readonly Rect[],
  groups: NotesResult['groups'],
  pad = CAPTURE_FRAME_PAD,
): GroupFrame[] {
  const out: GroupFrame[] = []
  for (const g of groups) {
    const mine = g.notes.filter((i) => boxes[i])
    if (!mine.length) continue
    const rect = around(
      mine.map((i) => boxes[i] as Rect),
      pad,
    )
    const own = new Set(mine)
    const clean =
      boxes.every((b, i) => own.has(i) || !collides(b, rect)) &&
      out.every((f) => !collides(f.rect, rect, pad / 2))
    if (clean) out.push({ name: g.name, notes: mine, rect })
  }
  return out
}

type Props = Record<string, unknown>
export interface CaptureCreate {
  readonly kind: 'note' | 'frame'
  readonly props: Props
}

export interface CaptureNotesPlan {
  /** transact 1, in order: the frames, then the notes */
  readonly creates: readonly CaptureCreate[]
  /** transact 2: the notes each frame holds */
  readonly framed: readonly { readonly frameId: string; readonly noteIds: readonly string[] }[]
  readonly noteIds: readonly string[]
  readonly frameIds: readonly string[]
  /** the whole result on the board */
  readonly bounds: Rect
  readonly preview: AiPreviewPlan
}

export interface NotesPlanOptions {
  /** the result's top-left on the board */
  readonly origin: { readonly x: number; readonly y: number }
  readonly by: string
  readonly runId: string
  readonly newId: () => string
  /** groups become frames (where they can) */
  readonly frames: boolean
  readonly size?: number
}

/** The size the result takes on the board before it is placed (for findSpot), and its layout. */
export function measureCaptureNotes(
  result: NotesResult,
  opts: { frames: boolean; size?: number },
): { boxes: Rect[]; frames: GroupFrame[]; size: { w: number; h: number }; offset: { x: number; y: number } } {
  const boxes = layoutNoteBoxes(result.notes, { size: opts.size ?? CAPTURE_NOTE_SIZE })
  const frames = opts.frames ? groupFrames(boxes, result.groups) : []
  const all = [...boxes, ...frames.map((f) => ({ ...f.rect, y: f.rect.y - CAPTURE_FRAME_PAD }))]
  if (!all.length) return { boxes, frames, size: { w: 0, h: 0 }, offset: { x: 0, y: 0 } }
  const b = around(all, 0)
  return { boxes, frames, size: { w: b.w, h: b.h }, offset: { x: -b.x, y: -b.y } }
}

/** The elements of notes from a photo at `opts.origin` (see the header). Pure. */
export function planCaptureNotes(result: NotesResult, opts: NotesPlanOptions): CaptureNotesPlan {
  const m = measureCaptureNotes(result, { frames: opts.frames, ...(opts.size ? { size: opts.size } : {}) })
  const at = (r: Rect): Rect => ({
    x: opts.origin.x + m.offset.x + r.x,
    y: opts.origin.y + m.offset.y + r.y,
    w: r.w,
    h: r.h,
  })
  const creates: CaptureCreate[] = []
  const frameIds: string[] = []
  const frameOfNote = new Map<number, string>()
  const framed: { frameId: string; noteIds: string[] }[] = []
  for (const f of m.frames) {
    const id = opts.newId()
    const r = at(f.rect)
    frameIds.push(id)
    for (const i of f.notes) frameOfNote.set(i, id)
    framed.push({ frameId: id, noteIds: [] })
    creates.push({
      kind: 'frame',
      props: {
        id,
        x: r.x,
        y: r.y,
        width: r.w,
        height: r.h,
        name: f.name,
        customData: aiCustomData(opts.by, 'capture-group', opts.runId),
      },
    })
  }
  const noteIds: string[] = []
  result.notes.forEach((n, i) => {
    const box = m.boxes[i]
    if (!box) return
    const r = at(box)
    const id = opts.newId()
    noteIds.push(id)
    const frameId = frameOfNote.get(i)
    if (frameId) framed.find((f) => f.frameId === frameId)?.noteIds.push(id)
    creates.push({
      kind: 'note',
      props: {
        id,
        labelId: `${id}.t`,
        x: r.x,
        y: r.y,
        size: r.w,
        text: n.text,
        backgroundColor: LOBBY_PALETTE[noteColourOf(n.color)].noteFill,
        customData: aiCustomData(opts.by, 'capture-note', opts.runId),
      },
    })
  })
  const bounds: Rect = { x: opts.origin.x, y: opts.origin.y, w: m.size.w, h: m.size.h }
  const preview: AiPreviewPlan = {
    runId: opts.runId,
    title: 'Notes from the photo',
    summary: captureNotesLine({
      notes: noteIds.length,
      groups: result.groups.length,
      frames: frameIds.length,
    }),
    moves: [],
    recolors: [],
    creates: creates.map((c) => {
      const p = c.props as {
        x: number
        y: number
        width?: number
        size?: number
        height?: number
        name?: string
        text?: string
      }
      const w = c.kind === 'frame' ? Number(p.width) : Number(p.size)
      const h = c.kind === 'frame' ? Number(p.height) : Number(p.size)
      const label = c.kind === 'frame' ? p.name : p.text
      return { x: p.x, y: p.y, w, h, kind: c.kind, ...(label ? { label } : {}) }
    }),
    groups: result.groups.map((g) => ({ name: g.name, count: g.notes.length })),
  }
  return { creates, framed: framed.filter((f) => f.noteIds.length), noteIds, frameIds, bounds, preview }
}

export const CAPTURE_NOTES_UNDO_LABEL = 'ai: capture notes'

/** Writes a plan as one undo step (see the header); selects what it made; returns every id it made. */
export function applyCaptureNotes(
  canvas: Pick<LobbyCanvas, 'transact' | 'select'>,
  plan: CaptureNotesPlan,
  label = CAPTURE_NOTES_UNDO_LABEL,
): string[] {
  const made: string[] = []
  canvas.transact(label, (tx) => {
    for (const c of plan.creates) made.push(tx.create(c.kind, c.props))
  })
  if (plan.framed.length)
    canvas.transact(
      label,
      (tx) => {
        for (const f of plan.framed) tx.setFrame(f.noteIds, f.frameId)
      },
      { joinPrevious: true },
    )
  canvas.select(plan.frameIds.length ? [...plan.frameIds] : [...plan.noteIds])
  return made
}
