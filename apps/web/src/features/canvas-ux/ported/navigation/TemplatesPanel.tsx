// PRE-02/03 template picker on the new canvas (dock panel `templates`, opened from the toolbar's Templates
// button): search + categories + a schematic preview of each template's sections (drawn from its plan, as
// the dashboard's gallery draws it). Choosing one inserts it into empty space near the view, selected and
// in view, as one undo step (./template-insert.ts; blocked by CR-2D-2 until LobbyTx.insert lands).
import {
  planTemplate,
  TEMPLATE_INFOS,
  type TemplateCategory,
  type TemplateInfo,
} from '@draftroom/templates/plan'
import { useMemo, useState } from 'react'
import { isReadonlyRole } from '../../../../board/access.ts'
import type { CanvasFeatureContext } from '../../../../canvas/api/index.ts'
import { type TemplatePreview as Preview, previewFromPlan } from '../../../../dashboard/template-catalog.ts'
import { insertTemplate } from './template-insert.ts'

const CATEGORIES: { id: 'all' | TemplateCategory; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ideate', label: 'Ideate' },
  { id: 'visual', label: 'Visual' },
  { id: 'plan', label: 'Plan' },
  { id: 'review', label: 'Review' },
]

const previews = new Map<string, Preview>()
/** The schematic of a template (frames, notes, boxes, text) at the origin, computed once per template. */
function previewOf(t: TemplateInfo): Preview {
  const cached = previews.get(t.id)
  if (cached) return cached
  const p = previewFromPlan(planTemplate(t.id, { x: 0, y: 0 }))
  previews.set(t.id, p)
  return p
}

function TemplatePreview({ t }: { t: TemplateInfo }) {
  const p = useMemo(() => previewOf(t), [t])
  const { x, y, w, h } = p.bounds
  return (
    <svg
      className="dr-cux-tpl__preview"
      viewBox={`${x - 40} ${y - 40} ${w + 80} ${h + 80}`}
      aria-hidden="true"
    >
      {p.frames.map((f, i) => (
        <rect key={`f${i}`} x={f.x} y={f.y} width={f.w} height={f.h} rx="24" className="dr-cux-tpl__frame" />
      ))}
      {p.items.map((s, i) =>
        s.kind === 'note' || s.kind === 'swatch' ? (
          <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx="10" fill={s.color} />
        ) : s.kind === 'box' ? (
          <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} rx="10" className="dr-cux-tpl__box" />
        ) : (
          <rect key={i} x={s.x} y={s.y + 10} width={s.w} height={22} rx="8" className="dr-cux-tpl__text" />
        ),
      )}
    </svg>
  )
}

export function TemplatesPanel({ ctx, close }: { ctx: CanvasFeatureContext; close(): void }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<'all' | TemplateCategory>('all')
  const readonly = isReadonlyRole(ctx.role, ctx.board.status)
  const q = query.trim().toLowerCase()
  const list = TEMPLATE_INFOS.filter(
    (t) =>
      (category === 'all' || t.category === category) &&
      (!q || `${t.name} ${t.description} ${t.sections.join(' ')}`.toLowerCase().includes(q)),
  )

  const insert = (t: TemplateInfo) => {
    const { canvas } = ctx
    // close the picker first: the dock closing widens the canvas, so measure again before choosing the
    // spot and zooming, or the template lands off-centre (partly out of view)
    close()
    setTimeout(() => {
      canvas.viewport.remeasure()
      void insertTemplate(canvas, t.id).then((result) => {
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
        canvas.focus({ preventScroll: true })
        ctx.notify({
          key: 'template-insert',
          text: `Added “${t.name}”. Undo removes it.`,
          testId: 'template-inserted',
        })
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
