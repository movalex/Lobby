// Sticky-note label measuring, cached by what the measurement reads (perf, docs/WAVE4-CONTRACTS.md §2).
//
// tldraw 5.4.2's NoteShapeUtil measures a note's text in the DOM (TextManager.measureHtml writes the
// text into a hidden element and reads getBoundingClientRect: a synchronous style + layout of the
// page) and caches the result per shape RECORD. Geometry is recomputed whenever a note's props or meta
// change, so a colour change, a tag, a +1, a vote or any other meta write (by anyone: remote changes
// and the sync client's rebase create new records too) measured the unchanged text again. On a
// 4,700-shape board each of those forced layouts cost milliseconds, per note, per change, in every tab.
//
// The measurement reads only the rich text and six display values (font size, line height, font
// family, note width and height, padding: NoteShapeUtil.measureNoteLabelSize), so this caches it per
// rich-text object and those values. Anything that changes them (typing, size, font, scale, theme)
// measures again, exactly as before. Fonts that finish loading change text metrics without changing
// any of that, so the cache also keys on the document's font set (tldraw adds each web font it loads).

import {
  type Editor,
  getDisplayValues,
  NoteShapeUtil,
  type NoteShapeUtilDisplayValues,
  type TLNoteShape,
} from 'tldraw'

export interface LabelSize {
  labelHeight: number
  labelWidth: number
  fontSizeAdjustment: number
}

/** The display values measureNoteLabelSize reads (tldraw 5.4.2), as one key. */
export function labelMeasureKey(
  dv: Pick<
    NoteShapeUtilDisplayValues,
    'labelFontSize' | 'labelLineHeight' | 'labelFontFamily' | 'noteWidth' | 'noteHeight' | 'labelPadding'
  >,
): string {
  return `${dv.labelFontSize}|${dv.labelLineHeight}|${dv.labelFontFamily}|${dv.noteWidth}|${dv.noteHeight}|${dv.labelPadding}`
}

/**
 * A label-size cache per rich-text object (weakly held) and measure key, valid while `fontsVersion`
 * is unchanged. `measure` runs only on a miss.
 */
export function createLabelSizeCache<Shape>(opts: {
  richText(shape: Shape): object
  key(shape: Shape): string
  fontsVersion(): string
  measure(shape: Shape): LabelSize
}) {
  const byText = new WeakMap<object, Map<string, { fonts: string; size: LabelSize }>>()
  return (shape: Shape): LabelSize => {
    const text = opts.richText(shape)
    const key = opts.key(shape)
    const fonts = opts.fontsVersion()
    let perKey = byText.get(text)
    const hit = perKey?.get(key)
    if (hit && hit.fonts === fonts) return hit.size
    const size = opts.measure(shape)
    if (!perKey) {
      perKey = new Map()
      byText.set(text, perKey)
    }
    perKey.set(key, { fonts, size })
    return size
  }
}

// NoteShapeUtil's measuring methods are TypeScript-private in tldraw 5.4.2; they are plain methods at
// runtime. Should a later tldraw rename them, notes simply keep tldraw's own cache.
interface NoteLabelInternals {
  getLabelSize?: (shape: TLNoteShape) => LabelSize
  measureNoteLabelSize?: (shape: TLNoteShape) => LabelSize
}

/** tldraw's note with the label size cached by content instead of by record. Same type, props, migrations. */
export class LobbyNoteShapeUtil extends NoteShapeUtil {
  constructor(editor: Editor) {
    super(editor)
    const self = this as unknown as NoteLabelInternals
    const measure = self.measureNoteLabelSize
    if (typeof self.getLabelSize !== 'function' || typeof measure !== 'function') return
    const doc = editor.getContainer().ownerDocument
    let loaded = 0
    const onLoaded = () => {
      loaded++
    }
    doc.fonts?.addEventListener('loadingdone', onLoaded)
    editor.disposables.add(() => doc.fonts?.removeEventListener('loadingdone', onLoaded))
    self.getLabelSize = createLabelSizeCache<TLNoteShape>({
      richText: (shape) => shape.props.richText,
      key: (shape) => labelMeasureKey(getDisplayValues(this, shape)),
      fontsVersion: () => `${doc.fonts?.size ?? 0}/${loaded}`,
      measure: (shape) => measure.call(this, shape),
    })
  }
}
