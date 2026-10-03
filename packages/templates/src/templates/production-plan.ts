import { CONTENT_Y, NOTE_GAP, PAD, type PlanFrame } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const COL_W = 500
const COL_GAP = 80
const PHASES_Y = 540
const PHASE_H = 860
const RISKS_Y = PHASES_Y + PHASE_H + 120

interface Phase {
  name: string
  heading: string
  intro: string
  tasks: string[]
  deliverable: string
}

const PHASES: Phase[] = [
  {
    name: '1 · Brief',
    heading: 'Brief',
    intro: "Agree what we're making, for whom, and why.",
    tasks: ['Goals, audience and key message', 'Budget and timeline agreed'],
    deliverable: 'Deliverable: signed-off brief',
  },
  {
    name: '2 · Pre-production',
    heading: 'Pre-production',
    intro: 'Plan everything before the camera rolls.',
    tasks: ['Script and storyboard', 'Casting and locations', 'Crew, kit and schedule'],
    deliverable: 'Deliverable: shoot plan',
  },
  {
    name: '3 · Production',
    heading: 'Production',
    intro: 'Capture everything we need, safely.',
    tasks: ['Shoot days', 'Back up and log footage daily'],
    deliverable: 'Deliverable: all footage and assets',
  },
  {
    name: '4 · Post-production',
    heading: 'Post-production',
    intro: 'Shape the story and polish it.',
    tasks: ['Edit and review rounds', 'Color, sound and graphics'],
    deliverable: 'Deliverable: picture lock',
  },
  {
    name: '5 · Delivery',
    heading: 'Delivery',
    intro: 'Approve, export and hand over.',
    tasks: ['Final approvals', 'Exports, captions and versions', 'Archive the project files'],
    deliverable: 'Deliverable: masters delivered',
  },
]

const OVERVIEW = 'Project overview'
const RISKS = 'Risks & dependencies'
const SECTIONS = [OVERVIEW, ...PHASES.map((p) => p.name), RISKS]

export const productionPlan: TemplateSource = {
  id: 'production-plan',
  name: 'Production plan',
  description: 'Map a production from brief to delivery, with owners, dates, deliverables and risks.',
  category: 'plan',
  sections: SECTIONS,
  // its notes are prompts and placeholders for the team, not ideas (CR-3H-2)
  promptNotes: true,
  plan(b) {
    const totalW = PHASES.length * COL_W + (PHASES.length - 1) * COL_GAP

    const overview = b.section({
      x: 0,
      y: 0,
      w: totalW,
      h: 420,
      name: OVERVIEW,
      heading: 'Production plan: project name',
      intro:
        'Work left to right. Give every phase an owner, dates and one clear deliverable, ' +
        'and move tasks along as they finish.',
    })
    b.noteGrid(overview, { x: PAD, y: CONTENT_Y - 10, cols: 5 }, [
      { text: 'Final deadline', color: 'light-red' },
      { text: 'Budget', color: 'yellow' },
      { text: 'Team and roles', color: 'light-violet' },
      { text: 'Who signs off?', color: 'light-blue' },
      { text: 'Deliverables and formats', color: 'light-green' },
    ])

    const phases: PlanFrame[] = []
    PHASES.forEach((phase, i) => {
      const col = b.section({
        x: i * (COL_W + COL_GAP),
        y: PHASES_Y,
        w: COL_W,
        h: PHASE_H,
        name: phase.name,
        heading: phase.heading,
        intro: phase.intro,
      })
      const step = 200 + NOTE_GAP
      b.note(col, { x: PAD, y: CONTENT_Y, text: 'Owner: …', color: 'light-violet' })
      b.note(col, { x: PAD + step, y: CONTENT_Y, text: 'Dates: start – end', color: 'light-blue' })
      b.noteGrid(col, { x: PAD, y: CONTENT_Y + step, cols: 2 }, [
        ...phase.tasks.map((text) => ({ text, color: 'yellow' as const })),
        { text: phase.deliverable, color: 'light-green' },
      ])
      phases.push(col)
    })

    b.chain(phases, { size: 'l' })

    const risks = b.section({
      x: 0,
      y: RISKS_Y,
      w: totalW,
      h: 420,
      name: RISKS,
      heading: 'Risks and dependencies',
      intro: 'What could knock the plan off course, and what are we waiting on from others?',
    })
    b.noteGrid(risks, { x: PAD, y: CONTENT_Y - 10, cols: 4 }, [
      { text: 'What could delay us?', color: 'light-red' },
      { text: 'What are we waiting on from others?', color: 'orange' },
      { text: 'Plan B: weather, location, people', color: 'yellow' },
      { text: "Key dates we can't move", color: 'light-violet' },
    ])
  },
}
