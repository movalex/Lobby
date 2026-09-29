import { CONTENT_Y, type LobbyColor, PAD } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const SECTIONS = ['1 · Brainstorm', '2 · Shortlist', '3 · Parking lot'] as const

const MAP_W = 1680
const MAP_H = 1100
const SIDE_X = MAP_W + 80
const SIDE_W = 560
const LABEL_W = 440
const LABEL_H = 72
const TOP_ROW_Y = 220
const BOTTOM_ROW_Y = 700

interface Cluster {
  x: number
  y: number
  color: LobbyColor
  label: string
  prompts: [string, string]
  /** Which side of the label faces the central question. */
  inner: 'left' | 'right'
}

const CLUSTERS: Cluster[] = [
  {
    x: PAD,
    y: TOP_ROW_Y,
    color: 'yellow',
    label: 'Theme 1: name it',
    prompts: ['Get the obvious ideas out first', 'Build on the idea next to yours'],
    inner: 'right',
  },
  {
    x: MAP_W - PAD - LABEL_W,
    y: TOP_ROW_Y,
    color: 'light-blue',
    label: 'Theme 2: name it',
    prompts: ['Borrow from another field', 'Mix two ideas into one'],
    inner: 'left',
  },
  {
    x: PAD,
    y: BOTTOM_ROW_Y,
    color: 'light-green',
    label: 'Theme 3: name it',
    prompts: ['Flip it: how could we make it worse?', 'Go big: no budget, no rules'],
    inner: 'right',
  },
  {
    x: MAP_W - PAD - LABEL_W,
    y: BOTTOM_ROW_Y,
    color: 'light-violet',
    label: 'Theme 4: name it',
    prompts: ['Make it tiny: what could we try tomorrow?', 'Who would love this, and why?'],
    inner: 'left',
  },
]

export const brainstorm: TemplateSource = {
  id: 'brainstorm',
  name: 'Brainstorm',
  description: 'Gather ideas around one central question, cluster them into themes and shortlist the best.',
  category: 'ideate',
  sections: SECTIONS,
  plan(b) {
    const map = b.section({
      x: 0,
      y: 0,
      w: MAP_W,
      h: MAP_H,
      name: SECTIONS[0],
      heading: 'One question, many ideas',
      intro:
        'Rewrite the question in the middle. Write silently for 8 minutes, one idea per sticky. ' +
        'Then group related ideas under a theme and rename it.',
    })

    const questionW = 440
    const questionH = 220
    // Vertically centred between the top and bottom rows of theme labels.
    const labelMid = (TOP_ROW_Y + BOTTOM_ROW_Y) / 2 + LABEL_H / 2
    const question = b.geo(map, {
      x: (MAP_W - questionW) / 2,
      y: labelMid - questionH / 2,
      w: questionW,
      h: questionH,
      geo: 'ellipse',
      text: 'How might we…?\nWrite your question here',
      color: 'violet',
      labelColor: 'white',
      fill: 'fill',
      size: 'l',
    })

    for (const c of CLUSTERS) {
      const label = b.geo(map, {
        x: c.x,
        y: c.y,
        w: LABEL_W,
        h: LABEL_H,
        text: c.label,
        color: c.color,
        fill: 'solid',
        size: 'm',
      })
      b.noteGrid(map, { x: c.x, y: c.y + LABEL_H + 24, cols: 2, gap: LABEL_W - 400 }, [
        { text: c.prompts[0], color: c.color },
        { text: c.prompts[1], color: c.color },
      ])
      // Connect to the label's inner edge so the line never crosses the theme's notes.
      b.arrow(question, label, {
        endAnchor: { x: c.inner === 'right' ? 1 : 0, y: 0.5 },
        arrowheadEnd: 'none',
        color: 'grey',
      })
    }

    const shortlist = b.section({
      x: SIDE_X,
      y: 0,
      w: SIDE_W,
      h: 640,
      name: SECTIONS[1],
      heading: 'Shortlist',
      intro: 'Dot-vote: 3 dots each. Move the ideas with the most votes here.',
    })
    b.noteGrid(shortlist, { x: PAD, y: CONTENT_Y - 10, cols: 2, gap: 40, gapY: 20 }, [
      { text: 'Top pick: why this one?', color: 'yellow' },
      { text: 'Runner-up', color: 'yellow' },
      { text: 'Next step: who explores it, and by when?', color: 'light-green' },
    ])

    const parking = b.section({
      x: SIDE_X,
      y: 760,
      w: SIDE_W,
      h: MAP_H - 760,
      name: SECTIONS[2],
      heading: 'Parking lot',
    })
    b.text(parking, {
      x: PAD,
      y: 100,
      w: 220,
      text: 'Good ideas for another day. Revisit them before you wrap up.',
      size: 's',
      color: 'grey',
      locked: true, // an instruction (PRE-07)
    })
    b.note(parking, { x: SIDE_W - PAD - 200, y: 100, text: 'Idea for later', color: 'orange' })
  },
}
