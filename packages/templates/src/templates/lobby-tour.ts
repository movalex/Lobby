// The "Lobby tour" sample board (docs/WAVE3-CONTRACTS.md §2 sample-board): six 16:10 frames in one row,
// left to right in presentation order, for showing Lobby to DBC. Written once against the plan builder like
// every other template (tldraw records for the default build, Excalidraw elements for the new canvas);
// only Lobby palette colours (DBC orange plus the neutral "black" tones, which both engines invert in dark
// mode; the Mood board's palette adds hues that keep their colour in both themes). Labels are black on
// tinted ('solid') fills so they read in both themes: tldraw's dark theme has no dark label colour, so no
// full-colour fill carries text here (the palette swatches are named by text beside them).
//
// Every "try this" tip names a real binding (tldraw 5.4.2 defaults plus the canvas-ux / comments /
// present-export keys listed in docs/FEATURES-M2-CONTRACTS.md §1).

import type { BoardBuilder, GeoSpec, LobbyColor, PlanFrame, PlanShape } from '../builder.ts'
import { NOTE_SIZE } from '../common.ts'
import type { TemplateSource } from '../source.ts'

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
/**
 * Where the Brainstorm map ends: from here to the frame's margin a column one sticky note wide stays
 * empty (NOTE_SIZE, plus the 40 px apps/sync place-notes keeps between a revealed note and the frame's
 * content), for the notes of a private brainstorm revealed into the frame.
 */
export const BRAINSTORM_MAP_RIGHT = M + INNER_W - NOTE_SIZE - 40
/** Three equal columns across the frame. */
const COL3_W = (INNER_W - COL_GAP * 2) / 3
const col3 = (i: number) => M + i * (COL3_W + COL_GAP)

function tourFrame(b: BoardBuilder, index: number, heading: string, intro: string, introW = 1240): PlanFrame {
  const frame = b.frame({
    x: index * (TOUR_FRAME_W + FRAME_GAP),
    y: 0,
    w: TOUR_FRAME_W,
    h: TOUR_FRAME_H,
    name: LOBBY_TOUR_SECTIONS[index] ?? '',
  })
  // Headings and instructions arrive locked (PRE-07), like every template's.
  // DBC orange: #e16919 on the white frame is 3.4:1 (AA for large text; this is 44 px), and brighter in dark.
  // As wide as the intro under it (W5-59): they share a reading-order row, read by their centres, so a
  // heading wider than its intro was read after it. The new canvas sets it in its display face (D3).
  b.text(frame, {
    x: M,
    y: HEADING_Y,
    w: introW,
    text: heading,
    size: 'xl',
    color: 'orange',
    locked: true,
    heading: true,
  })
  b.text(frame, { x: M, y: INTRO_Y, w: introW, text: intro, size: 'm', color: 'grey', locked: true })
  return frame
}

/**
 * A tinted card with a black label: readable in light and dark mode. `titled`: the first line is the card's
 * title or key (bold on tldraw; the plain first line on the new canvas, which has plain text only).
 * `heading`: the whole label is a title (a theme, a column header, a key), set in the new canvas's display
 * face (D3).
 */
function card(
  b: BoardBuilder,
  frame: PlanFrame,
  spec: Pick<GeoSpec, 'x' | 'y' | 'w' | 'h' | 'titled' | 'heading' | 'scene'> & {
    text: string
    color: LobbyColor
  },
) {
  return b.geo(frame, { ...spec, fill: 'solid', labelColor: 'black', size: 'm' })
}

/**
 * The Welcome frame's cards share one style (K4-3): the three pillars are one orange title card (the display
 * face, the dark ink, one size) with its sentence under it in one body size, and the three "try this" stickies
 * are one yellow at one scale, each centred under its pillar. (They were three different fills at three
 * different sizes, and a card in the neutral tone read as a different kind of card.) The plan test pins the
 * shared style.
 */
export const WELCOME_TITLE_H = 72
export const WELCOME_NOTE_SCALE = 1.2

