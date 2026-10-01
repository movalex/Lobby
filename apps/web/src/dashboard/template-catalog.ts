// The template picker's catalog (PRE-01): the @draftroom/templates definitions with a section preview
// drawn from the plan each template really builds (frames, notes, boxes, text; the same plan both canvases
// emit their records or elements from). The "Lobby tour" sample board comes first; it has no category chip
// of its own, so it is listed under "All" only.
//
// It reads `@draftroom/templates/plan`, which loads neither canvas engine, so the gallery's lazily loaded
// chunk is the same in the tldraw build and the Excalidraw build (docs/EXCALIDRAW-MIGRATION.md §4.9: the
// dashboard is unchanged by the migration).

import {
  type BoardPlan,
  planBounds,
  planTemplate,
  TEMPLATE_INFOS,
  type TemplateCategory,
  type TemplateId,
} from '@draftroom/templates/plan'

export type { TemplateCategory, TemplateId }

export interface PreviewRect {
  x: number
  y: number
  w: number
  h: number
}
export interface PreviewItem extends PreviewRect {
  kind: 'note' | 'box' | 'swatch' | 'text'
  color: string
}
export interface TemplatePreview {
  /** Page-space bounds of the whole template (the SVG viewBox). */
  bounds: PreviewRect
  frames: (PreviewRect & { name: string })[]
  items: PreviewItem[]
}
export interface CatalogEntry {
  id: TemplateId
  name: string
  description: string
  category: TemplateCategory
  sections: readonly string[]
  preview: TemplatePreview
}

export const CATEGORY_LABEL: Record<TemplateCategory, string> = {
  ideate: 'Ideate',
  visual: 'Visual',
  plan: 'Plan',
  review: 'Review',
  sample: 'Sample',
}
/** The category chips. The sample board is in none of them. */
export const CATEGORIES: readonly TemplateCategory[] = ['ideate', 'visual', 'plan', 'review']

/** The "Lobby tour" sample board (packages/templates lobby-tour.ts). */
export const isSample = (entry: Pick<CatalogEntry, 'category'>) => entry.category === 'sample'

/** Lobby colour names -> preview fills (approximate; thumbnails only). */
const FILL: Record<string, string> = {
  black: '#3a3f47',
  grey: '#adb5bd',
  'light-violet': '#e5d0ff',
  violet: '#b683e6',
  blue: '#6f8ff0',
  'light-blue': '#b6dcff',
  yellow: '#ffe066',
  orange: '#ffb66e',
  green: '#4fbf8b',
  'light-green': '#bfefc6',
  'light-red': '#ffc9c9',
  red: '#f07b7b',
  white: '#ffffff',
}
const fill = (color: unknown) => (typeof color === 'string' && FILL[color]) || FILL.yellow || '#ffe066'

/** The preview of a plan: its frames, and its notes, boxes (swatches in their colour) and texts in page space. */
export function previewFromPlan(plan: BoardPlan): TemplatePreview {
  const frames: TemplatePreview['frames'] = []
  const items: PreviewItem[] = []
  for (const node of plan.nodes) {
    const { x, y, w, h } = node.page
    if (node.kind === 'frame') frames.push({ x, y, w, h, name: node.name })
    else if (node.kind === 'note') items.push({ kind: 'note', x, y, w, h, color: fill(node.color) })
    else if (node.kind === 'geo')
      // A full-colour fill (a palette swatch) shows its colour; other shapes read as neutral boxes.
      items.push({ kind: node.fill === 'fill' ? 'swatch' : 'box', x, y, w, h, color: fill(node.color) })
    else if (node.kind === 'text')
      items.push({ kind: 'text', x, y, w: Math.min(node.w, 600), h: 18, color: fill(node.color) })
  }
  const b = planBounds(plan)
  return { bounds: { x: b.x, y: b.y, w: b.w, h: b.h }, frames, items }
}

let cache: readonly CatalogEntry[] | null = null

/** The catalog, the sample first (built once; planning the templates takes a few milliseconds). */
export function templateCatalog(): readonly CatalogEntry[] {
  if (cache) return cache
  const ordered = [
    ...TEMPLATE_INFOS.filter((t) => isSample(t)),
    ...TEMPLATE_INFOS.filter((t) => !isSample(t)),
  ]
  cache = ordered.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    sections: t.sections,
    preview: previewFromPlan(planTemplate(t.id, { x: 0, y: 0 })),
  }))
  return cache
}

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase()

/** Search (every word in name, description, category or section names) within a category. */
export function filterTemplates(
  entries: readonly CatalogEntry[],
  query: string,
  category: TemplateCategory | 'all',
): CatalogEntry[] {
  const words = fold(query).split(/\s+/).filter(Boolean)
  return entries.filter((e) => {
    if (category !== 'all' && e.category !== category) return false
    if (!words.length) return true
    const hay = fold([e.name, e.description, CATEGORY_LABEL[e.category], ...e.sections].join(' '))
    return words.every((w) => hay.includes(w))
  })
}
