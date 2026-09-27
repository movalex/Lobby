import { describe, expect, it } from 'vitest'
import { stripNoteAuthors } from './note-authors.ts'

// What XMLSerializer makes of tldraw 5.4.2's NoteShapeUtil.toSvg attribution (trimmed).
const NOTE = (name: string) =>
  `<g transform="matrix(1,0,0,1,0,0)"><rect rx="1" width="200" height="200" fill="#fed581"/>` +
  `<foreignObject x="0" y="0" width="200" height="200" class="tl-export-embed-styles">` +
  `<div xmlns="http://www.w3.org/1999/xhtml" style="position: relative; width: 100%; height: 100%;">` +
  `<div class="tl-note__attribution" style="font-size: 11px; color: rgb(29, 29, 29); opacity: 0.6;">${name}</div>` +
  `</div></foreignObject></g>`

describe('stripNoteAuthors', () => {
  it('removes every note author name and keeps everything else', () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${NOTE('Maya')}<text>Maya's idea</text>${NOTE('Bob &amp; Co')}</svg>`
    const out = stripNoteAuthors(svg)
    expect(out).not.toContain('tl-note__attribution')
    expect(out).not.toContain('>Maya</div>')
    expect(out).not.toContain('Bob &amp; Co')
    // The note itself and other text stay.
    expect(out).toContain('<rect rx="1" width="200" height="200" fill="#fed581"/>')
    expect(out).toContain("<text>Maya's idea</text>")
    expect(out.match(/<foreignObject/g)).toHaveLength(2)
  })

  it('leaves SVGs without note authors untouched', () => {
    const svg = '<svg><div class="tl-note__attribution-other">x</div><g class="tl-note__container"/></svg>'
    expect(stripNoteAuthors(svg)).toBe(svg)
  })
})
