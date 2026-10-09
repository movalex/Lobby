// The org chart kit (a person card) and the agency kit (shot card, storyboard panel, persona, journey stage).
// Photos and pictures are image slots (the template slot marker, no file); the words are placeholders to type
// over. Original work, written for the daily jobs of a creative agency.
import type { BoardBuilder } from '../builder.ts'
import { elOf, INK, MUTED, type PieceDef, unlockSlot } from './kit.ts'

const words = (
  b: BoardBuilder,
  x: number,
  y: number,
  w: number,
  text: string,
  o: { grey?: boolean; big?: boolean } = {},
) => b.text(null, { x, y, w, text, size: o.big ? 'm' : 's', color: o.grey ? MUTED : INK })

export const PEOPLE_PIECES = {
  person: {
    build(b) {
      b.geo(null, { x: 0, y: 0, w: 280, h: 112, color: 'blue', fill: 'semi' })
      const photo = b.imageSlot(null, { x: 20, y: 20, w: 72, h: 72, label: 'Photo' })
      words(b, 108, 24, 156, 'Name', { big: true })
      words(b, 108, 62, 156, 'Job title', { grey: true })
      return (out) => {
        unlockSlot(elOf(out, photo))
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  shot: {
    build(b) {
      b.geo(null, { x: 0, y: 0, w: 320, h: 200, color: 'grey', fill: 'semi' })
      words(b, 16, 14, 140, 'Shot 1', { big: true })
      const thumb = b.imageSlot(null, { x: 184, y: 14, w: 120, h: 68, label: 'Frame' })
      words(b, 16, 78, 140, 'Framing', { grey: true })
      words(b, 16, 110, 288, 'Movement', { grey: true })
      words(b, 16, 142, 288, 'Notes', { grey: true })
      return (out) => {
        unlockSlot(elOf(out, thumb))
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  storyboard: {
    build(b) {
      b.geo(null, { x: 0, y: 0, w: 320, h: 290, color: 'grey', fill: 'semi' })
      const picture = b.imageSlot(null, { x: 16, y: 16, w: 288, h: 162, label: 'Picture' })
      words(b, 16, 192, 288, 'Action')
      words(b, 16, 218, 288, 'What happens in this panel.', { grey: true })
      words(b, 16, 252, 288, 'Dialogue', { grey: true })
      return (out) => {
        unlockSlot(elOf(out, picture))
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  persona: {
    build(b) {
      b.geo(null, { x: 0, y: 0, w: 320, h: 380, color: 'light-violet', fill: 'solid' })
      const photo = b.imageSlot(null, { x: 16, y: 16, w: 80, h: 80, label: 'Photo' })
      words(b, 112, 24, 192, 'Name', { big: true })
      words(b, 112, 62, 192, 'Role or segment', { grey: true })
      words(b, 16, 120, 288, 'Goals')
      words(b, 16, 146, 288, 'What they want to get done.', { grey: true })
      words(b, 16, 210, 288, 'Frustrations')
      words(b, 16, 236, 288, 'What gets in the way.', { grey: true })
      words(b, 16, 300, 288, 'In their words')
      words(b, 16, 326, 288, 'A quote that sounds like them.', { grey: true })
      return (out) => {
        unlockSlot(elOf(out, photo))
        return out.elements as unknown as Record<string, unknown>[]
      }
    },
  },
  stage: {
    build(b) {
      b.geo(null, { x: 0, y: 56, w: 240, h: 264, color: 'grey', fill: 'semi' })
      b.geo(null, {
        x: 0,
        y: 0,
        w: 240,
        h: 56,
        text: 'Stage',
        color: 'orange',
        fill: 'solid',
        labelColor: INK,
        size: 'm',
      })
      words(b, 16, 72, 208, 'Doing')
      words(b, 16, 98, 208, 'What they do.', { grey: true })
      words(b, 16, 152, 208, 'Thinking')
      words(b, 16, 178, 208, 'What they think.', { grey: true })
      words(b, 16, 232, 208, 'Feeling')
      words(b, 16, 258, 208, 'How they feel.', { grey: true })
      return undefined
    },
  },
} satisfies Record<string, PieceDef>
