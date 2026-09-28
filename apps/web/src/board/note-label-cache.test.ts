import { createTLStore, defaultShapeUtils, NoteShapeUtil } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { FileCardShapeUtil } from '../file-card/FileCardShapeUtil.tsx'
import {
  createLabelSizeCache,
  type LabelSize,
  LobbyNoteShapeUtil,
  labelMeasureKey,
} from './note-label-cache.ts'

interface FakeNote {
  id: string
  x: number
  meta: Record<string, unknown>
  props: { richText: object; size: string }
}

function setup() {
  let fonts = 'fonts-1'
  const measured: string[] = []
  const get = createLabelSizeCache<FakeNote>({
    richText: (s) => s.props.richText,
    key: (s) => `size:${s.props.size}`,
    fontsVersion: () => fonts,
    measure: (s): LabelSize => {
      measured.push(s.id)
      return { labelHeight: s.props.size === 'l' ? 90 : 60, labelWidth: 150, fontSizeAdjustment: 22 }
    },
  })
  return { get, measured, setFonts: (v: string) => (fonts = v) }
}

describe('note label size cache', () => {
  it('measures a note once while its text and display values stay the same (moves, meta, colour)', () => {
    const { get, measured } = setup()
    const richText = { type: 'doc' }
    const note: FakeNote = { id: 'n1', x: 0, meta: {}, props: { richText, size: 'm' } }
    const first = get(note)
    // new records (a move, a tag in meta, a colour change) keep the same rich-text object
    expect(get({ ...note, x: 10 })).toBe(first)
    expect(get({ ...note, meta: { 'drTags:idea': { name: 'Idea', color: 'violet' } } })).toBe(first)
    expect(get({ ...note, props: { ...note.props } })).toBe(first)
    expect(measured).toEqual(['n1'])
  })

  it('measures again for new text, other display values or a font that finished loading', () => {
    const { get, measured, setFonts } = setup()
    const note: FakeNote = { id: 'n1', x: 0, meta: {}, props: { richText: { type: 'doc' }, size: 'm' } }
    get(note)
    get({ ...note, props: { ...note.props, richText: { type: 'doc', edited: true } } })
    expect(get({ ...note, props: { ...note.props, size: 'l' } }).labelHeight).toBe(90)
    setFonts('fonts-2')
    get(note)
    get(note)
    expect(measured).toEqual(['n1', 'n1', 'n1', 'n1'])
  })

  it('keys on every display value the measurement reads', () => {
    const dv = {
      labelFontSize: 22,
      labelLineHeight: 1.35,
      labelFontFamily: 'tldraw_sans',
      noteWidth: 200,
      noteHeight: 200,
      labelPadding: 16,
    }
    const base = labelMeasureKey(dv)
    for (const [k, v] of Object.entries({
      labelFontSize: 18,
      labelLineHeight: 1.5,
      labelFontFamily: 'tldraw_serif',
      noteWidth: 400,
      noteHeight: 400,
      labelPadding: 8,
    })) {
      expect(labelMeasureKey({ ...dv, [k]: v })).not.toBe(base)
    }
  })
})

describe('LobbyNoteShapeUtil', () => {
  it('is tldraw 5.4.2 note: same type, props and migrations, and the methods it caches still exist', () => {
    expect(LobbyNoteShapeUtil.type).toBe(NoteShapeUtil.type)
    expect(LobbyNoteShapeUtil.props).toBe(NoteShapeUtil.props)
    expect(LobbyNoteShapeUtil.migrations).toBe(NoteShapeUtil.migrations)
    // TypeScript-private in tldraw: if an upgrade renames them the cache silently switches off, so say so here.
    const proto = NoteShapeUtil.prototype as unknown as Record<string, unknown>
    expect(typeof proto.getLabelSize).toBe('function')
    expect(typeof proto.measureNoteLabelSize).toBe('function')
  })

  it('gives the board store the same schema as tldraw’s own note', () => {
    const withDefault = createTLStore({ shapeUtils: [...defaultShapeUtils, FileCardShapeUtil] })
    const withLobby = createTLStore({
      shapeUtils: [
        ...defaultShapeUtils.filter((u) => u.type !== 'note'),
        FileCardShapeUtil,
        LobbyNoteShapeUtil,
      ],
    })
    expect(withLobby.schema.serialize()).toEqual(withDefault.schema.serialize())
  })
})
