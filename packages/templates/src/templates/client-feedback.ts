// Client feedback round (wave K, K4-2): pin the work being reviewed, collect the client's comments in their
// own words, sort them into do now / discuss / park, and plan the next version. Notes, frames, text and one
// empty image box (where the version being reviewed is dropped).
import { CONTENT_Y, PAD } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const SECTIONS = [
  '1 · The work',
  '2 · Their feedback',
  '3 · Do now',
  '4 · Discuss',
  '5 · Park',
  '6 · Next version',
] as const

const GAP = 80
const COL_W = 500
const ROW_W = 3 * COL_W + 2 * GAP
/** The two frames of the first row share the width of the triage row. */
const TOP_W = (ROW_W - GAP) / 2
const TOP_H = 720
const TRIAGE_Y = TOP_H + GAP
const TRIAGE_H = 660
const NEXT_Y = TRIAGE_Y + TRIAGE_H + GAP

export const clientFeedback: TemplateSource = {
  id: 'client-feedback',
  name: 'Client feedback round',
  description:
    "Collect a client's comments on a deliverable, sort them into do now, discuss and park, and plan the next version.",
  category: 'review',
  sections: SECTIONS,
  // its notes are prompts and placeholders for the team, not ideas (CR-3H-2)
  promptNotes: true,
  plan(b) {
    const work = b.section({
      x: 0,
      y: 0,
      w: TOP_W,
      h: TOP_H,
      name: SECTIONS[0],
      heading: 'Feedback round: the work',
      intro: 'Drop the version to review into the box, then say what you want feedback on and by when.',
    })
    b.imageSlot(work, {
      x: PAD,
      y: CONTENT_Y,
      w: TOP_W - PAD * 2,
      h: 260,
      label: 'Drop the version to review here: a still, a frame grab or a screenshot',
    })
    b.noteGrid(work, { x: PAD, y: CONTENT_Y + 280, cols: 3, gap: 40 }, [
      { text: 'Version and date', color: 'light-blue' },
      { text: 'What we want feedback on', color: 'yellow' },
      { text: 'Reply by: date and time', color: 'orange' },
    ])

    const feedback = b.section({
      x: TOP_W + GAP,
      y: 0,
      w: TOP_W,
      h: TOP_H,
      name: SECTIONS[1],
      heading: 'What they said',
      intro: 'One comment per sticky, in the client’s own words. Add who said it.',
    })
    b.noteGrid(feedback, { x: PAD, y: CONTENT_Y, cols: 3, gap: 60 }, [
      { text: 'Love it: what works\nFrom: …', color: 'light-green' },
      { text: 'Change it: what to rework\nFrom: …', color: 'orange' },
      { text: 'Worry: what concerns them\nFrom: …', color: 'light-red' },
      { text: 'Comment: in their words\nFrom: …', color: 'yellow' },
      { text: 'Comment: in their words\nFrom: …', color: 'yellow' },
      { text: 'Comment: in their words\nFrom: …', color: 'yellow' },
    ])
    b.chain([work, feedback], { size: 'l' })

    const triage: ReadonlyArray<{
      name: (typeof SECTIONS)[number]
      heading: string
      intro: string
      color: 'light-green' | 'light-violet' | 'grey'
      notes: string[]
    }> = [
      {
        name: SECTIONS[2],
        heading: 'Do now',
        intro: 'Clear, small and agreed. Drag these stickies here and start.',
        color: 'light-green',
        notes: ['Fix: what and where?\nOwner: …', 'Fix: what and where?\nOwner: …'],
      },
      {
        name: SECTIONS[3],
        heading: 'Discuss',
        intro: 'Needs a call, or a decision from the client.',
        color: 'light-violet',
        notes: ['Question: what do we need to decide?', 'Who decides, and by when?'],
      },
      {
        name: SECTIONS[4],
        heading: 'Park',
        intro: 'Not for this round. Keep it so it is not forgotten.',
        color: 'grey',
        notes: ['Not now: why it can wait', 'Nice to have, for later'],
      },
    ]
    triage.forEach((t, i) => {
      const col = b.section({
        x: i * (COL_W + GAP),
        y: TRIAGE_Y,
        w: COL_W,
        h: TRIAGE_H,
        name: t.name,
        heading: t.heading,
        intro: t.intro,
      })
      b.noteGrid(
        col,
        { x: PAD, y: CONTENT_Y, cols: 2 },
        t.notes.map((text) => ({ text, color: t.color })),
      )
    })

    const next = b.section({
      x: 0,
      y: NEXT_Y,
      w: ROW_W,
      h: 440,
      name: SECTIONS[5],
      heading: 'Next version',
      intro:
        'Write down what changes, who does it and what the client signs off, so the next round starts clean.',
    })
    b.noteGrid(next, { x: PAD, y: CONTENT_Y - 10, cols: 5 }, [
      { text: 'Version name and due date', color: 'light-blue' },
      { text: 'What changes, in one line', color: 'yellow' },
      { text: 'Owner', color: 'light-violet' },
      { text: 'Sign-off needed from', color: 'orange' },
      { text: 'What we told them we will not do', color: 'light-red' },
    ])
  },
}
