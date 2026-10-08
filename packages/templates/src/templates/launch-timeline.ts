// Launch timeline (wave K, K4-2): the milestones of a launch as one connected row, then four phases (prepare,
// lock, launch, learn) with the tasks that belong to each. Frames, notes, boxes, arrows and text only.
import { CONTENT_Y, type LobbyColor, PAD, type PlanShape } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const SECTIONS = ['1 · The road to launch', '2 · Prepare', '3 · Lock', '4 · Launch', '5 · Learn'] as const

const GAP = 80
const PHASE_W = 340
const ROW_W = 4 * PHASE_W + 3 * GAP
const ROAD_H = 440
const PHASES_Y = ROAD_H + GAP
const PHASE_H = CONTENT_Y + 3 * 220 + 20

const MILESTONE_W = 220
const MILESTONE_H = 120

interface Phase {
  heading: string
  intro: string
  color: LobbyColor
  notes: string[]
}

const PHASES: readonly Phase[] = [
  {
    heading: 'Prepare',
    intro: 'Four weeks out: the brief, the assets and the approvals.',
    color: 'light-blue',
    notes: ['Brief signed off\nOwner: …', 'Assets in production\nOwner: …', 'Approvals booked\nOwner: …'],
  },
  {
    heading: 'Lock',
    intro: 'The last week: nothing new goes in, everything is checked.',
    color: 'light-violet',
    notes: ['Final assets approved\nOwner: …', 'Posts and ads scheduled', 'Team briefed on launch day'],
  },
  {
    heading: 'Launch',
    intro: 'Launch day: go, watch, and answer fast.',
    color: 'orange',
    notes: ['Go or no-go call\nOwner: …', 'Publish and announce', 'Watch the replies and respond'],
  },
  {
    heading: 'Learn',
    intro: 'A week after: what happened, and what next?',
    color: 'light-green',
    notes: ['Results against the goal', 'What worked, what did not', 'Next steps and owners'],
  },
]

const MILESTONES: ReadonlyArray<readonly [string, LobbyColor]> = [
  ['Brief signed\nDate: …', 'light-blue'],
  ['Assets locked\nDate: …', 'light-violet'],
  ['Go or no-go\nDate: …', 'yellow'],
  ['Launch day\nDate: …', 'orange'],
  ['Report shared\nDate: …', 'light-green'],
]

export const launchTimeline: TemplateSource = {
  id: 'launch-timeline',
  name: 'Launch timeline',
  description:
    'Plan a launch from the brief to the report: connected milestones, then the tasks for prepare, lock, launch and learn.',
  category: 'plan',
  sections: SECTIONS,
  // its notes are prompts and placeholders for the team, not ideas (CR-3H-2)
  promptNotes: true,
  plan(b) {
    const road = b.section({
      x: 0,
      y: 0,
      w: ROW_W,
      h: ROAD_H,
      name: SECTIONS[0],
      heading: 'Launch timeline: campaign name',
      intro:
        'Put a date on every milestone first. The arrows are attached, so they follow when you move one.',
    })
    const gap = (ROW_W - PAD * 2 - MILESTONES.length * MILESTONE_W) / (MILESTONES.length - 1)
    const steps: PlanShape[] = MILESTONES.map(([text, color], i) =>
      b.geo(road, {
        x: PAD + i * (MILESTONE_W + gap),
        y: CONTENT_Y + 30,
        w: MILESTONE_W,
        h: MILESTONE_H,
        text,
        color,
        labelColor: 'black',
        fill: 'solid',
        size: 's',
        titled: true,
      }),
    )
    b.chain(steps, { color: 'black', size: 'm' })

    PHASES.forEach((phase, i) => {
      const col = b.section({
        x: i * (PHASE_W + GAP),
        y: PHASES_Y,
        w: PHASE_W,
        h: PHASE_H,
        name: SECTIONS[i + 1] ?? '',
        heading: phase.heading,
        intro: phase.intro,
      })
      b.noteGrid(
        col,
        { x: (PHASE_W - 200) / 2, y: CONTENT_Y, cols: 1 },
        phase.notes.map((text) => ({ text, color: phase.color })),
      )
    })
  },
}
