// The "Lobby tour" sample board (docs/WAVE3-CONTRACTS.md §2 sample-board): six 16:10 frames in one row,
// left to right in presentation order, for showing Lobby to DBC. Plain tldraw records like every other
// template; only tldraw palette colours (DBC orange plus the neutral "black" tones, which tldraw inverts
// in dark mode; the Mood board's palette adds hues that keep their colour in both themes). Labels are
// black on tinted ('solid') fills so they read in both themes: tldraw's dark theme has no dark label
// colour, so no full-colour fill carries text here (the palette swatches are named by text beside them).
//
// Every "try this" tip names a real binding (tldraw 5.4.2 defaults plus the canvas-ux / comments /
// present-export keys listed in docs/FEATURES-M2-CONTRACTS.md §1).

import type {
  TLArrowShape,
  TLDefaultColorStyle,
  TLFrameShape,
  TLGeoShape,
  TLRichText,
  TLShape,
} from '@tldraw/tlschema'
import { type BoardBuilder, createBoardBuilder } from '../builder.ts'
import { NOTE_SIZE } from '../layout.ts'
import type { TemplateDefinition } from '../types.ts'

export const LOBBY_TOUR_SECTIONS = [
  '1 · Welcome',
  '2 · Brainstorm',
  '3 · Plan',
  '4 · Mood board',
  '5 · Retro',
  '6 · Tips and shortcuts',
] as const

/** 16:10, so a slide fills a laptop screen when presenting. */
export const TOUR_FRAME_W = 1600
export const TOUR_FRAME_H = 1000
const FRAME_GAP = 160
/** Inner margin of a frame. */
const M = 80
const INNER_W = TOUR_FRAME_W - M * 2
const HEADING_Y = 56
const INTRO_Y = 136
/** Content starts below the heading and a (two-line) intro. */
const TOP = 260
const COL_GAP = 40
/** Three equal columns across the frame. */
const COL3_W = (INNER_W - COL_GAP * 2) / 3
const col3 = (i: number) => M + i * (COL3_W + COL_GAP)

function tourFrame(b: BoardBuilder, index: number, heading: string, intro: string): TLFrameShape {
  const frame = b.frame({
    x: index * (TOUR_FRAME_W + FRAME_GAP),
    y: 0,
    w: TOUR_FRAME_W,
    h: TOUR_FRAME_H,
    name: LOBBY_TOUR_SECTIONS[index] ?? '',
  })
  // Headings and instructions arrive locked (PRE-07), like every template's.
  // DBC orange: #e16919 on the white frame is 3.4:1 (AA for large text; this is 44 px), and brighter in dark.
  b.text(frame, { x: M, y: HEADING_Y, w: INNER_W, text: heading, size: 'xl', color: 'orange', locked: true })
  b.text(frame, { x: M, y: INTRO_Y, w: 1240, text: intro, size: 'm', color: 'grey', locked: true })
  return frame
}

/** A bold first line (a card's title or a key) over plain lines, as tldraw's rich text stores it. */
function titled(text: string): TLRichText {
  const [title = '', ...rest] = text.split('\n')
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: title, marks: [{ type: 'bold' }] }] },
      ...rest.map((line) =>
        line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' },
      ),
    ],
  }
}

// The builder takes plain text (its layout estimates read the same words). These two refine a record it
// just returned, before `finish()` hands the records out.
function boldTitle(shape: TLGeoShape): TLGeoShape {
  const lines = (shape.props.richText.content as Array<{ content?: Array<{ text?: string }> }>).map((p) =>
    (p.content ?? []).map((n) => n.text ?? '').join(''),
  )
  shape.props.richText = titled(lines.join('\n'))
  return shape
}
function elbow(arrow: TLArrowShape): TLArrowShape {
  arrow.props.kind = 'elbow'
  return arrow
}

