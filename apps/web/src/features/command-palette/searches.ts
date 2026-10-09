// OWNER: W3 (wave L, L3-2). The board palette's "On this board" search, after a pause in typing (two or
// more characters): the board search's own model (navigation model.ts searchCanvas, with the tags feature's
// words, as the Search panel searches). A hit selects the element and zooms to it: camera and selection
// only, nothing is written. The workspace search is ./workspace-search.ts.
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { searchCanvas } from '../canvas-ux/ported/navigation/model.ts'
import { goToElement } from '../canvas-ux/ported/navigation/SearchPanel.tsx'
import { typeLabel } from '../canvas-ux/search-filter.ts'
import { searchWithTags } from '../tags/ported/SearchTagFilter.tsx'
import type { PaletteEntry, PaletteSearch } from './model.ts'

export const BOARD_HITS_MAX = 8

/** "On this board": the live elements (hidden ones left out), as the Search panel finds them. */
export function boardSearch(ctx: CanvasFeatureContext): PaletteSearch {
  const { canvas } = ctx
  return {
    id: 'board',
    title: 'On this board',
    limit: BOARD_HITS_MAX,
    find: async (query) =>
      searchCanvas(canvas.items(), query, {
        limit: BOARD_HITS_MAX,
        filter: 'all',
        isHidden: (id) => canvas.isHidden(id),
        search: (elements, q, o) => searchWithTags(canvas, elements, q, { limit: o.limit, tag: null }),
      }).map(
        (h): PaletteEntry => ({
          id: `board:${h.id}`,
          label: h.snippet.replace(/\s+/g, ' ').trim() || typeLabel(h.type),
          group: 'On this board',
          detail: typeLabel(h.type),
          run: () => goToElement(canvas, h.id),
        }),
      ),
  }
}
