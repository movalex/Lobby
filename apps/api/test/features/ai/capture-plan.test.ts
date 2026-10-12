// Wave N (WS5, N5-1): the checks of a capture's answers (capture-plan.ts), the photo's byte checks
// (capture-image.ts) and the capture prompts' strict schemas (capture-prompt.ts). Pure.

import {
  AI_DIAGRAM_MAX_NODES,
  AI_OTHER_THEME,
  CAPTURE_NOTES_MAX,
  CAPTURE_PHOTO_MAX_BYTES,
  CaptureResult,
} from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../src/errors.ts'
import { checkCaptureImage } from '../../../src/features/ai/capture-image.ts'
import {
  boxOf,
  diagramResult,
  meetingPart,
  mergeMeeting,
  normKey,
  notesResult,
  photoResult,
  reduceItems,
  reduceThemes,
  transcriptChunks,
  transcriptResult,
} from '../../../src/features/ai/capture-plan.ts'
import { CAPTURE_SCHEMAS, meetingPrompt, photoPrompt } from '../../../src/features/ai/capture-prompt.ts'
import { BadOutput } from '../../../src/features/ai/plan.ts'
import { apng, jpeg, png, webpExtended, webpLossless, webpLossy } from '../thumbnails/images.ts'

const status = (f: () => unknown) => {
  try {
    f()
    return 200
  } catch (e) {
    return e instanceof ApiError ? `${e.status} ${e.code}` : 'threw'
  }
}

describe('the photo’s bytes', () => {
  it('a JPEG, PNG or WebP of its declared type, with its size from the header', () => {
    expect(checkCaptureImage(png(30, 20), 'image/png')).toMatchObject({
      mimeType: 'image/png',
      width: 30,
      height: 20,
    })
    expect(checkCaptureImage(jpeg(640, 480), 'image/jpeg')).toMatchObject({ width: 640, height: 480 })
    for (const b of [webpLossy(100, 50), webpLossless(100, 50), webpExtended(100, 50)])
      expect(checkCaptureImage(b, 'image/webp')).toMatchObject({
        mimeType: 'image/webp',
        width: 100,
        height: 50,
      })
  })

  it('415 for wrong magic, a type that does not match, an animation or bytes after the image; 413 past the limits', () => {
    expect(status(() => checkCaptureImage(Buffer.from('GIF89a........................')))).toBe(
      '415 AI_CAPTURE_BAD_IMAGE',
    )
    expect(status(() => checkCaptureImage(png(10, 10), 'image/webp'))).toBe('415 AI_CAPTURE_BAD_IMAGE')
    expect(status(() => checkCaptureImage(apng(10, 10)))).toBe('415 AI_CAPTURE_BAD_IMAGE')
    expect(status(() => checkCaptureImage(webpExtended(10, 10, { animated: true })))).toBe(
      '415 AI_CAPTURE_BAD_IMAGE',
    )
    expect(status(() => checkCaptureImage(Buffer.concat([png(10, 10), Buffer.from('<script>')])))).toBe(
      '415 AI_CAPTURE_BAD_IMAGE',
    )
    expect(status(() => checkCaptureImage(Buffer.alloc(0)))).toBe('415 AI_CAPTURE_BAD_IMAGE')
    expect(status(() => checkCaptureImage(png(4097, 2)))).toBe('413 AI_CAPTURE_IMAGE_TOO_LARGE')
    expect(status(() => checkCaptureImage(jpeg(10, 5000)))).toBe('413 AI_CAPTURE_IMAGE_TOO_LARGE')
    expect(status(() => checkCaptureImage(Buffer.alloc(CAPTURE_PHOTO_MAX_BYTES + 1)))).toBe(
      '413 AI_CAPTURE_IMAGE_TOO_LARGE',
    )
    expect(status(() => checkCaptureImage(png(4096, 4096)))).toBe(200)
  })
})

