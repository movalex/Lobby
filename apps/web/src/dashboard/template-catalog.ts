// The template picker's catalog (PRE-01): the six @draftroom/templates definitions with a section
// preview drawn from the records each template really produces (frames, notes, boxes, text).

import { instantiateTemplate, TEMPLATES, type TemplateCategory, type TemplateId } from '@draftroom/templates'
import type { TLPageId } from 'tldraw'

export type { TemplateCategory, TemplateId }

export interface PreviewRect {
  x: number
  y: number
  w: number
  h: number
}
export interface PreviewItem extends PreviewRect {
  kind: 'note' | 'box' | 'text'
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
}
export const CATEGORIES: readonly TemplateCategory[] = ['ideate', 'visual', 'plan', 'review']

/** tldraw colour names -> preview fills (approximate; thumbnails only). */
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

interface ShapeLike {
  typeName: string
  id?: string
  type?: string
  parentId?: string
  x?: number
  y?: number
  props?: Record<string, unknown>
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Builds the preview from the template's records (frames are top-level; children are frame-relative). */
export function previewFromRecords(
  records: readonly ShapeLike[],
  pageId: string,
  bounds: PreviewRect,
): TemplatePreview {
  const shapes = records.filter((r) => r.typeName === 'shape')
  const byId = new Map(shapes.map((s) => [s.id, s]))
  const origin = (s: ShapeLike): { x: number; y: number } => {
    const x = num(s.x, 0)
    const y = num(s.y, 0)
    const parent = s.parentId && s.parentId !== pageId ? byId.get(s.parentId) : undefined
    if (!parent) return { x, y }
    const p = origin(parent)
    return { x: p.x + x, y: p.y + y }
  }
  const frames: TemplatePreview['frames'] = []
  const items: PreviewItem[] = []
  for (const s of shapes) {
    const { x, y } = origin(s)
    const props = s.props ?? {}
    const scale = num(props.scale, 1)
    if (s.type === 'frame') {
      frames.push({ x, y, w: num(props.w, 0), h: num(props.h, 0), name: String(props.name ?? '') })
    } else if (s.type === 'note') {
      items.push({ kind: 'note', x, y, w: 200 * scale, h: 200 * scale, color: fill(props.color) })
    } else if (s.type === 'geo') {
      items.push({ kind: 'box', x, y, w: num(props.w, 100), h: num(props.h, 100), color: fill(props.color) })
    } else if (s.type === 'text') {
      items.push({
        kind: 'text',
        x,
        y,
        w: Math.min(num(props.w, 300), 600) * scale,
        h: 18 * scale,
        color: fill(props.color),
      })
    }
  }
  return { bounds, frames, items }
}

let cache: readonly CatalogEntry[] | null = null

/** The catalog (built once; instantiating six templates takes a few milliseconds). */
export function templateCatalog(): readonly CatalogEntry[] {
  if (cache) return cache
  const pageId = 'page:preview'
  cache = TEMPLATES.map((t) => {
    const { records, bounds } = instantiateTemplate(t.id, {
      pageId: pageId as TLPageId,
      origin: { x: 0, y: 0 },
    })
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      sections: t.sections,
      preview: previewFromRecords(records as unknown as ShapeLike[], pageId, bounds),
    }
  })
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
