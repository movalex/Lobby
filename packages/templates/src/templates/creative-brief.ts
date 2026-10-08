// Creative brief (wave K, K4-2): the one page an agency fills in with the client before design starts. Five
// frames in three rows (the ask and the audience, the message and the look, then deliverables), written once
// against the plan builder like every template. Notes, frames, text and empty image boxes only (the
// reference boxes are slots a person drops images onto; nothing ships with the template).
import { CONTENT_Y, PAD } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const SECTIONS = [
  '1 · The ask',
  '2 · Audience',
  '3 · Message and tone',
  '4 · Look and feel',
  '5 · Deliverables and dates',
] as const

const GAP = 80
/** Three notes across, and two across. */
const WIDE_W = PAD * 2 + 3 * 200 + 2 * 20
const NARROW_W = PAD * 2 + 2 * 200 + 20
const ROW_W = WIDE_W + GAP + NARROW_W
const ROW_H = 650
const ROW2_Y = ROW_H + GAP
const ROW3_Y = ROW2_Y + ROW_H + GAP

export const creativeBrief: TemplateSource = {
  id: 'creative-brief',
  name: 'Creative brief',
  description:
    'Agree the ask, the audience, the message, the look and the deliverables on one page before the work starts.',
  category: 'plan',
  sections: SECTIONS,
  // its notes are prompts and placeholders for the team, not ideas (CR-3H-2)
  promptNotes: true,
  plan(b) {
    const ask = b.section({
      x: 0,
      y: 0,
      w: WIDE_W,
      h: ROW_H,
      name: SECTIONS[0],
      heading: 'Creative brief: project name',
      intro: 'Fill this in with the client before anyone opens a design tool. One page, plain words.',
    })
    b.noteGrid(ask, { x: PAD, y: CONTENT_Y, cols: 3 }, [
      { text: 'Client and project', color: 'yellow' },
      { text: 'The problem we are solving', color: 'light-red' },
      { text: 'One goal we can measure', color: 'light-green' },
      { text: 'What does success look like?', color: 'light-blue' },
      { text: 'Budget and limits', color: 'orange' },
      { text: 'Must-haves: logos, legal, brand rules', color: 'light-violet' },
    ])

    const audience = b.section({
      x: WIDE_W + GAP,
      y: 0,
      w: NARROW_W,
      h: ROW_H,
      name: SECTIONS[1],
      heading: 'Who it is for',
      intro: 'Describe one real person, not a demographic.',
    })
    b.noteGrid(audience, { x: PAD, y: CONTENT_Y, cols: 2 }, [
      { text: 'Who are they? Role, age, context', color: 'light-blue' },
      { text: 'What do they think and feel today?', color: 'yellow' },
      { text: 'What should they do after?', color: 'light-green' },
      { text: 'Where will they meet it?', color: 'orange' },
    ])

    const message = b.section({
      x: 0,
      y: ROW2_Y,
      w: NARROW_W,
      h: ROW_H,
      name: SECTIONS[2],
      heading: 'Message and tone',
      intro: 'Say it in one sentence, then in three words.',
    })
    b.noteGrid(message, { x: PAD, y: CONTENT_Y, cols: 2 }, [
      { text: 'The one thing to remember', color: 'yellow' },
      { text: 'Proof: why they should believe it', color: 'light-blue' },
      { text: 'Tone of voice: three words', color: 'light-violet' },
      { text: 'Not this: what to avoid', color: 'light-red' },
    ])

    const look = b.section({
      x: NARROW_W + GAP,
      y: ROW2_Y,
      w: WIDE_W,
      h: ROW_H,
      name: SECTIONS[3],
      heading: 'Look and feel',
      intro: 'Drop three references onto the boxes: work you admire. Then say what you like about it.',
    })
    for (let i = 0; i < 3; i++)
      b.imageSlot(look, { x: PAD + i * 220, y: CONTENT_Y, w: 200, h: 200, label: `Reference ${i + 1}` })
    b.noteGrid(look, { x: PAD, y: CONTENT_Y + 220, cols: 3 }, [
      { text: 'What we love about these', color: 'yellow' },
      { text: 'Colour and type direction', color: 'light-blue' },
      { text: 'Anything we must avoid', color: 'light-red' },
    ])

    const deliver = b.section({
      x: 0,
      y: ROW3_Y,
      w: ROW_W,
      h: 440,
      name: SECTIONS[4],
      heading: 'Deliverables and dates',
      intro: 'List what we are making, who approves it and when it is due.',
    })
    b.noteGrid(deliver, { x: PAD, y: CONTENT_Y - 10, cols: 5 }, [
      { text: 'Deliverable 1: format and size', color: 'light-green' },
      { text: 'Deliverable 2: format and size', color: 'light-green' },
      { text: 'Deliverable 3: format and size', color: 'light-green' },
      { text: 'Key dates: reviews and launch', color: 'orange' },
      { text: 'Who signs off?', color: 'light-violet' },
    ])
  },
}
