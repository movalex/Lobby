// The callouts kit: speech bubbles (a tail to the left or right), a thought bubble, a burst, an annotation with a
// leader line and a dot, and a folded note. A bubble is a closed polygon `line` drawn from short segments (smooth
// corners and a tail) under a see-through box that carries the words, the same build as the flowchart's data
// shape. Original work.
import {
  asPolygon,
  bubbleOutline,
  type El,
  elOf,
  freshId,
  INK,
  lineEl,
  type PieceDef,
  type Pt,
  round,
} from './kit.ts'

/** A starburst: `spikes` points on the box's ellipse, with the dips between them at `dip` of the way out. */
function burstOutline(w: number, h: number): Pt[] {
  const spikes = 14
  const dip = 0.72
  const pts: Pt[] = []
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i * Math.PI) / spikes - Math.PI / 2
    const f = i % 2 === 0 ? 1 : dip
    pts.push([w / 2 + (w / 2) * f * Math.cos(a), h / 2 + (h / 2) * f * Math.sin(a)])
  }
  pts.push(pts[0] as Pt)
  return pts
}

/** A note with its top-right corner cut off, the corners of a `w` by `h` box, closed. */
const FOLD = 30
function cutCornerOutline(w: number, h: number): Pt[] {
  return [
    [0, 0],
    [w - FOLD, 0],
    [w, FOLD],
    [w, h],
    [0, h],
    [0, 0],
  ]
}

const speech = (text: string, color: 'blue' | 'yellow', tail: { at: number; tipX: number }): PieceDef => ({
  build(b) {
    const node = b.geo(null, { x: 0, y: 0, w: 240, h: 120, text, color, fill: 'solid', labelColor: INK })
    return (out) =>
      asPolygon(
        out.elements as unknown as El[],
        elOf(out, node),
        (w, h) => bubbleOutline(w, h, 28, { at: tail.at, length: 36, width: 40, tipX: w * tail.tipX }),
        { stroke: color, fill: color },
        freshId,
      )
  },
})

export const CALLOUT_PIECES = {
  speech: speech('Say something', 'blue', { at: 0.14, tipX: 0.07 }),
  'speech-right': speech('Reply here', 'yellow', { at: 0.62, tipX: 0.93 }),
  thought: {
    build(b) {
      b.geo(null, {
        x: 0,
        y: 0,
        w: 240,
        h: 130,
        geo: 'ellipse',
        text: 'Hmm, what if',
        color: 'violet',
        fill: 'solid',
        labelColor: INK,
      })
      b.geo(null, { x: 52, y: 138, w: 26, h: 20, geo: 'ellipse', color: 'violet', fill: 'solid' })
      b.geo(null, { x: 30, y: 168, w: 14, h: 11, geo: 'ellipse', color: 'violet', fill: 'solid' })
      return undefined
    },
  },
  burst: {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 220,
        h: 170,
        text: 'Wow!',
        color: 'yellow',
        fill: 'solid',
        labelColor: INK,
        size: 'm',
      })
      return (out) =>
        asPolygon(
          out.elements as unknown as El[],
          elOf(out, node),
          burstOutline,
          { stroke: 'orange', fill: 'yellow' },
          freshId,
        )
    },
  },
  'callout-line': {
    build(b) {
      const box = b.geo(null, {
        x: 0,
        y: 0,
        w: 200,
        h: 64,
        text: 'Annotation',
        color: 'grey',
        fill: 'semi',
        labelColor: INK,
      })
      b.geo(null, { x: 272, y: 92, w: 16, h: 16, geo: 'ellipse', color: 'red', fill: 'fill' })
      return (out) => {
        const els = out.elements as unknown as El[]
        const holder = elOf(out, box)
        round(holder, 10)
        // the leader runs from the box's right edge to the dot
        const leader = lineEl(
          holder,
          freshId,
          [
            [200, 32],
            [276, 98],
          ],
          { stroke: 'red' },
        )
        const at = els.findIndex((e) => e.type === 'text' && e.containerId === holder.id)
        return [...els.slice(0, at + 1), leader, ...els.slice(at + 1)]
      }
    },
  },
  'callout-fold': {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 200,
        h: 140,
        text: 'Note',
        color: 'yellow',
        fill: 'solid',
        labelColor: INK,
      })
      return (out) => {
        const box = elOf(out, node)
        const els = asPolygon(
          out.elements as unknown as El[],
          box,
          cutCornerOutline,
          { stroke: 'orange', fill: 'yellow' },
          freshId,
        )
        // the folded-over corner, a little darker than the page
        const x = box.x as number
        const y = box.y as number
        const w = box.width as number
        const fold = lineEl(
          box,
          freshId,
          [
            [x + w - FOLD, y],
            [x + w - FOLD, y + FOLD],
            [x + w, y + FOLD],
            [x + w - FOLD, y],
          ],
          { stroke: 'orange', fill: 'tint' },
          true,
        )
        const at = els.findIndex((e) => e.type === 'text' && e.containerId === box.id)
        return [...els.slice(0, at), fold, ...els.slice(at)]
      }
    },
  },
} satisfies Record<string, PieceDef>
