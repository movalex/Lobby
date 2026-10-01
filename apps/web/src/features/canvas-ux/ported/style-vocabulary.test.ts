// The style panel's vocabulary (./style-vocabulary.ts): the values are the converter's (a converted board
// and a new one speak the same colours), and every mapping reads back what it writes.
import { LOBBY_FONT_FAMILIES } from '@draftroom/canvas-schema/limits'
import { describe, expect, it } from 'vitest'
import {
  PALETTE,
  TL_COLOR_NAMES,
  TL_SOLID_BACKGROUND,
} from '../../../../../../packages/tldraw-import/src/palette.ts'
import { NOTE_PALETTE } from '../palette.ts'
import {
  ARROWHEADS,
  arrowheadField,
  arrowheadNameOf,
  COLOR_NAMES,
  colorNameOf,
  DASHES,
  dashFields,
  dashNameOf,
  FILLS,
  FONT_FAMILY,
  FONTS,
  fillNameOf,
  fontNameOf,
  LABEL_SIZE,
  NOTE_INK,
  noteColorOf,
  noteFillOf,
  opacityStepOf,
  SEMI_FILL,
  SHADES,
  SIZES,
  STROKE_WIDTH,
  shapeFields,
  sizeNameOf,
  TEXT_SIZE,
} from './style-vocabulary.ts'

describe('the values are the tldraw converter’s', () => {
  it('13 colours, each with the converter’s solid, semi and pattern shades', () => {
    expect([...COLOR_NAMES].sort()).toEqual([...TL_COLOR_NAMES].sort())
    for (const n of COLOR_NAMES) {
      const c = PALETTE[n]
      expect(SHADES[n], n).toEqual({ solid: c.solid, semi: c.semi, pattern: c.pattern })
    }
    expect(SEMI_FILL).toBe(TL_SOLID_BACKGROUND)
  })

  it('note fills are Lobby’s palette (COL-06) with one ink', () => {
    for (const n of COLOR_NAMES) expect(noteFillOf(n), n).toBe(PALETTE[n].noteFill)
    for (const s of NOTE_PALETTE) expect(s.light.text).toBe(NOTE_INK)
    expect(PALETTE.black.noteText).toBe(NOTE_INK)
  })
})

describe('every mapping reads back what it writes', () => {
  it('colours and note fills', () => {
    for (const n of COLOR_NAMES) {
      expect(colorNameOf(SHADES[n].solid)).toBe(n)
      expect(noteColorOf(noteFillOf(n))).toBe(n)
      expect(noteColorOf(noteFillOf(n).toUpperCase())).toBe(n)
    }
    expect(colorNameOf('#9fa8b2'), 'tldraw’s own grey').toBe('grey')
    expect(colorNameOf('#123456')).toBeNull()
    expect(noteColorOf('#123456')).toBeNull()
  })

  it('fills, with their colour', () => {
    for (const n of COLOR_NAMES)
      for (const f of FILLS) {
        const v = shapeFields(n, f)
        expect(fillNameOf(v.backgroundColor, v.fillStyle), `${n} ${f}`).toBe(f)
        expect(colorNameOf(v.strokeColor)).toBe(n)
      }
  })

  it('dashes, sizes, fonts, arrowheads and opacity steps', () => {
    for (const d of DASHES) {
      const v = dashFields(d)
      expect(dashNameOf(v.strokeStyle, v.roughness)).toBe(d)
    }
    for (const s of SIZES) {
      expect(sizeNameOf(STROKE_WIDTH[s], STROKE_WIDTH)).toBe(s)
      expect(sizeNameOf(TEXT_SIZE[s], TEXT_SIZE)).toBe(s)
      expect(sizeNameOf(LABEL_SIZE[s], LABEL_SIZE)).toBe(s)
    }
    expect(sizeNameOf(20, LABEL_SIZE), 'a size of no step').toBeNull()
    for (const f of FONTS) expect(fontNameOf(FONT_FAMILY[f])).toBe(f)
    // D3: every font offered is one the server's allowlist takes (Display, Lilita One 7, once it does)
    for (const f of FONTS) expect(LOBBY_FONT_FAMILIES as readonly number[]).toContain(FONT_FAMILY[f])
    expect(FONTS).toEqual(
      (['draw', 'sans', 'display', 'mono'] as const).filter((f) =>
        (LOBBY_FONT_FAMILIES as readonly number[]).includes(FONT_FAMILY[f]),
      ),
    )
    expect(FONT_FAMILY).toEqual({ draw: 5, sans: 6, display: 7, mono: 8 })
    expect(fontNameOf(7)).toBe('display')
    for (const h of ARROWHEADS) expect(arrowheadNameOf(arrowheadField(h))).toBe(h)
    expect(opacityStepOf(60)).toBe(50)
    expect(opacityStepOf(100)).toBe(100)
  })
})