function welcome(b: BoardBuilder) {
  const f = tourFrame(
    b,
    0,
    'Welcome to Lobby',
    "Dark Burn Creative's whiteboard. Every project gets a lobby: boards, files and feedback in one place, " +
      'live for the whole team.',
  )
  const pillars: ReadonlyArray<readonly [string, string]> = [
    ['Kick off', 'Briefs, references and first ideas, all on one board.'],
    ['Make', 'Plan the campaign, map the beats, pull the key art together.'],
    ['Review', 'Comments, votes and sign-off, without the email chain.'],
  ]
  pillars.forEach(([title, sentence], i) => {
    card(b, f, {
      x: col3(i),
      y: TOP,
      w: COL3_W,
      h: WELCOME_TITLE_H,
      text: title,
      color: 'orange',
      heading: true,
    })
    // headings and instructions arrive locked (PRE-07)
    b.text(f, {
      x: col3(i),
      y: TOP + WELCOME_TITLE_H + 20,
      w: COL3_W,
      text: sentence,
      size: 'm',
      color: 'black',
      locked: true,
    })
  })
  b.text(f, {
    x: M,
    y: 510,
    w: 600,
    text: 'Try this',
    size: 'l',
    color: 'black',
    locked: true,
    heading: true,
  })
  const tries = [
    // DANA-11: a client who can only comment reads this board too, so no editor-only promises.
    'Can edit? Press N and click to add a sticky. Type to fill it in.',
    'Press C, then click this note to leave a comment.',
    'Click Present at the top to walk these frames as slides.',
  ]
  const noteW = NOTE_SIZE * WELCOME_NOTE_SCALE
  tries.forEach((text, i) => {
    b.note(f, {
      x: col3(i) + (COL3_W - noteW) / 2,
      y: 590,
      text,
      color: 'yellow',
      scale: WELCOME_NOTE_SCALE,
    })
  })
  b.text(f, {
    x: M,
    y: 900,
    w: INNER_W,
    text: 'Editors can move, change or delete anything here (Ctrl/Cmd + Z undoes it). Commenters can leave comments.',
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
    'One question, ideas in clusters. Move a theme and its connectors follow.',
    // Full width, like the heading: the free column below it starts right under the intro.
    INNER_W,
  )
  // A left-to-right map (F12): the question on the left, a column of themes, each theme's ideas in a
  // row to its right. The theme column keeps empty canvas between the themes, so dragging one up or down
  // (the demo's "the connectors follow") never lands it on the ideas; the Story row keeps its third place
  // free for the idea a second person adds live.
  // The map ends at BRAINSTORM_MAP_RIGHT: the column to its right stays empty, so a private brainstorm
  // revealed into this frame lands there (apps/sync place-notes puts the notes in a frame's free space,
  // clear of its content) and the frame keeps its 16:10 slide size (round-2 F5).
  // Smaller notes keep the bottom row clear of Present's control bar.
  const noteScale = 0.85
  const noteW = NOTE_SIZE * noteScale
  const rowGap = 50
  const rowY = (i: number) => TOP + i * (noteW + rowGap)
  const qW = 300
  const qH = 200
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
  const themeX = M + qW + 100
  const themeW = 220
  const themeH = 72
  const ideasX = themeX + themeW + 40
  const ideaGap = 15
  const clusters: ReadonlyArray<{ label: string; color: LobbyColor; ideas: string[] }> = [
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
    const label = card(b, f, {
      x: themeX,
      y: y + noteW / 2 - themeH / 2,
      w: themeW,
      h: themeH,
      text: c.label,
      color: c.color,
      titled: true,
      heading: true,
    })
    b.noteGrid(
      f,
      { x: ideasX, y, cols: 3, gap: ideaGap, scale: noteScale },
      c.ideas.map((text) => ({ text, color: c.color })),
    )
    // Question to theme: a precise binding on the theme's left middle, so the fan stays tidy.
    b.arrow(question, label, { endAnchor: { x: 0, y: 0.5 }, color: 'orange', arrowheadEnd: 'none' })
  })
}

