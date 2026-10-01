// OWNER: 3i. The names of Lobby's built-in tools as the board says them (the phone sheet's rows, the live
// region's tool announcements). Feature tools (comment, vote, …) carry their own label in the tools registry.
import type { FeatureToolSpec } from '../../../canvas/api/index.ts'

export interface ToolRow {
  readonly id: string
  readonly label: string
}

/** Lobby's built-in tools in toolbar order (COL-07's main tools, then the ones in "More"). */
export const EDIT_TOOLS: readonly ToolRow[] = [
  { id: 'select', label: 'Select' },
  { id: 'hand', label: 'Hand' },
  { id: 'note', label: 'Note' },
  { id: 'text', label: 'Text' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'freedraw', label: 'Pen' },
  { id: 'arrow', label: 'Connector' },
  { id: 'frame', label: 'Frame' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'line', label: 'Line' },
  { id: 'highlight', label: 'Highlight' },
  { id: 'eraser', label: 'Eraser' },
  { id: 'laser', label: 'Laser' },
]

/** What a read-only role (commenter, viewer, a limited guest) may pick. */
export const READONLY_TOOLS: readonly ToolRow[] = [
  { id: 'select', label: 'Select' },
  { id: 'hand', label: 'Hand' },
  { id: 'laser', label: 'Laser' },
]

/** Built-in tools that have no toolbar row of their own. */
const OTHER_BUILT_INS: readonly ToolRow[] = [{ id: 'lasso', label: 'Lasso' }]

/**
 * The spoken name of tool `id`: a built-in tool's label, else the feature tool's own label (the tools
 * registry), else null (an unknown tool is not announced).
 */
export function toolLabel(id: string | null, featureTools: readonly FeatureToolSpec[]): string | null {
  if (!id) return null
  const own = [...EDIT_TOOLS, ...OTHER_BUILT_INS].find((t) => t.id === id)
  if (own) return own.label
  return featureTools.find((t) => t.id === id)?.label ?? null
}

/** What the live region says when tool `id` is picked ("Note tool"), or '' for an unknown tool. */
export function toolWords(id: string | null, featureTools: readonly FeatureToolSpec[]): string {
  const label = toolLabel(id, featureTools)
  return label ? `${label} tool` : ''
}