/** A tinted card with a black label: readable in light and dark mode. */
function card(
  b: BoardBuilder,
  frame: TLFrameShape,
  spec: { x: number; y: number; w: number; h: number; text: string; color: TLDefaultColorStyle },
) {
  return b.geo(frame, { ...spec, fill: 'solid', labelColor: 'black', size: 'm' })
}

function welcome(b: BoardBuilder) {
  const f = tourFrame(
    b,
    0,
    'Welcome to Lobby',
    "Dark Burn Creative's whiteboard. Every project gets a lobby: its boards, files and feedback in one " +
      'place, live for the whole team.',
  )
  const pillars: ReadonlyArray<[string, TLDefaultColorStyle]> = [
    ['Kick off\nBriefs, references and first ideas, all on one board.', 'orange'],
    ['Make\nPlan the campaign, map the beats, pull the key art together.', 'black'],
    ['Review\nComments, votes and sign-off, without the email chain.', 'orange'],
  ]
  pillars.forEach(([text, color], i) => {
    boldTitle(card(b, f, { x: col3(i), y: TOP, w: COL3_W, h: 190, text, color }))
  })
  b.text(f, { x: M, y: 510, w: 600, text: 'Try this', size: 'l', color: 'black', locked: true })
  const tries: ReadonlyArray<[string, TLDefaultColorStyle]> = [
    ["Press N, click anywhere and type. That's a sticky note.", 'yellow'],
    ['Press C, then click this note to leave a comment.', 'orange'],
    ['Click Present at the top to walk these frames as slides.', 'light-blue'],
  ]
  const scale = 1.2
  const noteW = NOTE_SIZE * scale
  tries.forEach(([text, color], i) => {
    b.note(f, { x: col3(i) + (COL3_W - noteW) / 2, y: 590, text, color, scale })
  })
  b.text(f, {
    x: M,
    y: 900,
    w: INNER_W,
    text: 'This board is yours to play with. Edit, move or delete anything; Ctrl/Cmd + Z undoes it.',
    size: 's',
    color: 'grey',
    align: 'middle',
    locked: true,
  })
}

function brainstorm(b: BoardBuilder) {
  const f = tourFrame(
    b,
    1,
    'Brainstorm',
    'One question, ideas in clusters. The connectors are attached, so they follow when you move a theme.',
  )
  // A left-to-right map (F12): the question on the left, a column of themes, each theme's ideas in a
  // row to its right. The theme column keeps empty canvas between the themes, so dragging one up or down
  // (the demo's "the connectors follow") never lands it on the ideas; the Story row keeps its third place
  // free for the idea a second person adds live.
  // Slightly smaller notes keep the bottom row clear of Present's control bar.
  const noteScale = 0.9
  const noteW = NOTE_SIZE * noteScale
  const rowGap = 40
  const rowY = (i: number) => TOP + i * (noteW + rowGap)
  const qW = 360
  const qH = 220
  const question = b.geo(f, {
    x: M,
    y: rowY(1) + noteW / 2 - qH / 2,
    w: qW,
    h: qH,
    geo: 'ellipse',
    text: "Launch trailer:\nwhat's the hook?",
    color: 'orange',
    labelColor: 'black',
    fill: 'solid',
    size: 'l',
  })
  const themeX = M + qW + 120
  const themeW = 240
  const themeH = 72
  const ideasX = themeX + themeW + 50
  const ideaGap = 20
  const clusters: ReadonlyArray<{ label: string; color: TLDefaultColorStyle; ideas: string[] }> = [
    {
      label: 'Gameplay',
      color: 'orange',
      ideas: [
        'Open on the boss fight. No logo for ten seconds.',
        'One unbroken shot through the new map',
        'Show the new co-op move up close',
      ],
    },
    {
      label: 'Story',
      color: 'yellow',
      ideas: ["Tell it from the villain's side", 'Start at the ending, then rewind'],
    },
    {
      label: 'Community',
      color: 'light-blue',
      ideas: [
        'Cut it from real player clips',
        'Hide a code in the last frame',
        'Premiere it live with creators',
      ],
    },
  ]
  clusters.forEach((c, i) => {
    const y = rowY(i)
    const label = boldTitle(
      card(b, f, {
        x: themeX,
        y: y + noteW / 2 - themeH / 2,
        w: themeW,
        h: themeH,
        text: c.label,
        color: c.color,
      }),
    )
    b.noteGrid(
      f,
      { x: ideasX, y, cols: 3, gap: ideaGap, scale: noteScale },
      c.ideas.map((text) => ({ text, color: c.color })),
    )
    // Question to theme: a precise binding on the theme's left middle, so the fan stays tidy.
    b.arrow(question, label, { endAnchor: { x: 0, y: 0.5 }, color: 'orange', arrowheadEnd: 'none' })
  })
}

