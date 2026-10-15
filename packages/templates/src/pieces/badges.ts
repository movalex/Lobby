// The badges kit: status stamps (Approved, Draft, Needs review, Priority, Done, WIP), a plain label and the number
// badges 1 to 10 (one each, and a row of all ten). A stamp is a pill on a pale tint with a bold outline in its
// colour and the words in the dark ink; a number badge is the same in a circle. Original work.
import type { BoardBuilder, LobbyColor } from '../builder.ts'
import { type El, elOf, INK, type PieceDef, round } from './kit.ts'

const pill = (text: string, color: LobbyColor, w: number, h = 48): PieceDef => ({
  build(b: BoardBuilder) {
    const node = b.geo(null, { x: 0, y: 0, w, h, text, color, fill: 'solid', labelColor: INK, size: 'm' })
    return (out) => {
      round(elOf(out, node), h / 2)
      return out.elements as unknown as El[]
    }
  },
})

const circle = (n: number): PieceDef => ({
  build(b: BoardBuilder) {
    b.geo(null, {
      x: 0,
      y: 0,
      w: 60,
      h: 60,
      geo: 'ellipse',
      text: String(n),
      color: 'blue',
      fill: 'solid',
      labelColor: INK,
      size: 'm',
    })
    return undefined
  },
})

export const BADGE_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const

const numbered = Object.fromEntries(BADGE_NUMBERS.map((n) => [`number-${n}`, circle(n)])) as Record<
  `number-${(typeof BADGE_NUMBERS)[number]}`,
  PieceDef
>

export const BADGE_PIECES = {
  approved: pill('APPROVED', 'green', 168),
  draft: pill('DRAFT', 'grey', 124),
  'needs-review': pill('NEEDS REVIEW', 'yellow', 212),
  priority: pill('PRIORITY', 'red', 156),
  done: pill('DONE', 'blue', 116),
  wip: pill('WIP', 'orange', 96),
  label: pill('Label', 'light-violet', 120, 40),
  ...numbered,
  'numbers-row': {
    build(b: BoardBuilder) {
      for (const n of BADGE_NUMBERS) {
        b.geo(null, {
          x: (n - 1) * 72,
          y: 0,
          w: 60,
          h: 60,
          geo: 'ellipse',
          text: String(n),
          color: 'blue',
          fill: 'solid',
          labelColor: INK,
          size: 'm',
        })
      }
      return undefined
    },
  },
} satisfies Record<string, PieceDef>
