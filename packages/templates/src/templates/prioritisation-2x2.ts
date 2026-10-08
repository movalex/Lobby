// 2x2 prioritisation (wave K, K4-2): ideas to sort by impact and effort. A frame of loose ideas, then the four
// squares as four frames (frames never nest, so a square is a frame the ideas are dragged into). The squares'
// own words say which way impact and effort run. Frames, notes and text only.
import { CONTENT_Y, type LobbyColor, PAD } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const SECTIONS = [
  '1 · Ideas to place',
  '2 · Quick wins',
  '3 · Big bets',
  '4 · Fill-ins',
  '5 · Park it',
] as const

const GAP = 80
/** Three notes across inside a square. */
const SQUARE_W = PAD * 2 + 3 * 200 + 2 * 20
const ROW_W = 2 * SQUARE_W + GAP
const IDEAS_H = 440
const SQUARE_H = CONTENT_Y + 2 * 200 + 20 + PAD
const ROW2_Y = IDEAS_H + GAP
const ROW3_Y = ROW2_Y + SQUARE_H + GAP

interface Square {
  name: (typeof SECTIONS)[number]
  heading: string
  intro: string
  color: LobbyColor
  example: string
  x: number
  y: number
}

const SQUARES: readonly Square[] = [
  {
    name: SECTIONS[1],
    heading: 'Quick wins',
    intro: 'High impact, low effort. Do these first.',
    color: 'light-green',
    example: 'Example: a small change people will notice',
    x: 0,
    y: ROW2_Y,
  },
  {
    name: SECTIONS[2],
    heading: 'Big bets',
    intro: 'High impact, high effort. Plan these with care.',
    color: 'light-violet',
    example: 'Example: a big idea that needs a budget',
    x: SQUARE_W + GAP,
    y: ROW2_Y,
  },
  {
    name: SECTIONS[3],
    heading: 'Fill-ins',
    intro: 'Low impact, low effort. Do them if there is time.',
    color: 'light-blue',
    example: 'Example: a tidy-up for a quiet day',
    x: 0,
    y: ROW3_Y,
  },
  {
    name: SECTIONS[4],
    heading: 'Park it',
    intro: 'Low impact, high effort. Say no, for now.',
    color: 'grey',
    example: 'Example: an expensive idea few people want',
    x: SQUARE_W + GAP,
    y: ROW3_Y,
  },
]

export const prioritisation2x2: TemplateSource = {
  id: 'prioritisation-2x2',
  name: '2x2 prioritisation',
  description: 'Sort ideas by impact and effort into quick wins, big bets, fill-ins and ideas to park.',
  category: 'ideate',
  sections: SECTIONS,
  // its notes are prompts and placeholders for the team, not ideas (CR-3H-2)
  promptNotes: true,
  plan(b) {
    const ideas = b.section({
      x: 0,
      y: 0,
      w: ROW_W,
      h: IDEAS_H,
      name: SECTIONS[0],
      heading: 'Impact and effort: ideas',
      intro:
        'Write one idea per sticky. Then drag each into a square below: how much will it matter (impact), ' +
        'and how hard is it to do (effort)?',
    })
    b.noteGrid(ideas, { x: PAD, y: CONTENT_Y - 10, cols: 6 }, [
      { text: 'Idea: write it here', color: 'yellow' },
      { text: 'Idea: write it here', color: 'yellow' },
      { text: 'Idea: write it here', color: 'yellow' },
      { text: 'Idea: write it here', color: 'yellow' },
      { text: 'Idea: write it here', color: 'yellow' },
      { text: 'Idea: write it here', color: 'yellow' },
    ])

    for (const s of SQUARES) {
      const square = b.section({
        x: s.x,
        y: s.y,
        w: SQUARE_W,
        h: SQUARE_H,
        name: s.name,
        heading: s.heading,
        intro: s.intro,
      })
      b.note(square, { x: PAD, y: CONTENT_Y, text: s.example, color: s.color })
    }
  },
}