function plan(b: BoardBuilder) {
  const f = tourFrame(
    b,
    2,
    'Plan',
    'A small process map. Every arrow is attached at both ends: drag a step and its arrows follow.',
  )
  const boxW = 200
  const boxH = 120
  const diaW = 240
  const diaH = 180
  const gap = (INNER_W - boxW * 4 - diaW) / 4
  const rowMid = 420
  const steps: TLShape[] = []
  let x = M
  const add = (text: string, color: TLDefaultColorStyle, diamond = false) => {
    const w = diamond ? diaW : boxW
    const h = diamond ? diaH : boxH
    const shape = b.geo(f, {
      x,
      y: rowMid - h / 2,
      w,
      h,
      text,
      geo: diamond ? 'diamond' : 'rectangle',
      color,
      labelColor: 'black',
      fill: 'solid',
      size: 'm',
    })
    x += w + gap
    steps.push(shape)
    return shape
  }
  add('Brief', 'black')
  const concepts = add('Concepts', 'black')
  const review = add('Client\nreview', 'orange', true)
  add('Production', 'black')
  add('Delivery', 'orange')
  b.chain(steps, { color: 'black', size: 'm' })

  // The feedback loop under the row: review -> changes -> back to concepts (dashed: only when needed).
  const rX = review.x
  const cX = concepts.x
  const changesW = 200
  const changes = card(b, f, {
    x: (cX + boxW / 2 + rX + diaW / 2) / 2 - changesW / 2,
    y: 620,
    w: changesW,
    h: 100,
    text: 'Changes',
    color: 'black',
  })
  const loop = { color: 'orange' as const, dash: 'dashed' as const, size: 'm' as const }
  // Elbow routing (tldraw 5.4.2 arrow kind 'elbow'): down from the diamond, round and back up.
  elbow(b.arrow(review, changes, { ...loop, startAnchor: { x: 0.5, y: 1 }, endAnchor: { x: 1, y: 0.5 } }))
  elbow(b.arrow(changes, concepts, { ...loop, startAnchor: { x: 0, y: 0.5 }, endAnchor: { x: 0.5, y: 1 } }))
  b.text(f, {
    x: M,
    y: 780,
    w: 700,
    text: 'Dashed arrows: the loop we only take when the client asks for changes.',
    size: 's',
    color: 'grey',
    locked: true,
  })

  const noteY = 570
  b.note(f, {
    x: M + INNER_W - NOTE_SIZE * 2 - 40,
    y: noteY,
    text: 'Try it: drag Client review down. The arrows stay attached.',
    color: 'yellow',
  })
  b.note(f, {
    x: M + INNER_W - NOTE_SIZE,
    y: noteY,
    text: 'Need a step? Select a box and press Ctrl/Cmd + D.',
    color: 'light-blue',
  })
}

