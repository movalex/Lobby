import type { TLDefaultColorStyle } from '@tldraw/tlschema'
import { CONTENT_Y, createBoardBuilder, NOTE_GAP, PAD } from '../builder.ts'
import type { TemplateDefinition } from '../types.ts'

const SECTIONS = ['1 · Direction', '2 · Palette', '3 · Imagery', '4 · This, not that'] as const

const ROW2_Y = 760
const TOP_H = 640
const BOTTOM_H = 900

const SWATCHES: ReadonlyArray<{
  label: string
  color: TLDefaultColorStyle
  labelColor: TLDefaultColorStyle
}> = [
  { label: 'Primary', color: 'violet', labelColor: 'white' },
  { label: 'Secondary', color: 'light-violet', labelColor: 'black' },
  { label: 'Accent', color: 'light-red', labelColor: 'black' },
  { label: 'Warm', color: 'orange', labelColor: 'black' },
  { label: 'Highlight', color: 'yellow', labelColor: 'black' },
  { label: 'Base', color: 'grey', labelColor: 'black' },
]

const IMAGE_SLOTS = [
  'Hero image: the one that sums it up',
  'Place or setting',
  'People or character',
  'Texture or material',
  'Type and graphics',
  'Wild card from another world',
]

export const moodBoard: TemplateDefinition = {
  id: 'mood-board',
  name: 'Mood board',
  description: 'Set a visual direction with keywords, a color palette, image slots and a this-not-that list.',
  category: 'visual',
  sections: SECTIONS,
  build(ctx) {
    const b = createBoardBuilder(ctx)

    const direction = b.section({
      x: 0,
      y: 0,
      w: 760,
      h: TOP_H,
      name: SECTIONS[0],
      heading: 'What should it feel like?',
      intro: 'Sum up the feeling in one sentence, then fill in the words that set the direction.',
    })
    b.noteGrid(direction, { x: PAD, y: CONTENT_Y - 10, cols: 3 }, [
      { text: 'In one sentence, it should feel…', color: 'yellow' },
      { text: 'Feeling: e.g. calm, bold, playful', color: 'light-blue' },
      { text: 'Texture: e.g. linen, chrome, paper', color: 'light-green' },
      { text: 'Light: e.g. golden hour, neon, overcast', color: 'orange' },
      { text: 'Pace: e.g. slow and still, quick cuts', color: 'light-violet' },
      { text: 'Sound: e.g. hushed, brassy, lo-fi', color: 'light-red' },
    ])

    const swatchW = 200
    const paletteW = PAD * 2 + SWATCHES.length * swatchW + (SWATCHES.length - 1) * NOTE_GAP
    const palette = b.section({
      x: 840,
      y: 0,
      w: paletteW,
      h: TOP_H,
      name: SECTIONS[1],
      heading: 'Color palette',
      intro: 'Recolor each swatch from the style panel, then write its name or hex code in the label.',
    })
    SWATCHES.forEach((s, i) => {
      b.geo(palette, {
        x: PAD + i * (swatchW + NOTE_GAP),
        y: CONTENT_Y - 10,
        w: swatchW,
        h: 180,
        text: s.label,
        color: s.color,
        labelColor: s.labelColor,
        fill: 'fill',
        size: 'm',
      })
    })
    b.noteGrid(palette, { x: PAD, y: 400, cols: 3 }, [
      { text: 'Which color leads, and which is a rare accent?', color: 'light-blue' },
      { text: 'Colors to avoid, and why', color: 'light-red' },
      { text: 'Where the palette comes from: a photo, film or place', color: 'yellow' },
    ])

    const slotW = 460
    const slotH = 300
    const slotGap = 30
    const imageryW = PAD * 2 + 3 * slotW + 2 * slotGap
    const imagery = b.section({
      x: 0,
      y: ROW2_Y,
      w: imageryW,
      h: BOTTOM_H,
      name: SECTIONS[2],
      heading: 'Imagery',
      intro:
        'Drop reference images onto the slots or anywhere in this frame. ' +
        'Aim for a mix: wide and close, people and places.',
    })
    IMAGE_SLOTS.forEach((label, i) => {
      b.imageSlot(imagery, {
        x: PAD + (i % 3) * (slotW + slotGap),
        y: CONTENT_Y + Math.floor(i / 3) * (slotH + slotGap),
        w: slotW,
        h: slotH,
        label,
      })
    })

    const contrastX = imageryW + 80
    // Right edge lines up with the palette frame above.
    const contrastW = 840 + paletteW - contrastX
    const contrast = b.section({
      x: contrastX,
      y: ROW2_Y,
      w: contrastW,
      h: BOTTOM_H,
      name: SECTIONS[3],
      heading: 'This, not that',
      intro: "Sharpen the direction by naming what it isn't.",
    })
    const colX = [60, contrastW - 60 - 200] as const
    // Column headings: locked like every other heading (PRE-07).
    b.text(contrast, {
      x: colX[0],
      y: 160,
      w: 200,
      text: 'This',
      size: 'm',
      color: 'green',
      align: 'middle',
      locked: true,
    })
    b.text(contrast, {
      x: colX[1],
      y: 160,
      w: 200,
      text: 'Not that',
      size: 'm',
      color: 'red',
      align: 'middle',
      locked: true,
    })
    const pairs: ReadonlyArray<[string, string]> = [
      ['e.g. warm and hand-made', 'e.g. rustic or twee'],
      ['e.g. confident', 'e.g. shouty'],
      ['This…', 'Not that…'],
    ]
    pairs.forEach(([yes, no], i) => {
      const y = 216 + i * (200 + NOTE_GAP)
      b.note(contrast, { x: colX[0], y, text: yes, color: 'light-green' })
      b.note(contrast, { x: colX[1], y, text: no, color: 'light-red' })
    })

    return { records: b.finish() }
  },
}
