/**
 * A3: one function lays out the corpus in both runtimes. Only the text metrics differ: Node installs
 * the table provider (`installServerTextMetrics`), the browser keeps Excalidraw's canvas provider.
 */
import { buildStickyNote } from '../../../../../packages/canvas-schema/src/engine/layout.ts'
import type { CorpusLabel } from './corpus.ts'

export interface LabelLayout {
  id: string
  text: string | null
  fontSize: number | null
  labelWidth: number | null
  labelHeight: number | null
  noteHeight: number
}

export const layoutLabels = (labels: readonly CorpusLabel[]): LabelLayout[] =>
  labels.map((l) => {
    const { note, label } = buildStickyNote({
      id: l.id,
      x: 0,
      y: 0,
      text: l.text,
      width: l.width,
      fontFamily: l.fontFamily,
      baseFontSize: l.baseFontSize,
    })
    return {
      id: l.id,
      text: label?.text ?? null,
      fontSize: label?.fontSize ?? null,
      labelWidth: label?.width ?? null,
      labelHeight: label?.height ?? null,
      noteHeight: note.height,
    }
  })
