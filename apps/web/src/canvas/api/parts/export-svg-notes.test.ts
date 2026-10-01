// W5-37 (3e): an exported SVG's notes lose the engine's hard offset shadow and 1 px edge and get tldraw's
// soft export shadow. The input is the engine's own serialization of a sticky note (0.18,
// chunk-FN755BR4.js `case "stickynote"`), inside a frame's clip group, next to a plain rectangle.
import { describe, expect, it } from 'vitest'
import { NOTE_SHADOW_FILTER_ID, softenNoteShadows } from './export-svg-notes.ts'

const NOTE =
  '<clipPath id="sticky-note-clipPath-n1" clipPathUnits="userSpaceOnUse"><path d="M 0 0 L 200 0 L 200 200 L 0 200 Z" fill="#000" stroke="none"/></clipPath>' +
  '<g clip-path="url(#frame-clip)"><g transform="translate(10 10) rotate(0 100 100)">' +
  '<path d="M 3 3 L 203 3 L 203 203 L 3 203 Z" fill="#000" fill-opacity="0.16" stroke="none"/>' +
  '<path d="M 0 0 L 200 0 L 200 200 L 0 200 Z" fill="#f6c453" stroke="none"/>' +
  '<path d="M 0 0 L 200 0 L 200 200 L 0 200 Z" fill="none" stroke="#000" stroke-opacity="0.08" stroke-width="1" clip-path="url(#sticky-note-clipPath-n1)"/>' +
  '</g></g>'
const RECT =
  '<g><path d="M 0 0 L 9 9" fill="#000" fill-opacity="0.5" stroke="none"/><path d="M 1 1" fill="#fff" stroke="none"/></g>'
const svg = (body: string, defs = '<defs><style class="style-fonts"></style></defs>') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">${defs}${body}</svg>`

describe('softenNoteShadows (W5-37)', () => {
  it('replaces each note’s hard shadow and edge with one soft shadow filter, keeping its fill and place', () => {
    const out = softenNoteShadows(svg(NOTE + RECT))
    expect(out).not.toContain('fill-opacity="0.16"')
    expect(out).not.toContain('stroke-opacity="0.08"')
    expect(out).not.toContain('sticky-note-clipPath-n1')
    expect(out).toContain(
      `<path filter="url(#${NOTE_SHADOW_FILTER_ID})" d="M 0 0 L 200 0 L 200 200 L 0 200 Z" fill="#f6c453" stroke="none"/>`,
    )
    // one definition, in <defs>, with tldraw's blurred layers
    expect(out.match(/<filter id="lobby-note-shadow"/g)).toHaveLength(1)
    expect(out).toMatch(/<defs><filter id="lobby-note-shadow"[\s\S]*feGaussianBlur[\s\S]*<\/filter><style/)
    // the frame's clip and everything that is not a note stay
    expect(out).toContain('clip-path="url(#frame-clip)"')
    expect(out).toContain(RECT)
  })

  it('leaves an SVG without engine notes alone, and adds <defs> when there is none', () => {
    const plain = svg(RECT)
    expect(softenNoteShadows(plain)).toBe(plain)
    const bare = softenNoteShadows(svg(NOTE, ''))
    expect(bare).toMatch(/^<svg [^>]*><defs><filter id="lobby-note-shadow"/)
    const closed = softenNoteShadows(svg(NOTE, '<defs/>'))
    expect(closed).toMatch(/<defs><filter id="lobby-note-shadow"[\s\S]*<\/filter><\/defs>/)
  })
})
