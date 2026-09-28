/**
 * A3, browser side: lay out the corpus with Lobby's server builder (`buildStickyNote`) but with
 * Excalidraw's default canvas metrics, after every font face the labels need has loaded.
 */
import { fontString } from '../../../../../packages/canvas-schema/src/engine/layout.ts'
import type { CorpusLabel } from '../a3/corpus.ts'
import { layoutLabels } from '../a3/layout-labels.ts'

export const layoutCorpusInBrowser = async (labels: readonly CorpusLabel[]) => {
  // load every face (unicode-range subset) the labels need before the first measurement, so no
  // width is cached from a fallback font (`charWidth` caches per font string, element index.js:5772)
  for (const l of labels) await document.fonts.load(fontString(l.fontFamily, l.baseFontSize), l.text || 'x')
  await document.fonts.ready
  const faces = [...document.fonts].map((f) => ({ family: f.family, status: f.status }))
  const loaded = faces.filter((f) => f.status === 'loaded')
  const t0 = performance.now()
  const layouts = layoutLabels(labels)
  return {
    layouts,
    ms: performance.now() - t0,
    fontFaces: {
      registered: faces.length,
      loaded: loaded.length,
      loadedFamilies: [...new Set(loaded.map((f) => f.family))],
    },
  }
}
