// The wireframe kit: browser, phone, button, input, checkbox, toggle, card, nav bar, modal and an image
// placeholder. Surfaces are the near-white card fill (dark mode swaps it for a near-black), controls sit on pale
// tints with the dark ink, and a picture goes in an image slot (the template slot marker; no image is stored).
// Original work.
import type { BoardBuilder } from '../builder.ts'
import { ACCENT, alignLabelLeft, elOf, INK, MUTED, type PieceDef, round, unlockSlot } from './kit.ts'

const text = (
  b: BoardBuilder,
  x: number,
  y: number,
  w: number,
  words: string,
  o: { grey?: boolean; big?: boolean } = {},
) => b.text(null, { x, y, w, text: words, size: o.big ? 'm' : 's', color: o.grey ? MUTED : INK })

export const WIREFRAME_PIECES = {
  browser: {
    build(b) {
      b.geo(null, { x: 0, y: 0, w: 640, h: 420, color: 'grey', fill: 'semi' })
      b.geo(null, { x: 0, y: 0, w: 640, h: 44, color: 'grey', fill: 'solid' })
      b.geo(null, { x: 16, y: 16, w: 12, h: 12, geo: 'ellipse', color: 'light-red', fill: 'fill' })
      b.geo(null, { x: 36, y: 16, w: 12, h: 12, geo: 'ellipse', color: 'yellow', fill: 'fill' })
      b.geo(null, { x: 56, y: 16, w: 12, h: 12, geo: 'ellipse', color: 'light-green', fill: 'fill' })
      b.geo(null, {
        x: 96,
        y: 4,
        w: 400,
        h: 36,
        text: 'example.com',
        color: 'grey',
        fill: 'semi',
        labelColor: MUTED,
      })
      return undefined
    },
  },
  phone: {
    build(b) {
      const body = b.geo(null, { x: 0, y: 0, w: 280, h: 560, color: 'black', fill: 'semi', size: 'm' })
      b.geo(null, { x: 95, y: 14, w: 90, h: 18, color: 'grey', fill: 'solid' })
      b.geo(null, { x: 90, y: 538, w: 100, h: 6, color: 'grey', fill: 'fill' })
      text(b, 20, 56, 240, 'Screen title', { big: true })
      return (out) => {
        round(elOf(out, body), 36)
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  button: {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 160,
        h: 48,
        text: 'Button',
        color: ACCENT,
        fill: 'solid',
        labelColor: INK,
      })
      return (out) => {
        round(elOf(out, node), 10)
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  input: {
    build(b) {
      const node = b.geo(null, {
        x: 0,
        y: 0,
        w: 280,
        h: 44,
        text: 'Placeholder',
        color: 'grey',
        fill: 'semi',
        labelColor: MUTED,
      })
      return (out) => {
        const box = elOf(out, node)
        round(box, 8)
        const els = out.elements as unknown as Record<string, unknown>[]
        alignLabelLeft(els, box)
        return els
      }
    },
  },
  checkbox: {
    build(b) {
      b.geo(null, { x: 0, y: 2, w: 24, h: 24, color: 'black', fill: 'semi' })
      text(b, 36, 2, 180, 'Checkbox label')
      return undefined
    },
  },
  toggle: {
    build(b) {
      const track = b.geo(null, { x: 0, y: 2, w: 52, h: 28, color: 'green', fill: 'solid' })
      b.geo(null, { x: 27, y: 5, w: 22, h: 22, geo: 'ellipse', color: 'green', fill: 'semi' })
      text(b, 68, 4, 150, 'Toggle label')
      return (out) => {
        round(elOf(out, track), 14)
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  card: {
    build(b) {
      b.geo(null, { x: 0, y: 0, w: 280, h: 320, color: 'grey', fill: 'semi' })
      const slot = b.imageSlot(null, { x: 16, y: 16, w: 248, h: 160, label: 'Image' })
      text(b, 16, 196, 248, 'Card title', { big: true })
      text(b, 16, 240, 248, 'A line or two that says what this is about.', { grey: true })
      return (out) => {
        unlockSlot(elOf(out, slot))
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  navbar: {
    build(b) {
      b.geo(null, { x: 0, y: 0, w: 640, h: 56, color: 'grey', fill: 'semi' })
      text(b, 20, 14, 120, 'Logo', { big: true })
      text(b, 330, 18, 70, 'Home')
      text(b, 410, 18, 70, 'About')
      text(b, 500, 18, 110, 'Contact')
      return undefined
    },
  },
  modal: {
    build(b) {
      b.geo(null, { x: 0, y: 0, w: 420, h: 260, color: 'black', fill: 'semi', size: 'm' })
      text(b, 24, 22, 372, 'Modal title', { big: true })
      text(b, 24, 72, 372, 'Say what this is about in a sentence or two.', { grey: true })
      const cancel = b.geo(null, {
        x: 162,
        y: 196,
        w: 112,
        h: 44,
        text: 'Cancel',
        color: 'grey',
        fill: 'semi',
        labelColor: INK,
      })
      const ok = b.geo(null, {
        x: 286,
        y: 196,
        w: 110,
        h: 44,
        text: 'OK',
        color: ACCENT,
        fill: 'solid',
        labelColor: INK,
      })
      return (out) => {
        round(elOf(out, cancel), 8)
        round(elOf(out, ok), 8)
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  image: {
    build(b) {
      const slot = b.imageSlot(null, { x: 0, y: 0, w: 240, h: 160, label: 'Image' })
      return (out) => {
        unlockSlot(elOf(out, slot))
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
} satisfies Record<string, PieceDef>
