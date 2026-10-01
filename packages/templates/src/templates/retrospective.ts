import { CONTENT_Y, type LobbyColor, PAD } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const COL_W = 800
const COL_GAP = 80
const COLS_Y = 540
const COL_H = 960

interface Column {
  name: string
  heading: string
  intro: string
  color: LobbyColor
  prompts: string[]
}

const COLUMNS: Column[] = [
  {
    name: '2 · What went well',
    heading: 'What went well',
    intro: "Wins, good habits and moments we're proud of.",
    color: 'light-green',
    prompts: ['What helped us most?', "A moment we're proud of", 'Who do we want to thank?'],
  },
  {
    name: '3 · What to improve',
    heading: 'What to improve',
    intro: 'Friction, surprises and anything that slowed us down.',
    color: 'orange',
    prompts: ['What slowed us down?', 'What surprised us?', 'What would we do differently next time?'],
  },
  {
    name: '4 · Actions',
    heading: 'Actions',
    intro: 'Turn the top themes into a few concrete steps. Each one needs an owner and a date.',
    color: 'light-blue',
    prompts: ['Action: …\nOwner: …\nDue: …', 'Action: …\nOwner: …\nDue: …', 'Action: …\nOwner: …\nDue: …'],
  },
]

const CHECK_IN = '1 · Check-in'
const SECTIONS = [CHECK_IN, ...COLUMNS.map((c) => c.name)]

export const retrospective: TemplateSource = {
  id: 'retrospective',
  name: 'Retrospective',
  description: "Look back as a team: what went well, what to improve, and the actions you'll take next.",
  category: 'review',
  sections: SECTIONS,
  plan(b) {
    const totalW = COLUMNS.length * COL_W + (COLUMNS.length - 1) * COL_GAP

    const checkIn = b.section({
      x: 0,
      y: 0,
      w: totalW,
      h: 420,
      name: CHECK_IN,
      heading: 'Retrospective: team, sprint or project',
      intro:
        "Agree the goal, check the mood and review last time's actions. Then spend about 10 minutes " +
        'per column, and dot-vote (3 each) on what to discuss first.',
    })
    b.noteGrid(checkIn, { x: PAD, y: CONTENT_Y - 10, cols: 5 }, [
      { text: 'Goal of this retro', color: 'light-violet' },
      { text: 'Mood check: one word each', color: 'yellow' },
      { text: "Last time's actions: done, doing or dropped?", color: 'light-blue' },
      { text: 'Timebox: about 10 min per column', color: 'orange' },
      { text: 'Focus on the work, not the person', color: 'light-green' },
    ])

    COLUMNS.forEach((c, i) => {
      const col = b.section({
        x: i * (COL_W + COL_GAP),
        y: COLS_Y,
        w: COL_W,
        h: COL_H,
        name: c.name,
        heading: c.heading,
        intro: c.intro,
      })
      b.noteGrid(
        col,
        { x: PAD, y: CONTENT_Y, cols: 3 },
        c.prompts.map((text) => ({ text, color: c.color })),
      )
    })
  },
}
