// A map as an outline (pure): Markdown (a heading for the central topic, then a nested list) or CSV
// (one row per topic: level, topic, parent, path). The rules are ./outline-core.ts (shared with the
// ported feature); this module adds the board CSV's cell rules.

import { csvTextCell } from '@draftroom/board-ops/elements'
import type { MindmapTree } from './model.ts'
import { outlineCsvWith } from './outline-core.ts'

export {
  EMPTY_TOPIC,
  escapeMarkdown,
  type OutlineRow,
  oneLine,
  outlineMarkdown,
  outlineRows,
} from './outline-core.ts'

/**
 * CSV with the header `level,topic,parent,path` (RFC 4180, CRLF records, formula-neutralized text
 * cells through board-ops' csvTextCell, the same rules as the board CSV export). `path` joins the
 * topics from the root with " > ".
 */
export function outlineCsv(tree: MindmapTree, textOf: (id: string) => string): string {
  return outlineCsvWith(tree, textOf, csvTextCell)
}