describe('a photo’s answer', () => {
  it('boxes are clamped into the photo and never run past its edges', () => {
    expect(boxOf({ x: 0.8, y: 0.5, w: 0.5, h: 0.2 })).toEqual({ x: 0.8, y: 0.5, w: 0.2, h: 0.2 })
    expect(boxOf({ x: -1, y: 'a', w: Number.NaN, h: 9 })).toEqual({ x: 0, y: 0, w: 0, h: 1 })
    expect(boxOf(null)).toBeNull()
  })

  it('notes: plain text, at most the contract’s count; groups by kept notes, each note once', () => {
    const many = Array.from({ length: CAPTURE_NOTES_MAX + 30 }, (_, i) => ({
      text: `# Note ${i}`,
      color: 'blue',
      box: { x: 0, y: 0, w: 0.1, h: 0.1 },
    }))
    const r = notesResult({
      notes: [{ text: '', color: 'x', box: {} }, ...many],
      groups: [{ name: 'A', notes: [0, 1, 1, 2] }],
    })
    expect(r.notes).toHaveLength(CAPTURE_NOTES_MAX)
    expect(r.notes[0]).toEqual({ text: 'Note 0', color: 'blue', box: { x: 0, y: 0, w: 0.1, h: 0.1 } })
    // index 0 was the empty note (dropped): 1 and 2 are the first two kept notes
    expect(r.groups).toEqual([{ name: 'A', notes: [0, 1] }])
    expect(CaptureResult.safeParse(r).success).toBe(true)
    expect(() => notesResult({ notes: 'x' })).toThrow(BadOutput)
  })

  it('a diagram: the api’s own node ids, edges only between named nodes, no self loops or repeats', () => {
    const r = diagramResult({
      nodes: [
        { id: 'A', label: 'Start', shape: 'ellipse', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } },
        { id: 'B', label: 'Do it', shape: 'hexagon', box: null },
        { id: 'A', label: 'Again', shape: 'rect', box: null },
        { id: 'C', label: '', shape: 'rect', box: null },
      ],
      edges: [
        { from: 'A', to: 'B', label: 'go', kind: 'arrow' },
        { from: 'A', to: 'B', label: 'twice', kind: 'arrow' },
        { from: 'B', to: 'B', label: '', kind: 'line' },
        { from: 'B', to: 'Z', label: '', kind: 'line' },
        { from: 'B', to: 'A', label: '', kind: 'squiggle' },
      ],
    })
    expect(r).toEqual({
      kind: 'diagram',
      nodes: [
        { id: 'n1', label: 'Start', shape: 'ellipse', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } },
        { id: 'n2', label: 'Do it', shape: 'rect' },
      ],
      edges: [
        { from: 'n1', to: 'n2', kind: 'arrow', label: 'go' },
        { from: 'n2', to: 'n1', kind: 'arrow' },
      ],
    })
    const flood = diagramResult({
      nodes: Array.from({ length: 90 }, (_, i) => ({
        id: `x${i}`,
        label: `L${i}`,
        shape: 'rect',
        box: null,
      })),
      edges: [],
    })
    expect(flood.nodes).toHaveLength(AI_DIAGRAM_MAX_NODES)
  })

  it('auto: the kind the model says (notes when it says something else)', () => {
    const base = { notes: [{ text: 'a', color: 'yellow', box: { x: 0, y: 0, w: 0.1, h: 0.1 } }], groups: [] }
    const nodes = [
      { id: 'a', label: 'A', shape: 'rect', box: null },
      { id: 'b', label: 'B', shape: 'rect', box: null },
    ]
    expect(photoResult('auto', { kind: 'diagram', ...base, nodes, edges: [] }).kind).toBe('diagram')
    expect(photoResult('auto', { kind: 'poem', ...base, nodes, edges: [] }).kind).toBe('notes')
  })
})

