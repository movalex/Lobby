import { describe, expect, it } from 'vitest'
import { PICKER_LIST_MAX, placePicker, samePlacement } from './placement.ts'

// A 1440×900 editor whose top row ends at 90 and whose toolbar starts at 840.
const bounds = { left: 0, right: 1440, top: 90, bottom: 840 }
const button = (x: number, y: number) => ({ left: x, right: x + 30, top: y, bottom: y + 30 })
const size = { width: 272, height: 300, list: 200 }

describe('placePicker', () => {
  it('opens centred under the button when there is room', () => {
    expect(placePicker(button(700, 300), size, bounds)).toEqual({ dx: 0, above: false, listMax: null })
  })

  it('shifts sideways to stay inside the editor, with a margin', () => {
    // centred it would start at 20 + 15 - 136 = -101: shifted right to 8
    expect(placePicker(button(20, 300), size, bounds).dx).toBe(109)
    // near the right edge: its right side ends 8 px inside
    const right = placePicker(button(1400, 300), size, bounds)
    expect(1400 + 15 - 136 + right.dx + 272).toBe(1432)
  })

  it('opens above the bar when the toolbar leaves no room below', () => {
    expect(placePicker(button(700, 600), size, bounds)).toEqual({ dx: 0, above: true, listMax: null })
  })

  it('neither side fits (a short phone screen): the roomier side, with the list shortened to fit', () => {
    const phone = { left: 0, right: 390, top: 90, bottom: 740 }
    const tall = { width: 272, height: 420, list: PICKER_LIST_MAX }
    const p = placePicker(button(180, 400), tall, phone)
    // below: 740 - 8 - 440 = 292; above: 400 - 10 - 98 = 292 → below (not strictly roomier above)
    expect(p.above).toBe(false)
    expect(p.listMax).toBe(PICKER_LIST_MAX - (420 - 292))
    const low = placePicker(button(180, 500), tall, phone) // above: 392, below: 192
    expect(low.above).toBe(true)
    expect(low.listMax).toBe(PICKER_LIST_MAX - (420 - (500 - 10 - 98)))
    expect(placePicker(button(180, 600), tall, phone)).toMatchObject({ above: true, listMax: null }) // fits above
    // never below a usable minimum
    expect(placePicker(button(180, 200), { ...tall, height: 900 }, phone).listMax).toBe(72)
  })

  it('samePlacement ignores sub-pixel jitter', () => {
    expect(
      samePlacement({ dx: 1, above: false, listMax: null }, { dx: 1.2, above: false, listMax: null }),
    ).toBe(true)
    expect(samePlacement({ dx: 1, above: false, listMax: null }, { dx: 1, above: true, listMax: null })).toBe(
      false,
    )
    expect(samePlacement({ dx: 1, above: false, listMax: 80 }, { dx: 1, above: false, listMax: null })).toBe(
      false,
    )
  })
})
