import { CONTENT_Y, type LobbyColor, PAD, type PlanFrame } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const COL_W = 500
const COL_GAP = 80
const COLS_Y = 540
const COL_H = 720

interface Step {
  name: string
  heading: string
  intro: string
  color: LobbyColor
  prompts: string[]
  visual?: string
}

const STEPS: Step[] = [
  {
    name: '1 · Problem',
    heading: 'Problem',
    intro: 'Start with a real person and a real pain.',
    color: 'light-red',
    prompts: [
      'Who has the problem?',
      'What does it cost them today?',
      "Why hasn't it been solved yet?",
      'Why does it matter now?',
    ],
  },
  {
    name: '2 · Insight',
    heading: 'Insight',
    intro: 'What do we see that others miss?',
    color: 'light-violet',
    prompts: [
      'The insight in one line',
      'Evidence: a quote, a number or an observation',
      'What most people assume instead',
    ],
  },
  {
    name: '3 · Idea',
    heading: 'Idea',
    intro: 'Our answer, simple enough to repeat.',
    color: 'yellow',
    prompts: ['The idea in one sentence', 'How it works, in three steps'],
    visual: 'Key visual or sketch',
  },
  {
    name: '4 · Proof',
    heading: 'Proof',
    intro: 'Why they should believe it will work.',
    color: 'light-green',
    prompts: [
      'Tests, pilots or early results',
      'Why us: team, craft, track record',
      'Risks, and how we handle them',
    ],
  },
  {
    name: '5 · Ask',
    heading: 'Ask',
    intro: 'Be specific about what you need.',
    color: 'light-blue',
    prompts: [
      'Exactly what we need: budget, time, a decision',
      'What happens in the first 30 days',
      "How we'll measure success",
    ],
  },
]

const GLANCE = 'Pitch at a glance'
const SECTIONS = [GLANCE, ...STEPS.map((s) => s.name)]

export const pitchOutline: TemplateSource = {
  id: 'pitch-outline',
  name: 'Pitch outline',
  description: 'Shape a pitch step by step, from the problem and insight to the idea, proof and a clear ask.',
  category: 'plan',
  sections: SECTIONS,
  // its notes are prompts and placeholders for the team, not ideas (CR-3H-2)
  promptNotes: true,
  plan(b) {
    const totalW = STEPS.length * COL_W + (STEPS.length - 1) * COL_GAP

    const glance = b.section({
      x: 0,
      y: 0,
      w: totalW,
      h: 420,
      name: GLANCE,
      heading: 'Pitch outline: project name',
      intro:
        'Build the story left to right. Each column should land one point; ' +
        "cut anything that doesn't earn its place.",
    })
    b.noteGrid(glance, { x: PAD, y: CONTENT_Y - 10, cols: 7 }, [
      { text: 'Who are we pitching to?', color: 'yellow' },
      { text: 'What do we want them to decide?', color: 'light-blue' },
      { text: 'The pitch in one line', color: 'light-green' },
      { text: 'What do they already believe, or doubt?', color: 'light-violet' },
      { text: 'Time we have: e.g. 10 min + Q&A', color: 'orange' },
      { text: "Opening line: how we'll start the room", color: 'light-red' },
      { text: 'Closing line: the last thing they hear', color: 'yellow' },
    ])

    const columns: PlanFrame[] = []
    STEPS.forEach((step, i) => {
      const col = b.section({
        x: i * (COL_W + COL_GAP),
        y: COLS_Y,
        w: COL_W,
        h: COL_H,
        name: step.name,
        heading: step.heading,
        intro: step.intro,
      })
      const notes = b.noteGrid(
        col,
        { x: PAD, y: CONTENT_Y, cols: 2 },
        step.prompts.map((text) => ({ text, color: step.color })),
      )
      if (step.visual) {
        const rows = Math.ceil(notes.length / 2)
        b.imageSlot(col, {
          x: PAD,
          y: CONTENT_Y + rows * 220,
          w: COL_W - PAD * 2,
          h: 240,
          label: step.visual,
        })
      }
      columns.push(col)
    })

    b.chain(columns, { size: 'l' })
  },
}