/** The Mood board's palette: tldraw colours that keep their hue in the dark theme, DBC orange first. */
const MOOD_SWATCHES: ReadonlyArray<{ color: TLDefaultColorStyle; name: string; role: string }> = [
  { color: 'orange', name: 'Burn orange', role: 'Titles and calls to action' },
  { color: 'yellow', name: 'Ember', role: 'Sparks and rim light' },
  { color: 'red', name: 'Signal red', role: 'Danger, used sparingly' },
  { color: 'violet', name: 'Dusk', role: 'Night and deep shadow' },
  { color: 'grey', name: 'Ash', role: 'UI, type and smoke' },
]

function moodBoard(b: BoardBuilder) {
  const f = tourFrame(
    b,
    3,
    'Mood board',
    'One direction for the launch trailer: references, palette and type. Drop an image onto a slot and ' +
      'it fits the slot.',
  )
  // F10: a direction that reads as finished in Present (a palette, type samples) with two reference
  // slots that invite a drop, instead of six empty boxes. No images ship with the tour: the colours
  // are tldraw's own, the samples are text in tldraw's fonts.
  const labelY = TOP
  const bodyY = TOP + 56
  const slotH = Math.round((COL3_W * 9) / 16)
  const typeY = bodyY + slotH + 80
  const px = col3(2)
  // Section labels first, in reading order (search and the CSV export list shapes in creation order).
  const section = (x: number, y: number, text: string) =>
    b.text(f, { x, y, w: COL3_W, text, size: 'm', color: 'black', locked: true })
  section(M, labelY, 'References')
  section(px, labelY, 'Palette')
  section(M, typeY, 'Type')

  // References: two 16:9 slots across the first two columns, captioned underneath.
  const refs = ['Key art: the hero moment', 'World: places and light']
  refs.forEach((caption, i) => {
    const x = col3(i)
    b.imageSlot(f, { x, y: bodyY, w: COL3_W, h: slotH, label: 'Drop a reference here', size: 'm' })
    // Captions are starter values people rewrite, so they stay unlocked.
    b.text(f, { x, y: bodyY + slotH + 14, w: COL3_W, text: caption, size: 's', color: 'black' })
  })

  // Type: three samples in tldraw's serif, sans and mono, each with its role on the left.
  const roleW = 200
  const sampleX = M + roleW + 24
  const sampleW = col3(2) - COL_GAP - sampleX
  const samples: ReadonlyArray<{
    role: string
    text: string
    font: 'serif' | 'sans' | 'mono'
    size: 's' | 'm' | 'l' | 'xl'
    color: TLDefaultColorStyle
    y: number
  }> = [
    { role: 'Display · serif', text: 'Rise from the ashes', font: 'serif', size: 'xl', color: 'black', y: 0 },
    {
      role: 'Body · sans',
      text: 'Plain words in sans, easy to read on a phone.',
      font: 'sans',
      size: 'm',
      color: 'black',
      y: 84,
    },
    {
      role: 'HUD · mono',
      text: 'PRESS START · 03:14 · ARENA 7',
      font: 'mono',
      size: 'm',
      color: 'orange',
      y: 140,
    },
  ]
  for (const s of samples) {
    const y = typeY + 50 + s.y
    b.text(f, { x: M, y: y + (s.size === 'xl' ? 18 : 3), w: roleW, text: s.role, size: 's', color: 'grey' })
    b.text(f, { x: sampleX, y, w: sampleW, text: s.text, size: s.size, color: s.color, font: s.font })
  }

  // Palette: a column of swatches in the third column, each named, with what it is for.
  const swatchW = 112
  const swatchH = 84
  const swatchGap = 22
  const nameX = px + swatchW + 24
  const nameW = px + COL3_W - nameX
  MOOD_SWATCHES.forEach((s, i) => {
    const y = bodyY + i * (swatchH + swatchGap)
    b.swatch(f, { x: px, y, w: swatchW, h: swatchH, color: s.color })
    b.text(f, { x: nameX, y: y + 6, w: nameW, text: s.name, size: 'm', color: 'black' })
    b.text(f, { x: nameX, y: y + 46, w: nameW, text: s.role, size: 's', color: 'grey' })
  })
}

