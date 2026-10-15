// The sticky-note kits: a retro board, start-stop-continue, a 2x2 matrix, a SWOT and a row of colours. Each is a
// set of columns or quadrants (see-through-ish cards with a title) holding a few real sticky notes with starter
// words to type over; the notes are Lobby's own `stickynote`, so they sort, vote and group like any other. Original
// work.
import type { BoardBuilder, LobbyColor, PlanFrame } from '../builder.ts'
import { type El, elOf, INK, MUTED, type PieceDef, round } from './kit.ts'

/** Notes are 200 square at scale 1; the kits use these smaller scales so a column holds a few of them. */
const SMALL = 0.8
const TINY = 0.65
const NOTE_PX = (scale: number) => 200 * scale

interface Column {
  title: string
  color: LobbyColor
  note: LobbyColor
  hint: string
}

/** One column: a titled header, a pale body, and `count` notes stacked in it. */
function column(b: BoardBuilder, x: number, w: number, col: Column, count: number) {
  const parent: PlanFrame | null = null
  const note = NOTE_PX(SMALL)
  const bodyH = 12 + count * (note + 14) - 14 + 12
  const header = b.geo(parent, {
    x,
    y: 0,
    w,
    h: 56,
    text: col.title,
    color: col.color,
    fill: 'solid',
    labelColor: INK,
    size: 'm',
  })
  b.geo(parent, { x, y: 56, w, h: bodyH, color: 'grey', fill: 'semi' })
  for (let i = 0; i < count; i++)
    b.note(parent, {
      x: x + (w - note) / 2,
      y: 56 + 12 + i * (note + 14),
      text: col.hint,
      color: col.note,
      scale: SMALL,
    })
  return header
}

const columns = (cols: readonly Column[], count: number): PieceDef => ({
  build(b) {
    const w = 240
    const headers = cols.map((c, i) => column(b, i * (w + 20), w, c, count))
    return (out) => {
      for (const h of headers) round(elOf(out, h), 10)
      return out.elements as unknown as El[]
    }
  },
})

const RETRO: readonly Column[] = [
  { title: 'Went well', color: 'green', note: 'light-green', hint: 'Add what went well' },
  { title: 'To improve', color: 'orange', note: 'orange', hint: 'Add what to improve' },
  { title: 'Actions', color: 'blue', note: 'light-blue', hint: 'Add an action' },
]
const START_STOP: readonly Column[] = [
  { title: 'Start', color: 'green', note: 'light-green', hint: 'Something to start' },
  { title: 'Stop', color: 'red', note: 'light-red', hint: 'Something to stop' },
  { title: 'Continue', color: 'blue', note: 'light-blue', hint: 'Something to continue' },
]

interface Quadrant {
  title: string
  sub: string
  color: LobbyColor
  note: LobbyColor
  hint: string
}

const quad = (title: string, sub: string, color: LobbyColor, note: LobbyColor, hint: string): Quadrant => ({
  title,
  sub,
  color,
  note,
  hint,
})

/** A 2x2 of quadrants with a title, a grey line under it and `notes` small notes side by side. */
function quadrants(
  b: BoardBuilder,
  at: { x: number; y: number },
  size: { w: number; h: number; gap: number },
  quads: readonly [Quadrant, Quadrant, Quadrant, Quadrant],
  notes: number,
) {
  const small = NOTE_PX(TINY)
  quads.forEach((q, i) => {
    const x = at.x + (i % 2) * (size.w + size.gap)
    const y = at.y + Math.floor(i / 2) * (size.h + size.gap)
    b.geo(null, { x, y, w: size.w, h: size.h, color: q.color, fill: 'solid' })
    const inner = size.w - 32
    b.text(null, { x: x + 16, y: y + 12, w: inner, text: q.title, size: 'm', color: INK, heading: true })
    b.text(null, { x: x + 16, y: y + 44, w: inner, text: q.sub, size: 's', color: INK })
    const left = x + (size.w - (notes * small + (notes - 1) * 14)) / 2
    for (let n = 0; n < notes; n++)
      b.note(null, {
        x: left + n * (small + 14),
        y: y + size.h - small - 14,
        text: q.hint,
        color: q.note,
        scale: TINY,
      })
  })
}

export const STICKY_KIT_PIECES = {
  'kit-retro': columns(RETRO, 2),
  'kit-start-stop': columns(START_STOP, 2),
  'kit-matrix-2x2': {
    build(b) {
      const gutter = 100
      const grid = { w: 300, h: 300, gap: 20 }
      b.text(null, { x: gutter, y: 0, w: 300, text: 'Low effort', size: 's', color: MUTED, align: 'middle' })
      b.text(null, {
        x: gutter + 320,
        y: 0,
        w: 300,
        text: 'High effort',
        size: 's',
        color: MUTED,
        align: 'middle',
      })
      b.text(null, { x: 0, y: 40 + 130, w: 84, text: 'High impact', size: 's', color: MUTED })
      b.text(null, { x: 0, y: 40 + 450, w: 84, text: 'Low impact', size: 's', color: MUTED })
      quadrants(
        b,
        { x: gutter, y: 40 },
        grid,
        [
          quad('Quick wins', 'Do these first', 'green', 'light-green', 'Add an idea'),
          quad('Big bets', 'Plan these', 'blue', 'light-blue', 'Add an idea'),
          quad('Fill-ins', 'If there is time', 'grey', 'yellow', 'Add an idea'),
          quad('Time sinks', 'Avoid these', 'red', 'light-red', 'Add an idea'),
        ],
        1,
      )
      return undefined
    },
  },
  'kit-swot': {
    build(b) {
      quadrants(
        b,
        { x: 0, y: 0 },
        { w: 320, h: 250, gap: 20 },
        [
          quad('Strengths', 'Inside, helps us', 'green', 'light-green', 'A strength'),
          quad('Weaknesses', 'Inside, holds us back', 'orange', 'orange', 'A weakness'),
          quad('Opportunities', 'Outside, helps us', 'blue', 'light-blue', 'An opportunity'),
          quad('Threats', 'Outside, holds us back', 'red', 'light-red', 'A threat'),
        ],
        2,
      )
      return undefined
    },
  },
  'kit-note-colours': {
    build(b) {
      const colours: readonly LobbyColor[] = [
        'yellow',
        'light-green',
        'light-blue',
        'light-red',
        'orange',
        'light-violet',
      ]
      const note = NOTE_PX(0.6)
      colours.forEach((color, i) => {
        b.note(null, { x: i * (note + 16), y: 0, text: 'Note', color, scale: 0.6 })
      })
      return undefined
    },
  },
} satisfies Record<string, PieceDef>
