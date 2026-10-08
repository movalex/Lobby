// Kanban columns (wave K, K4-2): five columns from backlog to done, each a frame that holds its cards. Frames
// never nest, so a column is a frame the cards are dragged between (a frame moves with its cards). The
// starter cards are placeholders showing what a card says. Frames, notes and text only.
import { CONTENT_Y, type LobbyColor } from '../builder.ts'
import type { TemplateSource } from '../source.ts'

const SECTIONS = ['1 · Backlog', '2 · This week', '3 · In progress', '4 · In review', '5 · Done'] as const

const COL_W = 320
const GAP = 60
const COL_H = CONTENT_Y + 4 * 220 + 20

interface Column {
  heading: string
  intro: string
  color: LobbyColor
  cards: number
}

const COLUMNS: readonly Column[] = [
  { heading: 'Backlog', intro: 'Everything we might do. Sort it by value.', color: 'grey', cards: 3 },
  {
    heading: 'This week',
    intro: 'What we will finish. Pull it from the backlog.',
    color: 'yellow',
    cards: 2,
  },
  {
    heading: 'In progress',
    intro: 'Limit: three at a time. Finish before you start.',
    color: 'light-blue',
    cards: 2,
  },
  { heading: 'In review', intro: 'Ready for a second pair of eyes.', color: 'light-violet', cards: 1 },
  { heading: 'Done', intro: 'Shipped and signed off. Well done.', color: 'light-green', cards: 1 },
]

export const kanban: TemplateSource = {
  id: 'kanban',
  name: 'Kanban columns',
  description:
    'Track work from backlog to done in five columns, with starter cards for task, owner and date.',
  category: 'plan',
  sections: SECTIONS,
  // its notes are prompts and placeholders for the team, not ideas (CR-3H-2)
  promptNotes: true,
  plan(b) {
    COLUMNS.forEach((c, i) => {
      const col = b.section({
        x: i * (COL_W + GAP),
        y: 0,
        w: COL_W,
        h: COL_H,
        name: SECTIONS[i] ?? '',
        heading: c.heading,
        intro: c.intro,
      })
      b.noteGrid(
        col,
        { x: (COL_W - 200) / 2, y: CONTENT_Y, cols: 1 },
        Array.from({ length: c.cards }, () => ({ text: 'Task: …\nOwner: …\nDue: …', color: c.color })),
      )
    })
  },
}
