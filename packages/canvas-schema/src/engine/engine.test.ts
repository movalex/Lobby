/**
 * Unit tests for the server-side engine wrappers (plan §2.3.1, §2.4.4, §2.11). The full Node-vs-Chromium
 * comparison is spike check A3 (`apps/web/test/engine-probe/a3/run.ts`).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { engineBindableTypes, engineTextContainerTypes, isBindable, isTextContainer } from './bindability.ts'
import { compareByIndex, indexKeyBetween, indexKeysBetween, isValidIndexKey } from './fractional.ts'
import {
  buildStickyNote,
  fontString,
  layoutStickyNote,
  stickyNoteHasFooter,
  wrapLabelText,
} from './layout.ts'
import {
  classifyGrapheme,
  createTableTextMetrics,
  installServerTextMetrics,
  parseFontString,
  textMetricsTable,
} from './text-metrics.ts'

const metrics = createTableTextMetrics()

beforeAll(() => {
  installServerTextMetrics(metrics)
})

describe('text metrics table', () => {
  it('covers families 5, 6 and 8, measured in Chromium at 100 px', () => {
    expect(Object.keys(textMetricsTable.families).sort()).toEqual(['5', '6', '8'])
    expect(textMetricsTable.sizePx).toBe(100)
    expect(textMetricsTable.measuredWith).toMatch(/Chrome/)
    for (const f of Object.values(textMetricsTable.families)) {
      for (let c = 0x20; c <= 0x7e; c++) expect(f.adv[String.fromCharCode(c)]).toBeGreaterThan(0)
      expect(f.classes.han).toBeGreaterThan(0.5)
      expect(f.classes.emoji).toBeGreaterThan(0.5)
    }
  })

  it('parses Excalidraw font strings (getFontString)', () => {
    expect(fontString(6, 20)).toBe('20px Nunito, sans-serif, Segoe UI Emoji')
    expect(fontString(5, 28)).toBe('28px Excalifont, Xiaolai, sans-serif, Segoe UI Emoji')
    expect(parseFontString(fontString(8, 16))).toEqual({ sizePx: 16, familyName: 'Comic Shanns' })
    expect(parseFontString('12.5px "Nunito", serif')).toEqual({ sizePx: 12.5, familyName: 'Nunito' })
  })

  it('scales linearly with the font size and applies the measured kerning', () => {
    const w20 = metrics.getLineWidth('AVATAR Typography', fontString(6, 20))
    const w40 = metrics.getLineWidth('AVATAR Typography', fontString(6, 40))
    expect(w40).toBeCloseTo(w20 * 2, 6)
    const noKern = createTableTextMetrics(undefined, { kerning: false })
    const kerned = metrics.width('AV', 6, 100)
    const plain = noKern.width('AV', 6, 100)
    expect(kerned).toBeLessThan(plain) // Nunito kerns "AV"
    expect(metrics.width('    ', 8, 10)).toBeCloseTo(
      4 * (textMetricsTable.families['8']?.adv[' '] ?? 0) * 10,
      6,
    )
  })

  it('classifies graphemes outside the table', () => {
    expect(classifyGrapheme('会')).toBe('han')
    expect(classifyGrapheme('の')).toBe('kana')
    expect(classifyGrapheme('편')).toBe('hangul')
    expect(classifyGrapheme('「')).toBe('fullwidth')
    expect(classifyGrapheme('🎉')).toBe('emoji')
    expect(classifyGrapheme('👩‍💻')).toBe('emoji')
    expect(classifyGrapheme('1️⃣')).toBe('emoji')
    expect(classifyGrapheme('🇯🇵')).toBe('flag')
    expect(classifyGrapheme('ж')).toBe('other')
  })

  it('an unknown family is measured as Nunito and counted', () => {
    const m = createTableTextMetrics()
    m.getLineWidth('abc', '20px Lilita One, sans-serif')
    expect(m.stats.unknownFamilies).toBe(1)
  })
})

describe('server-made notes in Node (getStickyNoteLayout, newTextElement)', () => {
  it('runs without a DOM and builds a note + bound label with created: null (no footer)', () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined')
    const { note, label } = buildStickyNote({ id: 'n1', x: 10, y: 20, text: 'Hello Lobby' })
    expect(note).toMatchObject({
      id: 'n1',
      type: 'stickynote',
      created: null,
      width: 200,
      baseHeight: 200,
      roughness: 0,
    })
    expect(note.boundElements).toEqual([{ id: 'n1.t', type: 'text' }])
    expect(label).toMatchObject({
      id: 'n1.t',
      type: 'text',
      containerId: 'n1',
      originalText: 'Hello Lobby',
      fontFamily: 6,
    })
    expect(label?.text).toBe('Hello Lobby')
    expect(stickyNoteHasFooter(note)).toBe(false)
    expect(stickyNoteHasFooter({ ...note, created: Date.UTC(2026, 8, 28) })).toBe(true)
  })

  it('shrinks the font towards 16 px, then grows the note past its base height', () => {
    const long = 'word '.repeat(120).trim()
    const { note, label } = buildStickyNote({ id: 'n2', x: 0, y: 0, text: long, baseFontSize: 36 })
    expect(label?.fontSize).toBe(16)
    expect(note.height).toBeGreaterThan(note.baseHeight)
    const short = buildStickyNote({ id: 'n3', x: 0, y: 0, text: 'Hi', baseFontSize: 36 })
    expect(short.label?.fontSize).toBe(36)
    expect(short.note.height).toBe(200)
  })

  it('wraps at the note width minus padding, and keeps hard line breaks', () => {
    const { label } = buildStickyNote({
      id: 'n4',
      x: 0,
      y: 0,
      text: 'one\ntwo three four five six seven eight nine ten',
    })
    const lines = (label?.text ?? '').split('\n')
    expect(lines[0]).toBe('one')
    expect(lines.length).toBeGreaterThan(2)
    for (const l of lines) expect(metrics.width(l, 6, label?.fontSize ?? 20)).toBeLessThanOrEqual(200 - 32)
    expect(wrapLabelText('aaaa bbbb', 6, 20, 1e9)).toBe('aaaa bbbb')
  })

  it('an empty note has no label; layout without a label keeps the base size', () => {
    const { note, label } = buildStickyNote({ id: 'n5', x: 0, y: 0, text: '' })
    expect(label).toBeNull()
    expect(note.boundElements).toBeNull()
    expect(layoutStickyNote(note, null).container).toMatchObject({ width: 200, height: 200, baseHeight: 200 })
  })

  it('is deterministic for the same spec', () => {
    const a = buildStickyNote({ id: 'n6', x: 1, y: 2, text: 'Same text every time', seed: 7 })
    // cross a millisecond boundary so any wall-clock field (e.g. `created`) always shows up
    const t = Date.now()
    while (Date.now() === t) {
      // spin
    }
    const b = buildStickyNote({ id: 'n6', x: 1, y: 2, text: 'Same text every time', seed: 7 })
    expect(a.label?.created).toBeNull()
    // `updated` is stamped by the server on commit; `versionNonce` is random by design
    const strip = (e: object) => ({ ...e, updated: 0, versionNonce: 0 })
    expect(strip(a.note)).toEqual(strip(b.note))
    expect(a.label && strip(a.label)).toEqual(b.label && strip(b.label))
  })
})

describe('bindability (plan §2.4.4), pinned to the engine', () => {
  const ALL = [
    'rectangle',
    'stickynote',
    'diamond',
    'ellipse',
    'text',
    'arrow',
    'line',
    'freedraw',
    'image',
    'frame',
  ]
  it('engine answers, unfiltered', () => {
    expect(engineBindableTypes([...ALL, 'iframe', 'embeddable', 'magicframe'])).toEqual([
      'rectangle',
      'stickynote',
      'diamond',
      'ellipse',
      'text',
      'image',
      'frame',
      'iframe',
      'embeddable',
      'magicframe',
    ])
    expect(engineTextContainerTypes(ALL)).toEqual(['rectangle', 'stickynote', 'diamond', 'ellipse', 'arrow'])
  })

  it("Lobby's wrappers: refused types are never bindable; a bound label is not; locked still counts", () => {
    expect(isBindable({ type: 'rectangle', locked: true })).toBe(true)
    expect(isBindable({ type: 'text', locked: false, containerId: null })).toBe(true)
    expect(isBindable({ type: 'text', locked: false, containerId: 'x' })).toBe(false)
    for (const t of ['iframe', 'embeddable', 'magicframe', 'selection'])
      expect(isBindable({ type: t, locked: false })).toBe(false)
    expect(isTextContainer({ type: 'arrow', locked: false })).toBe(true)
    expect(isTextContainer({ type: 'image', locked: false })).toBe(false)
    expect(isBindable(null)).toBe(false)
  })
})

describe('fractional index helpers', () => {
  it('validates, generates between and orders like Excalidraw', () => {
    expect(isValidIndexKey('a1')).toBe(true)
    expect(isValidIndexKey('a1V')).toBe(true)
    expect(isValidIndexKey('')).toBe(false)
    expect(isValidIndexKey('zz!')).toBe(false)
    expect(isValidIndexKey(null)).toBe(false)
    expect(indexKeyBetween('a1', 'a2')).toBe('a1V')
    const ks = indexKeysBetween('a1', 'a2', 3)
    expect([...ks].sort()).toEqual(ks)
    expect(ks.every((k) => k > 'a1' && k < 'a2')).toBe(true)
    const els = [
      { id: 'b', index: 'a1' },
      { id: 'a', index: 'a1' },
      { id: 'c', index: 'a0' },
    ]
    expect([...els].sort(compareByIndex).map((e) => e.id)).toEqual(['c', 'a', 'b'])
  })
})
