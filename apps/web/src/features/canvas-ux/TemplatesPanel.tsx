// PRE-02/03 template picker (dock panel `templates`, opened from the toolbar's Templates button):
// search + categories + a schematic preview of each template's sections. Choosing one inserts it into
// empty space near the viewport, selected and in view, as one undo step (template-insert.ts).

import { useMemo, useState } from 'react'
import { isReadonlyRole } from '../../board/access.ts'
import type { FeatureContext } from '../types.ts'
import { instantiateTemplate, TEMPLATES, type TemplateCategory, type TemplateDefinition } from './deps.ts'
import { NOTE_PALETTE } from './palette.ts'
import { insertTemplate } from './template-insert.ts'

const CATEGORIES: { id: 'all' | TemplateCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ideate', label: 'Ideate' },
  { id: 'visual', label: 'Visual' },
  { id: 'plan', label: 'Plan' },
  { id: 'review', label: 'Review' },
]

interface PreviewShape {
  kind: 'frame' | 'note' | 'box' | 'text'
  x: number
  y: number
  w: number
  h: number
  fill?: string
}

const previews = new Map<string, { w: number; h: number; shapes: PreviewShape[] }>()

/** A schematic of the template (frames, notes, image slots) at the origin, computed once per template. */
function previewOf(t: TemplateDefinition) {
  const cached = previews.get(t.id)
  if (cached) return cached
  const { records, bounds } = instantiateTemplate(t.id, {
    pageId: 'page:preview' as never,
    origin: { x: 0, y: 0 },
  })
  const byId = new Map<string, unknown>(records.map((r) => [r.id as string, r]))
  const pageXY = (id: string): { x: number; y: number } => {
    const r = byId.get(id) as { x: number; y: number; parentId: string } | undefined
    if (!r) return { x: 0, y: 0 }
    const p = r.parentId.startsWith('shape:') ? pageXY(r.parentId) : { x: 0, y: 0 }
    return { x: p.x + r.x, y: p.y + r.y }
  }
  const shapes: PreviewShape[] = []
  for (const r of records) {
    if (r.typeName !== 'shape') continue
    const s = r as unknown as { id: string; type: string; props: Record<string, unknown> }
    const at = pageXY(s.id)
    const w = typeof s.props.w === 'number' ? s.props.w : 200
    const h = typeof s.props.h === 'number' ? s.props.h : 200
    if (s.type === 'frame') shapes.push({ kind: 'frame', ...at, w, h })
    else if (s.type === 'note') {
      const fill = NOTE_PALETTE.find((p) => p.name === s.props.color)?.light.fill ?? '#f8e48f'
      shapes.push({ kind: 'note', ...at, w: 200, h: 200, fill })
    } else if (s.type === 'geo') shapes.push({ kind: 'box', ...at, w, h })
    else if (s.type === 'text') shapes.push({ kind: 'text', ...at, w: Math.max(w, 300), h: 40 })
  }
  const result = {
    w: bounds.w,
    h: bounds.h,
    shapes: shapes.map((s) => ({ ...s, x: s.x - bounds.x, y: s.y - bounds.y })),
  }
  previews.set(t.id, result)
  return result
}

function TemplatePreview({ t }: { t: TemplateDefinition }) {
  const p = useMemo(() => previewOf(t), [t])
  return (
    <svg className="dr-cux-tpl__preview" viewBox={`-40 -40 ${p.w + 80} ${p.h + 80}`} aria-hidden="true">
      {p.shapes.map((s, i) =>
        s.kind === 'frame' ? (
          <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx="24" className="dr-cux-tpl__frame" />
        ) : s.kind === 'note' ? (
          <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx="10" fill={s.fill} />
        ) : s.kind === 'box' ? (
          <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx="10" className="dr-cux-tpl__box" />
        ) : (
          <rect key={i} x={s.x} y={s.y + 10} width={s.w} height={22} rx="8" className="dr-cux-tpl__text" />
        ),
      )}
    </svg>
  )
}

export function TemplatesPanel({ ctx, close }: { ctx: FeatureContext; close(): void }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | TemplateCategory>('all')
  const readonly = isReadonlyRole(ctx.role, ctx.board.status)
  const q = query.trim().toLowerCase()
  const list = TEMPLATES.filter(
    (t) =>
      (category === 'all' || t.category === category) &&
      (!q || `${t.name} ${t.description} ${t.sections.join(' ')}`.toLowerCase().includes(q)),
  )

  const insert = (t: TemplateDefinition) => {
    const { editor } = ctx
    // Close the picker first: the dock closing widens the canvas, so measure the viewport again before
    // choosing the spot and zooming, or the template lands off-centre (partly out of view).
    close()
    setTimeout(() => {
      editor.updateViewportScreenBounds(editor.getContainer())
      const result = insertTemplate(editor, t.id)
      if (!result.ok) {
        ctx.notify({
          key: 'template-insert',
          tone: 'error',
          text:
            result.reason === 'readonly'
              ? 'You can view this board but not add templates to it.'
              : result.reason === 'too-many-shapes'
                ? 'This board has too many objects to add this template.'
                : 'The template could not be added.',
        })
        return
      }
      editor.focus()
      ctx.notify({
        key: 'template-insert',
        text: `Added “${t.name}”. Undo removes it.`,
        testId: 'template-inserted',
      })
    }, 0)
  }

  return (
    <div className="dr-cux-templates" data-testid="template-picker">
      <label className="dr-cux-field">
        <span className="dr-sr-only">Search templates</span>
        <input
          type="search"
          className="dr-input dr-input--block"
          placeholder="Search templates"
          value={query}
          data-testid="template-search"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <fieldset className="dr-cux-chips">
        <legend className="dr-sr-only">Template categories</legend>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className="dr-cux-chip"
            aria-pressed={category === c.id}
            data-testid="template-category"
            data-category={c.id}
            onClick={() => setCategory(c.id)}
          >
            {c.label}
          </button>
        ))}
      </fieldset>
      {readonly && <p className="dr-cux-muted">You can view this board but not add templates to it.</p>}
      {list.length === 0 && <p className="dr-cux-muted">No templates match “{query}”.</p>}
      <ul className="dr-cux-tpl__list">
        {list.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="dr-cux-tpl"
              data-testid="template-option"
              data-template-id={t.id}
              disabled={readonly}
              onClick={() => insert(t)}
            >
              <TemplatePreview t={t} />
              <span className="dr-cux-tpl__name">{t.name}</span>
              <span className="dr-cux-tpl__desc">{t.description}</span>
              <span className="dr-cux-tpl__sections">{t.sections.join(' · ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
