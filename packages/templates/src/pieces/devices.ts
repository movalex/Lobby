// The device mockups: a phone, a tablet, a laptop, a browser window and a TV, each with its screen as an image slot
// (the template slot marker, no file) so a screenshot dropped on it fills the screen. Bezels are the full ink
// colour, details (a camera, a notch, a stand) are plain shapes. Original work.
import type { BoardBuilder, PlanNode } from '../builder.ts'
import type { SceneEmitResult } from '../scene/emit.ts'
import { type El, elOf, MUTED, type PieceDef, round, unlockSlot } from './kit.ts'

/** Rounds each box's corners (`radius` px), and answers the emitted elements. */
function rounded(out: SceneEmitResult, pairs: readonly (readonly [PlanNode, number])[]): El[] {
  for (const [node, radius] of pairs) round(elOf(out, node), radius)
  return out.elements as unknown as El[]
}

export const DEVICE_PIECES = {
  'device-phone': {
    build(b: BoardBuilder) {
      const body = b.geo(null, { x: 0, y: 0, w: 300, h: 620, color: 'black', fill: 'fill' })
      const screen = b.imageSlot(null, { x: 14, y: 14, w: 272, h: 592, label: 'Screen' })
      const island = b.geo(null, { x: 102, y: 28, w: 96, h: 26, color: 'black', fill: 'fill' })
      const bar = b.geo(null, { x: 98, y: 594, w: 104, h: 6, color: 'grey', fill: 'fill' })
      return (out) => {
        unlockSlot(elOf(out, screen))
        return rounded(out, [
          [body, 48],
          [screen, 36],
          [island, 13],
          [bar, 3],
        ])
      }
    },
  },
  'device-tablet': {
    build(b: BoardBuilder) {
      const body = b.geo(null, { x: 0, y: 0, w: 540, h: 720, color: 'black', fill: 'fill' })
      const screen = b.imageSlot(null, { x: 24, y: 24, w: 492, h: 672, label: 'Screen' })
      b.geo(null, { x: 266, y: 8, w: 8, h: 8, geo: 'ellipse', color: 'grey', fill: 'fill' })
      return (out) => {
        unlockSlot(elOf(out, screen))
        return rounded(out, [
          [body, 40],
          [screen, 12],
        ])
      }
    },
  },
  'device-laptop': {
    build(b: BoardBuilder) {
      const lid = b.geo(null, { x: 60, y: 0, w: 640, h: 420, color: 'black', fill: 'fill' })
      const screen = b.imageSlot(null, { x: 76, y: 16, w: 608, h: 388, label: 'Screen' })
      const base = b.geo(null, { x: 0, y: 420, w: 760, h: 26, color: 'grey', fill: 'solid' })
      const notch = b.geo(null, { x: 330, y: 420, w: 100, h: 8, color: 'grey', fill: 'fill' })
      return (out) => {
        unlockSlot(elOf(out, screen))
        return rounded(out, [
          [lid, 22],
          [screen, 6],
          [base, 12],
          [notch, 4],
        ])
      }
    },
  },
  'device-browser': {
    build(b: BoardBuilder) {
      b.geo(null, { x: 0, y: 0, w: 800, h: 520, color: 'grey', fill: 'semi' })
      b.geo(null, { x: 0, y: 0, w: 800, h: 56, color: 'grey', fill: 'solid' })
      b.geo(null, { x: 18, y: 22, w: 12, h: 12, geo: 'ellipse', color: 'light-red', fill: 'fill' })
      b.geo(null, { x: 38, y: 22, w: 12, h: 12, geo: 'ellipse', color: 'yellow', fill: 'fill' })
      b.geo(null, { x: 58, y: 22, w: 12, h: 12, geo: 'ellipse', color: 'light-green', fill: 'fill' })
      const url = b.geo(null, {
        x: 96,
        y: 10,
        w: 560,
        h: 36,
        text: 'example.com',
        color: 'grey',
        fill: 'semi',
        labelColor: MUTED,
      })
      const screen = b.imageSlot(null, { x: 10, y: 66, w: 780, h: 444, label: 'Page' })
      return (out) => {
        unlockSlot(elOf(out, screen))
        return rounded(out, [[url, 18]])
      }
    },
  },
  'device-tv': {
    build(b: BoardBuilder) {
      const bezel = b.geo(null, { x: 0, y: 0, w: 800, h: 464, color: 'black', fill: 'fill' })
      const screen = b.imageSlot(null, { x: 16, y: 16, w: 768, h: 432, label: 'Screen' })
      b.geo(null, { x: 360, y: 464, w: 80, h: 30, color: 'grey', fill: 'solid' })
      const foot = b.geo(null, { x: 270, y: 494, w: 260, h: 14, color: 'grey', fill: 'solid' })
      return (out) => {
        unlockSlot(elOf(out, screen))
        return rounded(out, [
          [bezel, 18],
          [screen, 4],
          [foot, 7],
        ])
      }
    },
  },
} satisfies Record<string, PieceDef>
