// The flowchart kit: process, decision, terminator, data, document, sub-process and a swimlane frame. Words on
// a pale tint in the dark ink (the same in dark mode, where the canvas filter swaps both for their designed
// shades); outlines in the shape's colour. Original work.
import {
  asPolygon,
  documentOutline,
  elOf,
  freshId,
  INK,
  lineEl,
  type PieceDef,
  parallelogram,
  round,
} from './kit.ts'

export const FLOWCHART_PIECES = {
  process: {
    build(b) {
      b.geo(null, {
        x: 0,
        y: 0,
        w: 200,
        h: 96,
        text: 'Process',
        color: 'blue',
        fill: 'solid',
        labelColor: INK,
      })
      return undefined
    },
  },
  decision: {
    build(b) {
      b.geo(null, {
        x: 0,
        y: 0,
        w: 220,
        h: 150,
        geo: 'diamond',
        text: 'Decision?',
        color: 'yellow',
        fill: 'solid',
        labelColor: INK,
      })
      return undefined
    },
  },
  terminator: {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 200,
        h: 64,
        text: 'Start',
        color: 'green',
        fill: 'solid',
        labelColor: INK,
      })
      // a pill: the adaptive corner radius is half the height
      return (out) => {
        round(elOf(out, node), 32)
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  data: {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 220,
        h: 96,
        text: 'Data',
        color: 'light-blue',
        fill: 'solid',
        labelColor: INK,
      })
      return (out) =>
        asPolygon(
          out.elements as unknown as Record<string, unknown>[],
          elOf(out, node),
          parallelogram,
          { stroke: 'light-blue', fill: 'light-blue' },
          freshId,
        )
    },
  },
  document: {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 200,
        h: 120,
        text: 'Document',
        color: 'violet',
        fill: 'solid',
        labelColor: INK,
      })
      return (out) =>
        asPolygon(
          out.elements as unknown as Record<string, unknown>[],
          elOf(out, node),
          documentOutline,
          { stroke: 'violet', fill: 'violet' },
          freshId,
        )
    },
  },
  subprocess: {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 200,
        h: 96,
        text: 'Sub-process',
        color: 'blue',
        fill: 'solid',
        labelColor: INK,
      })
      // two bars near the sides say "this step is a flow of its own"
      return (out) => {
        const box = elOf(out, node)
        const els = out.elements as unknown as Record<string, unknown>[]
        const bars = [16, 184].map((dx) =>
          lineEl(
            box,
            freshId,
            [
              [(box.x as number) + dx, box.y as number],
              [(box.x as number) + dx, (box.y as number) + 96],
            ],
            { stroke: 'blue' },
          ),
        )
        const at = els.findIndex((e) => e.type === 'text' && e.containerId === box.id)
        return [...els.slice(0, at), ...bars, ...els.slice(at)]
      }
    },
  },
  swimlane: {
    build(b) {
      b.frame({ x: 0, y: 0, w: 1000, h: 280, name: 'Swimlane' })
      return undefined
    },
  },
} satisfies Record<string, PieceDef>