function processPlan(b: BoardBuilder) {
  const f = tourFrame(b, 2, 'Plan', 'A small process map. Drag a step and its arrows follow.')
  const boxW = 200
  const boxH = 120
  const diaW = 240
  const diaH = 180
  const gap = (INNER_W - boxW * 4 - diaW) / 4
  const rowMid = 420
  const steps: PlanShape[] = []
  let x = M
  const add = (text: string, color: LobbyColor, diamond = false) => {
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
  // Elbow routing (tldraw 5.4.2 arrow kind 'elbow', Excalidraw `elbowed`): down from the diamond, round
  // and back up.
  b.arrow(review, changes, {
    ...loop,
    elbow: true,
    startAnchor: { x: 0.5, y: 1 },
    endAnchor: { x: 1, y: 0.5 },
  })
  b.arrow(changes, concepts, {
    ...loop,
    elbow: true,
    startAnchor: { x: 0, y: 0.5 },
    endAnchor: { x: 0.5, y: 1 },
  })
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

/** The Mood board's palette: colours that keep their hue in the dark theme, DBC orange first. */
const MOOD_SWATCHES: ReadonlyArray<{ color: LobbyColor; name: string; role: string }> = [
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
    'One direction for the launch trailer. Drop an image onto a slot and it fits the slot.',
  )
  // F10: a direction that reads as finished in Present (a palette, type samples) with two reference
  // slots that invite a drop, instead of six empty boxes. No images ship with the tour: the colours
  // are Lobby's palette, the samples are text in the canvas's own fonts.
  const labelY = TOP
  const bodyY = TOP + 56
  const slotH = Math.round((COL3_W * 9) / 16)
  const typeY = bodyY + slotH + 80
  const px = col3(2)
  // Section labels first, in reading order (search and the CSV export list shapes in creation order).
  const section = (x: number, y: number, text: string) =>
    b.text(f, { x, y, w: COL3_W, text, size: 'm', color: 'black', locked: true, heading: true })
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

  // Type: three samples, each with its role on the left, named after the face it is set in. tldraw: its
  // serif, sans and mono. The new canvas has none of those but sans (decision D3: no new fonts), so it pairs
  // its display face, Lilita One, with Nunito, and never calls a face what it is not (W5-17: its Comic
  // Shanns is no "mono", and Excalifont no display serif). Until the server accepts Lilita One the display
  // samples are Nunito too, and their roles say "sans" (`displayText`: the words once it does).
  const roleW = 200
  const sampleX = M + roleW + 24
  const sampleW = col3(2) - COL_GAP - sampleX
  const samples: ReadonlyArray<{
    role: string
    text: string
    font: 'serif' | 'sans' | 'mono'
    size: 's' | 'm' | 'l' | 'xl'
    color: LobbyColor
    y: number
    /** the new canvas's face for this sample, and its role (in Nunito, and in the display face) */
    scene: { font: 'sans' | 'display'; role: string; displayRole: string }
  }> = [
    {
      role: 'Display · serif',
      text: 'Rise from the ashes',
      font: 'serif',
      size: 'xl',
      color: 'black',
      y: 0,
      scene: { font: 'display', role: 'Display · sans', displayRole: 'Display · Lilita One' },
    },
    {
      role: 'Body · sans',
      text: 'Plain words in sans, easy to read on a phone.',
      font: 'sans',
      size: 'm',
      color: 'black',
      y: 84,
      scene: { font: 'sans', role: 'Body · sans', displayRole: 'Body · Nunito' },
    },
    {
      role: 'HUD · mono',
      text: 'PRESS START · 03:14 · ARENA 7',
      font: 'mono',
      size: 'm',
      color: 'orange',
      y: 140,
      scene: { font: 'display', role: 'HUD · sans', displayRole: 'HUD · Lilita One' },
    },
  ]
  for (const s of samples) {
    const y = typeY + 50 + s.y
    b.text(f, {
      x: M,
      y: y + (s.size === 'xl' ? 18 : 3),
      w: roleW,
      text: s.role,
      size: 's',
      color: 'grey',
      scene: { text: s.scene.role, displayText: s.scene.displayRole },
    })
    b.text(f, {
      x: sampleX,
      y,
      w: sampleW,
      text: s.text,
      size: s.size,
      color: s.color,
      font: s.font,
      scene: { font: s.scene.font },
    })
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
  const f = tourFrame(b, 4, 'Retro', 'Ten minutes a column. Then run a vote to pick what to discuss first.')
  const columns: ReadonlyArray<{ title: string; color: LobbyColor; notes: string[] }> = [
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
    card(b, f, { x, y: TOP, w: COL3_W, h: 72, text: c.title, color: c.color, titled: true, heading: true })
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
  // [key, what it does] on both pages, or with the new canvas's own binding where its keys differ (the
  // keyboard's way round the board, W5-59: Tab on tldraw's page; F6 and Alt + arrows on the new canvas's,
  // apps/web/src/features/a11y/ported/index.tsx).
  const keys: ReadonlyArray<[string, string, { scene: [string, string] }?]> = [
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
    ['Tab', 'Next item', { scene: ['F6', 'Keyboard to the board'] }],
    ['Shift + Tab', 'Previous item', { scene: ['Alt + arrows', 'Next or previous item'] }],
    ['Ctrl + Shift + Down', 'Into a frame'],
    ['Ctrl + Shift + Up', 'Out of a frame'],
  ]
  const cols = 4
  const gap = 24
  const w = (INNER_W - gap * (cols - 1)) / cols
  const h = 106
  keys.forEach(([key, what, own], i) => {
    card(b, f, {
      x: M + (i % cols) * (w + gap),
      y: TOP + Math.floor(i / cols) * (h + gap),
      w,
      h,
      text: `${key}\n${what}`,
      // The first row (the making tools) in DBC orange, the rest in the neutral dark tone.
      color: i < cols ? 'orange' : 'black',
      titled: true,
      heading: true,
      ...(own ? { scene: { text: own.scene.join('\n') } } : {}),
    })
  })
  b.text(f, {
    x: M,
    y: 820,
    w: INNER_W,
    // W5-59: "?" opens Keyboard shortcuts on both pages, and the menu is the one at the top left (the
    // tldraw page's main menu, the new canvas's Board menu).
    text:
      'Edits sync live for everyone on the board. Before a big clean-up, save a checkpoint in History. ' +
      'Press ? for every other shortcut, or open Keyboard shortcuts from the menu at the top left.',
    size: 'm',
    color: 'grey',
    locked: true,
  })
}

export const lobbyTour: TemplateSource = {
  id: 'lobby-tour',
  name: 'Lobby tour',
  description:
    'A guided tour of Lobby for a first look or a demo: brainstorm, plan, mood board, retro and shortcuts.',
  category: 'sample',
  sections: LOBBY_TOUR_SECTIONS,
  plan(b) {
    welcome(b)
    brainstorm(b)
    processPlan(b)
    moodBoard(b)
    retro(b)
    tips(b)
  },
}
