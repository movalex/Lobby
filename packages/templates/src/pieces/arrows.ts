// The arrows kit: free arrows (straight, dashed, curved, double, a U-turn, a pointer) and block arrows (right, left,
// up, down, both ways, a chevron and a pentagon step). A free arrow is bound to nothing, so a person drags its ends
// onto shapes and the room derives the bound ends; a block arrow is a closed polygon `line` under a see-through box
// that carries its label (the same build as the flowchart's data shape). Original work.
import type { BoardBuilder } from '../builder.ts'
import {
  type ArrowStyle,
  arrowEl,
  asPolygon,
  blockArrow,
  type Direction,
  type El,
  elOf,
  freshId,
  INK,
  type PieceDef,
  type Pt,
} from './kit.ts'

/** A piece that is one free arrow: nothing is built, the arrow is added to the (empty) emitted scene. */
const freeArrow = (points: readonly Pt[], style: ArrowStyle): PieceDef => ({
  build() {
    return (out) => [...(out.elements as unknown as El[]), arrowEl(undefined, freshId, points, style)]
  },
})

const block = (
  dir: Direction,
  w: number,
  h: number,
  text: string,
  color: 'blue' | 'grey' | 'orange' | 'green',
): PieceDef => ({
  build(b: BoardBuilder) {
    const node = b.geo(null, { x: 0, y: 0, w, h, text, color, fill: 'solid', labelColor: INK })
    return (out) =>
      asPolygon(
        out.elements as unknown as El[],
        elOf(out, node),
        (bw, bh) => blockArrow(dir, bw, bh),
        { stroke: color, fill: color },
        freshId,
      )
  },
})

/** The outline of a double-headed block arrow: a shaft with a head at each end. */
function doubleOutline(w: number, h: number): Pt[] {
  const y0 = h * 0.27
  const y1 = h * 0.73
  const neck = Math.min(h * 0.55, w * 0.3)
  return [
    [0, h / 2],
    [neck, 0],
    [neck, y0],
    [w - neck, y0],
    [w - neck, 0],
    [w, h / 2],
    [w - neck, h],
    [w - neck, y1],
    [neck, y1],
    [neck, h],
    [0, h / 2],
  ]
}

/** A chevron or a pentagon step: the corners of a `w` by `h` box, closed (`notch` 0 is the flat-backed step). */
const stepOutline =
  (point: number, notch: number) =>
  (w: number, h: number): Pt[] => {
    const tip = w * (1 - point)
    const back = w * notch
    const pts: Pt[] = [
      [0, 0],
      [tip, 0],
      [w, h / 2],
      [tip, h],
      [0, h],
    ]
    if (notch > 0) pts.push([back, h / 2])
    pts.push([0, 0])
    return pts
  }

export const ARROW_PIECES = {
  'arrow-straight': freeArrow(
    [
      [0, 0],
      [240, 0],
    ],
    { stroke: 'black' },
  ),
  'arrow-dashed': freeArrow(
    [
      [0, 0],
      [240, 0],
    ],
    { stroke: 'grey', dashed: true },
  ),
  'arrow-curved': freeArrow(
    [
      [0, 64],
      [120, 0],
      [240, 64],
    ],
    { stroke: 'black', curved: true },
  ),
  'arrow-double': freeArrow(
    [
      [0, 0],
      [240, 0],
    ],
    { stroke: 'black', start: 'arrow', end: 'arrow' },
  ),
  'arrow-uturn': freeArrow(
    [
      [0, 0],
      [110, 0],
      [150, 50],
      [110, 100],
      [0, 100],
    ],
    { stroke: 'black', curved: true },
  ),
  'arrow-pointer': freeArrow(
    [
      [0, 0],
      [200, 70],
    ],
    { stroke: 'red', start: 'circle', end: 'arrow' },
  ),
  'block-right': block('right', 240, 100, 'Next', 'blue'),
  'block-left': block('left', 240, 100, 'Back', 'grey'),
  'block-up': block('up', 120, 200, 'Up', 'green'),
  'block-down': block('down', 120, 200, 'Down', 'orange'),
  'block-double': {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 320,
        h: 100,
        text: 'Both ways',
        color: 'violet',
        fill: 'solid',
        labelColor: INK,
      })
      return (out) =>
        asPolygon(
          out.elements as unknown as El[],
          elOf(out, node),
          doubleOutline,
          { stroke: 'violet', fill: 'violet' },
          freshId,
        )
    },
  },
  chevron: {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 220,
        h: 80,
        text: 'Step',
        color: 'orange',
        fill: 'solid',
        labelColor: INK,
      })
      return (out) =>
        asPolygon(
          out.elements as unknown as El[],
          elOf(out, node),
          stepOutline(0.2, 0.2),
          { stroke: 'orange', fill: 'orange' },
          freshId,
        )
    },
  },
  'step-pentagon': {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 220,
        h: 80,
        text: 'Phase',
        color: 'light-green',
        fill: 'solid',
        labelColor: INK,
      })
      return (out) =>
        asPolygon(
          out.elements as unknown as El[],
          elOf(out, node),
          stepOutline(0.2, 0),
          { stroke: 'light-green', fill: 'light-green' },
          freshId,
        )
    },
  },
} satisfies Record<string, PieceDef>
