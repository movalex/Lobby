// The outline of a map on the new canvas: the shared rules (../outline-core.ts) with the board CSV's cell
// rules from `@draftroom/board-ops/elements` (the engine-neutral path; the package root is the tldraw one).

import { csvTextCell } from '@draftroom/board-ops/elements'
import type { MindmapTree } from '../model.ts'
import { outlineCsvWith } from '../outline-core.ts'

export { outlineMarkdown } from '../outline-core.ts'

export function outlineCsv(tree: MindmapTree, textOf: (id: string) => string): string {
  return outlineCsvWith(tree, textOf, csvTextCell)
}
