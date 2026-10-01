// Canvas records for the ai-assist API tests: a "Brainstorm" frame with sticky notes, a heading, a
// connector label and a file card, plus loose notes, a locked note and an empty one.

import { arrow, fileCard, frame, geo, note, sid, text } from '@draftroom/tldraw-import/test-fixtures'

export const FRAME = sid('brainstorm')
export const NOTES = ['n-boss', 'n-shot', 'n-coop', 'n-villain', 'n-rewind', 'n-clips'].map(sid)
export const LOOSE = sid('loose')
export const LOCKED = sid('locked')
export const EMPTY = sid('empty')
export const FILE = sid('file')
export const HEADING = sid('heading')
export const LABEL = sid('label')
export const ARROW = sid('arrow')

export const NOTE_TEXT = [
  'Open on the boss fight',
  'One unbroken shot through the new map',
  'Show the co-op move up close',
  "Tell it from the villain's side",
  'Start at the ending, then rewind',
  'Cut it from real player clips',
]

export function brainstormShapes() {
  const f = frame('brainstorm', 'Brainstorm', { w: 1600, h: 1000 })
  const inFrame = { parentId: FRAME }
  return [
    f,
    text('heading', 'Launch trailer: what is the hook?', { ...inFrame, x: 80, y: 40 }),
    geo('label', 'Gameplay', { ...inFrame, x: 560, y: 260, w: 240, h: 72 }),
    arrow('arrow', 'leads to', { ...inFrame, x: 400, y: 300 }),
    ...NOTE_TEXT.map((t, i) =>
      note(NOTES[i]?.slice('shape:'.length) ?? `n${i}`, t, {
        ...inFrame,
        x: 850 + (i % 3) * 200,
        y: 260 + Math.floor(i / 3) * 220,
      }),
    ),
    fileCard('file', 'CONFIDENTIAL-budget-plan.pdf', { ...inFrame, x: 80, y: 700 }),
    note('locked', 'This note is locked', { ...inFrame, x: 850, y: 700 }),
    note('empty', '', { ...inFrame, x: 1050, y: 700 }),
    note('loose', 'A loose note outside the frame', { x: 2000, y: 0 }),
  ].map((s) => (s.id === LOCKED ? { ...s, isLocked: true } : s))
}
