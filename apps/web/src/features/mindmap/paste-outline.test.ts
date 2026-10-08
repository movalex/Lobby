// K7-2: "Paste as mind map" in the bulk-paste prompt. The prompt offers it only when the pasted text has a
// hierarchy of its own (canvas-ux/bulk-paste.ts outlineOfPaste), says what the caps left out (mindmapNotice),
// and the prompt component shows the button only then (canvas-ux/ported/navigation/bulk-paste.tsx).

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { mindmapNotice, outlineOfPaste } from '../canvas-ux/bulk-paste.ts'
import { analyzeBulkPaste, BulkPasteView } from '../canvas-ux/ported/navigation/bulk-paste.tsx'
import { OUTLINE_MAX_TOPICS, parseOutline } from './outline-parse.ts'

const OUTLINE = '# Launch plan\n- Audience\n  - Leadership\n  - Fans\n- Channels\n'

describe('which pastes offer "Paste as mind map"', () => {
  it('an outline with a hierarchy of its own does', () => {
    expect(outlineOfPaste(OUTLINE)?.topics).toBe(5)
    expect(outlineOfPaste('Plan\n\tBudget\n\t\tFees\n\tDates')?.topics).toBe(4)
    expect(outlineOfPaste('Plan\n  Budget\n  Dates')?.topics).toBe(3)
  })

  it('a flat list, spreadsheet cells, prose, one line and garbage do not', () => {
    for (const text of [
      'one\ntwo\nthree',
      '- one\n- two\n- three',
      'a\tb\tc\nd\te\tf',
      'name,role\nAna,lead\nBo,design',
      'A sentence, with commas, in one line.',
      '',
      '   ',
      '{\n  "a": [1, 2]\n}',
      'Title\n  only child',
      'x\u0000y\n  z\n  w',
    ])
      expect(outlineOfPaste(text), text).toBeNull()
  })

  it('every pasted outline is still a bulk paste, so the prompt asks (notes and text stay)', () => {
    expect(analyzeBulkPaste(OUTLINE)?.cells).toBeGreaterThanOrEqual(5)
  })
})

describe('the prompt component', () => {
  const props = {
    cells: 5,
    at: { x: 100, y: 100 },
    titleId: 'paste-title',
    pasteId: 1,
    onNotes: () => undefined,
    onText: () => undefined,
    onMindmap: () => undefined,
    onCancel: () => undefined,
  }
  const html = (topics: number | null) =>
    renderToStaticMarkup(createElement(BulkPasteView, { ...props, topics }))

  it('offers "Paste as mind map" only when an outline was detected', () => {
    const plain = html(null)
    expect(plain).not.toContain('bulk-paste-mindmap')
    expect(plain).toContain('Paste 5 items as sticky notes or as text?')
    expect(plain).toContain('data-testid="bulk-paste-notes"')

    const outline = html(5)
    expect(outline).toContain('data-testid="bulk-paste-mindmap"')
    expect(outline).toContain('Paste as mind map')
    expect(outline).toContain('Paste 5 items as a mind map, sticky notes or text?')
    // the notes and the text stay one click away
    expect(outline).toContain('data-testid="bulk-paste-notes"')
    expect(outline).toContain('data-testid="bulk-paste-text"')
  })

  it('the parsed outline of the same paste agrees with what the button builds', () => {
    expect(outlineOfPaste(OUTLINE)).toEqual(parseOutline(OUTLINE))
  })
})

describe('what a capped paste says it left out', () => {
  it('nothing when everything fitted', () => {
    expect(mindmapNotice({ clipped: { depth: 0, topics: 0, text: 0 } })).toBeNull()
  })
  it('names the lines left out, the lines moved up and the lines shortened', () => {
    const lines = ['# Big', ...Array.from({ length: 70 }, (_, i) => `- B${i}`)]
    const o = parseOutline(lines.join('\n'))
    expect(o?.topics).toBe(OUTLINE_MAX_TOPICS)
    expect(o && mindmapNotice(o)).toBe(
      `11 more lines were left out (limit: ${OUTLINE_MAX_TOPICS} topics per map).`,
    )
    expect(mindmapNotice({ clipped: { depth: 1, topics: 1, text: 2 } })).toBe(
      '1 more line was left out (limit: 60 topics per map). 1 line nested more than 4 levels deep moved up to level 4. Some very long lines were shortened.',
    )
  })
})