function retro(b: BoardBuilder) {
  const f = tourFrame(
    b,
    4,
    'Retro',
    'Ten minutes a column. Then start a vote from Voting to pick what to talk about first.',
  )
  const columns: ReadonlyArray<{ title: string; color: TLDefaultColorStyle; notes: string[] }> = [
    {
      title: 'Went well',
      color: 'light-green',
      notes: [
        'The client loved the first cut',
        'Feedback in one place, not in email',
        'Shipped a day early',
        'Smooth handoff to social',
      ],
    },
    {
      title: 'To improve',
      color: 'orange',
      notes: [
        'Too many review rounds',
        'Assets arrived late',
        'Scope crept in week two',
        'Captions were an afterthought',
      ],
    },
    {
      title: 'Actions',
      color: 'light-blue',
      notes: [
        'Book review slots at kickoff\nOwner: producer',
        'Asset checklist in every brief\nOwner: account lead',
        'Captions in the delivery spec\nOwner: editor',
        'Check these at the next retro',
      ],
    },
  ]
  const scale = 1.1
  const noteW = NOTE_SIZE * scale
  columns.forEach((c, i) => {
    const x = col3(i)
    boldTitle(card(b, f, { x, y: TOP, w: COL3_W, h: 72, text: c.title, color: c.color }))
    b.noteGrid(
      f,
      { x, y: TOP + 72 + 28, cols: 2, gap: COL3_W - noteW * 2, gapY: 20, scale },
      c.notes.map((text) => ({ text, color: c.color })),
    )
  })
}

function tips(b: BoardBuilder) {
  const f = tourFrame(
    b,
    5,
    'Tips and shortcuts',
    'The keys worth learning first. On a Mac, Ctrl is Cmd and Alt is Option.',
  )
  const keys: ReadonlyArray<[string, string]> = [
    ['N', 'Sticky note'],
    ['T', 'Text'],
    ['F', 'Frame'],
    ['L', 'Connector'],
    ['C', 'Comment'],
    ['P', 'Pen'],
    ['Space + drag', 'Pan around'],
    ['Ctrl + F', 'Search the board'],
    ['Alt + 1', 'Zoom to fit'],
    ['Ctrl + Alt + Enter', 'Present'],
    ['Ctrl + Z', 'Undo'],
    ['M', 'Minimap'],
  ]
  const cols = 4
  const gap = 24
  const w = (INNER_W - gap * (cols - 1)) / cols
  const h = 150
  keys.forEach(([key, what], i) => {
    boldTitle(
      card(b, f, {
        x: M + (i % cols) * (w + gap),
        y: TOP + Math.floor(i / cols) * (h + gap),
        w,
        h,
        text: `${key}\n${what}`,
        // The first row (the making tools) in DBC orange, the rest in the neutral dark tone.
        color: i < cols ? 'orange' : 'black',
      }),
    )
  })
  b.text(f, {
    x: M,
    y: 820,
    w: INNER_W,
    text:
      'Edits sync live for everyone on the board. Before a big clean-up, save a checkpoint in History. ' +
      'Every other shortcut is in the main menu, under Keyboard shortcuts.',
    size: 'm',
    color: 'grey',
    locked: true,
  })
}

export const lobbyTour: TemplateDefinition = {
  id: 'lobby-tour',
  name: 'Lobby tour',
  description:
    'A guided tour of Lobby for a first look or a demo: brainstorm, plan, mood board, retro and shortcuts.',
  category: 'sample',
  sections: LOBBY_TOUR_SECTIONS,
  build(ctx) {
    const b = createBoardBuilder(ctx)
    welcome(b)
    brainstorm(b)
    plan(b)
    moodBoard(b)
    retro(b)
    tips(b)
    return { records: b.finish() }
  },
}
