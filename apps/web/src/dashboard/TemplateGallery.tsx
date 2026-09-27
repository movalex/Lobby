// The template picker (PRE-01): a prominent Blank board plus the six Draftroom templates with names,
// descriptions and a section preview, search and categories. Selecting is a click (or Enter/Space);
// a double click creates right away.

import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import type { CatalogEntry, TemplateCategory, TemplateId, TemplatePreview } from './template-catalog.ts'

export type TemplateChoice = TemplateId | 'blank'

type Catalog = typeof import('./template-catalog.ts')

/** The catalog module pulls in the template builders; load it only when the picker opens. */
function useCatalog(): { mod: Catalog | null; error: boolean } {
  const [mod, setMod] = useState<Catalog | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    import('./template-catalog.ts').then(
      (m) => live && setMod(m),
      () => live && setError(true),
    )
    return () => {
      live = false
    }
  }, [])
  return { mod, error }
}

export function TemplateGallery({
  selected,
  onSelect,
  onChoose,
}: {
  selected: TemplateChoice
  onSelect(choice: TemplateChoice, entry: CatalogEntry | null): void
  /** Double click / Enter on an already selected card: create now. */
  onChoose(choice: TemplateChoice, entry: CatalogEntry | null): void
}) {
  const { mod, error } = useCatalog()
  const searchId = useId()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<TemplateCategory | 'all'>('all')
  const entries = useMemo(() => (mod ? mod.templateCatalog() : []), [mod])
  const visible = useMemo(
    () => (mod ? mod.filterTemplates(entries, query, category) : []),
    [mod, entries, query, category],
  )
  const labels = mod?.CATEGORY_LABEL

  const card = (choice: TemplateChoice, entry: CatalogEntry | null, content: ReactNode, testId: string) => (
    <li key={choice}>
      <button
        type="button"
        className={`dr-tcard${choice === 'blank' ? ' dr-tcard--blank' : ''}`}
        data-testid={testId}
        data-template-id={choice}
        aria-pressed={selected === choice}
        onClick={() => onSelect(choice, entry)}
        onDoubleClick={() => onChoose(choice, entry)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && selected === choice) {
            e.preventDefault()
            onChoose(choice, entry)
          }
        }}
      >
        {content}
      </button>
    </li>
  )

  return (
    <div className="dr-gallery" data-testid="template-gallery">
      <div className="dr-gallery__bar">
        <label htmlFor={searchId} className="dr-sr-only">
          Search templates
        </label>
        <input
          id={searchId}
          type="search"
          className="dr-input dr-gallery__search"
          data-testid="template-search"
          placeholder="Search templates"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <fieldset className="dr-gallery__cats">
          <legend className="dr-sr-only">Template categories</legend>
          {(['all', ...(mod?.CATEGORIES ?? [])] as const).map((c) => (
            <button
              key={c}
              type="button"
              className="dr-chip"
              data-testid="template-category"
              data-category={c}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c === 'all' ? 'All' : (labels?.[c] ?? c)}
            </button>
          ))}
        </fieldset>
      </div>
      <ul className="dr-gallery__grid" aria-label="Templates">
        {card(
          'blank',
          null,
          <>
            <span className="dr-tcard__thumb dr-tcard__thumb--blank" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </span>
            <span className="dr-tcard__name">Blank board</span>
            <span className="dr-tcard__desc">Start from an empty canvas.</span>
          </>,
          'template-blank',
        )}
        {visible.map((e) =>
          card(
            e.id,
            e,
            <>
              <span className="dr-tcard__thumb" aria-hidden="true">
                <TemplateThumb preview={e.preview} />
              </span>
              <span className="dr-tcard__name">{e.name}</span>
              <span className="dr-tcard__desc">{e.description}</span>
              <span className="dr-tcard__meta">
                {labels?.[e.category]} · {e.sections.length} sections
              </span>
            </>,
            'template-card',
          ),
        )}
      </ul>
      {!mod && !error && <p className="dr-muted dr-gallery__status">Loading templates…</p>}
      {error && (
        <p className="dr-field-error dr-gallery__status" role="alert">
          Templates could not be loaded. You can still start with a blank board.
        </p>
      )}
      {mod && visible.length === 0 && (
        <p className="dr-muted dr-gallery__status" data-testid="template-empty">
          No templates match. Try another word or category, or start with a blank board.
        </p>
      )}
    </div>
  )
}

/** Frames as labelled sections, notes as coloured squares, boxes and text lines inside them. */
export function TemplateThumb({ preview }: { preview: TemplatePreview }) {
  const { bounds } = preview
  const pad = Math.max(bounds.w, bounds.h) * 0.03
  const view = `${bounds.x - pad} ${bounds.y - pad} ${bounds.w + pad * 2} ${bounds.h + pad * 2}`
  const unit = Math.max(bounds.w, bounds.h) / 160
  return (
    <svg viewBox={view} preserveAspectRatio="xMidYMid meet" className="dr-tthumb" aria-hidden="true">
      {preview.frames.map((f) => (
        <g key={`${f.x},${f.y},${f.name}`}>
          <rect
            x={f.x}
            y={f.y}
            width={f.w}
            height={f.h}
            rx={unit * 1.5}
            fill="#ffffff"
            stroke="#c4bfb0"
            strokeWidth={unit * 0.6}
          />
        </g>
      ))}
      {preview.items.map((it, i) =>
        it.kind === 'note' ? (
          <rect key={i} x={it.x} y={it.y} width={it.w} height={it.h} rx={unit} fill={it.color} />
        ) : it.kind === 'box' ? (
          <rect
            key={i}
            x={it.x}
            y={it.y}
            width={it.w}
            height={it.h}
            rx={unit}
            fill="#f3f1ea"
            stroke="#d6d1c4"
            strokeWidth={unit * 0.5}
          />
        ) : (
          <rect
            key={i}
            x={it.x}
            y={it.y}
            width={it.w}
            height={Math.max(it.h, unit * 2)}
            rx={unit}
            fill="#4a5566"
            opacity="0.35"
          />
        ),
      )}
    </svg>
  )
}