describe('a transcript', () => {
  it('chunks at line ends within the byte budget, at most N parts, and says when it left the rest out', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i} ${'x'.repeat(40)}`)
    const { parts, truncated } = transcriptChunks(lines.join('\n'), 500, 4)
    expect(parts).toHaveLength(4)
    expect(truncated).toBe(true)
    for (const p of parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(500)
    expect(parts[0]?.startsWith('Line 0 ')).toBe(true)
    // no line is split when lines fit
    for (const p of parts) for (const l of p.split('\n')) expect(l).toMatch(/^Line \d+ x{40}$/)
    const all = transcriptChunks(lines.slice(0, 5).join('\n'), 5000, 4)
    expect(all).toEqual({ parts: [lines.slice(0, 5).join('\n')], truncated: false })
    // a line longer than a part is cut at spaces (multi-byte text stays within the budget)
    const long = transcriptChunks('ünïcödé '.repeat(400), 300, 4)
    for (const p of long.parts) expect(Buffer.byteLength(p, 'utf8')).toBeLessThanOrEqual(300)
    expect(long.truncated).toBe(true)
  })

  it('each part’s prompt carries its part in the transcript fence, and says which part it is', () => {
    const p = meetingPrompt('Ana: hello', 2, 3, 'Sync')
    expect(p.user).toContain('This is part 2 of 3 of a meeting transcript. The meeting is called "Sync".')
    expect(p.user).toContain('<<<TRANSCRIPT\nAna: hello\nTRANSCRIPT>>>')
    expect(p.schemaName).toBe('lobby_capture_meeting')
  })

  it('merges parts by normalised words; an owner is kept only when the transcript writes the name', () => {
    const key = normKey('Ana: we will ship. Bo said: fine — Ana will book it.')
    const a = meetingPart(
      {
        themes: [{ name: 'Shipping', notes: ['We ship Friday', 'we ship friday!'] }],
        decisions: ['Ship on Friday'],
        actions: [
          { text: 'Book the studio', owner: 'Ana' },
          { text: 'Call legal', owner: 'Eve' },
        ],
      },
      key,
    )
    const b = meetingPart(
      {
        themes: [
          { name: 'shipping', notes: ['We ship Friday.', 'QA signs off'] },
          { name: 'Empty', notes: [] },
        ],
        decisions: ['ship on friday'],
        actions: [{ text: 'book the studio', owner: 'Bo' }],
      },
      key,
    )
    expect(a.actions).toEqual([
      { text: 'Book the studio', owner: 'Ana' },
      { text: 'Call legal', owner: null },
    ])
    const m = mergeMeeting([a, b])
    expect(m).toEqual({
      themes: [{ name: 'Shipping', notes: ['We ship Friday', 'QA signs off'] }],
      decisions: ['Ship on Friday'],
      actions: [
        { text: 'Book the studio', owner: 'Ana' },
        { text: 'Call legal', owner: null },
      ],
    })
    expect(transcriptResult(m)).toEqual({
      kind: 'transcript',
      themes: [{ name: 'Shipping', notes: ['We ship Friday', 'QA signs off'] }],
      decisions: ['Ship on Friday'],
      actions: [{ text: 'Book the studio', owner: 'Ana' }, { text: 'Call legal' }],
    })
    expect(() => meetingPart({ themes: [] }, key)).toThrow(BadOutput)
  })

  it('the reduce regroups the notes it was sent: each once, the ones it left out in Other', () => {
    const merged = mergeMeeting([
      {
        themes: [
          { name: 'A', notes: ['one', 'two'] },
          { name: 'B', notes: ['three'] },
        ],
        decisions: [],
        actions: [],
      },
    ])
    const items = reduceItems(merged, 2)
    expect(items).toEqual([
      { id: 't1', text: 'one' },
      { id: 't2', text: 'two' },
    ])
    const themes = reduceThemes(
      { themes: [{ name: 'Numbers', note_ids: ['t2', 't2', 't9'] }] },
      merged,
      items,
    )
    expect(themes).toEqual([
      { name: 'Numbers', notes: ['two'] },
      { name: AI_OTHER_THEME, notes: ['one'] },
      // never sent: stays in its own theme
      { name: 'B', notes: ['three'] },
    ])
    expect(() => reduceThemes({ themes: [] }, merged, items)).toThrow(BadOutput)
  })
})

describe('the strict schemas', () => {
  it('every object lists all of its properties as required and allows no others', () => {
    const walk = (s: unknown): void => {
      if (!s || typeof s !== 'object') return
      const o = s as Record<string, unknown>
      if (o.type === 'object') {
        expect(o.additionalProperties).toBe(false)
        expect([...(o.required as string[])].sort()).toEqual(Object.keys(o.properties as object).sort())
      }
      for (const v of Object.values(o)) walk(v)
    }
    for (const { schema } of Object.values(CAPTURE_SCHEMAS)) walk(schema)
    for (const mode of ['notes', 'diagram', 'auto'] as const)
      expect(photoPrompt(mode).schemaName).toMatch(/^lobby_capture_/)
  })
})
