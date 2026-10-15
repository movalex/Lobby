// The storyboard frames: a 16:9 panel and a 9:16 panel, each with a picture slot, a shot field and a notes field, and
// a sheet of six 16:9 panels on a frame (so it exports as one page). The picture is an image slot (the template slot
// marker, no file); the fields are boxes with a placeholder to type over. Original work.
import type { BoardBuilder, PlanFrame, PlanGeo } from '../builder.ts'
import type { SceneEmitResult } from '../scene/emit.ts'
import {
  alignLabelLeft,
  alignLabelTopLeft,
  type El,
  elOf,
  INK,
  MUTED,
  type PieceDef,
  round,
  unlockSlot,
} from './kit.ts'

interface Fields {
  slots: PlanGeo[]
  singles: PlanGeo[]
  notes: PlanGeo[]
}

/** A one-line field: a grey label above it, and a box with a placeholder. */
function field(
  b: BoardBuilder,
  parent: PlanFrame | null,
  x: number,
  y: number,
  w: number,
  label: string,
  hint: string,
) {
  b.text(parent, { x, y, w, text: label, size: 's', color: MUTED })
  return b.geo(parent, { x, y: y + 24, w, h: 36, text: hint, color: 'grey', fill: 'semi', labelColor: MUTED })
}

/** A tall notes field with its placeholder at the top left. */
function notesField(
  b: BoardBuilder,
  parent: PlanFrame | null,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  hint: string,
) {
  b.text(parent, { x, y, w, text: label, size: 's', color: MUTED })
  return b.geo(parent, { x, y: y + 24, w, h, text: hint, color: 'grey', fill: 'semi', labelColor: MUTED })
}

function finishFields(out: SceneEmitResult, f: Fields): El[] {
  const els = out.elements as unknown as El[]
  for (const slot of f.slots) unlockSlot(elOf(out, slot))
  for (const box of f.singles) {
    const el = elOf(out, box)
    round(el, 8)
    alignLabelLeft(els, el)
  }
  for (const box of f.notes) {
    const el = elOf(out, box)
    round(el, 8)
    alignLabelTopLeft(els, el)
  }
  return els
}

export const STORYBOARD_PIECES = {
  'sb-16x9': {
    build(b: BoardBuilder) {
      b.geo(null, { x: 0, y: 0, w: 400, h: 442, color: 'grey', fill: 'semi' })
      b.text(null, { x: 16, y: 14, w: 368, text: 'Panel 1', size: 'm', color: INK })
      const slot = b.imageSlot(null, { x: 16, y: 48, w: 368, h: 207, label: 'Picture 16:9' })
      const shot = field(b, null, 16, 270, 368, 'Shot', 'Wide, close-up, over the shoulder')
      const notes = notesField(b, null, 16, 342, 368, 60, 'Notes', 'Action, dialogue, sound')
      return (out) => finishFields(out, { slots: [slot], singles: [shot], notes: [notes] })
    },
  },
  'sb-9x16': {
    build(b: BoardBuilder) {
      b.geo(null, { x: 0, y: 0, w: 468, h: 432, color: 'grey', fill: 'semi' })
      b.text(null, { x: 16, y: 14, w: 436, text: 'Panel 1', size: 'm', color: INK })
      const slot = b.imageSlot(null, { x: 16, y: 48, w: 207, h: 368, label: 'Picture 9:16' })
      const shot = field(b, null, 239, 48, 213, 'Shot', 'Close-up')
      const notes = notesField(b, null, 239, 124, 213, 268, 'Notes', 'Action, dialogue, sound')
      return (out) => finishFields(out, { slots: [slot], singles: [shot], notes: [notes] })
    },
  },
  'sb-sheet': {
    build(b: BoardBuilder) {
      const frame = b.frame({ x: 0, y: 0, w: 1072, h: 720, name: 'Storyboard sheet (6 panels)' })
      b.text(frame, { x: 32, y: 26, w: 420, text: 'Storyboard', size: 'l', color: INK, heading: true })
      const f: Fields = { slots: [], singles: [], notes: [] }
      ;['Project', 'Scene', 'Date'].forEach((name, i) => {
        f.singles.push(
          b.geo(frame, {
            x: 520 + i * 176,
            y: 28,
            w: 160,
            h: 36,
            text: name,
            color: 'grey',
            fill: 'semi',
            labelColor: MUTED,
          }),
        )
      })
      for (let n = 0; n < 6; n++) {
        const x = 32 + (n % 3) * 344
        const y = 96 + Math.floor(n / 3) * 308
        b.text(frame, { x, y, w: 320, text: `Shot ${n + 1}`, size: 's', color: INK })
        f.slots.push(b.imageSlot(frame, { x, y: y + 26, w: 320, h: 180, label: 'Picture' }))
        f.notes.push(
          b.geo(frame, {
            x,
            y: y + 214,
            w: 320,
            h: 66,
            text: 'Notes',
            color: 'grey',
            fill: 'semi',
            labelColor: MUTED,
          }),
        )
      }
      return (out) => finishFields(out, f)
    },
  },
} satisfies Record<string, PieceDef>
