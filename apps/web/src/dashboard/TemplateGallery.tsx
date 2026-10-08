// The template picker (PRE-01): the "Lobby tour" sample board first (a full-width card with its six
// frames as a strip), then a prominent Blank board and the six Lobby templates with names, descriptions
// and a section preview, search and categories. Selecting is a click (or Enter/Space); a double click
// creates right away. Also the empty dashboard's "Start with the sample board" button.

import { type ReactNode, useId, useMemo, useState } from 'react'
import { api, isApiError } from '../api/client.ts'
import { navigate } from '../lib/routing.ts'
import { createSampleBoard } from './sample-board.ts'
import type { CatalogEntry, TemplateCategory, TemplateId, TemplatePreview } from './template-catalog.ts'
import { useCatalog } from './use-catalog.ts'
import './template-gallery.css'

export type TemplateChoice = TemplateId | 'blank'

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
  // The sample board has no category chip: it shows under "All" when the search matches it.
  const sample = visible.find((e) => e.category === 'sample') ?? null
  const templates = visible.filter((e) => e.category !== 'sample')

  const card = (choice: TemplateChoice, entry: CatalogEntry | null, content: ReactNode, testId: string) => (
    <li key={choice} style={{ position: 'relative' }}>
      <button
        type="button"
        className={`dr-tcard${choice === 'blank' ? ' dr-tcard--blank' : ''}${entry?.category === 'sample' ? ' dr-tcard--sample' : ''}`}
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
      {selected === choice && <CreateHere choice={choice} entry={entry} onChoose={onChoose} />}
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
      {sample && (
        <ul className="dr-gallery__sample" aria-label="Sample board">
          {card(
            sample.id,
            sample,
            <>
              <span className="dr-tcard__thumb dr-tcard__thumb--strip" aria-hidden="true">
                <TemplateThumb preview={sample.preview} />
              </span>
              <span className="dr-tcard__name">
                {sample.name}
                <span className="dr-tcard__badge">Start here</span>
              </span>
              <span className="dr-tcard__desc">{sample.description}</span>
              <span className="dr-tcard__meta">
                {labels?.sample} · {sample.sections.length} frames, ready to present
              </span>
            </>,
            'template-sample',
          )}
        </ul>
      )}
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
        {templates.map((e) =>
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

/**
 * A11Y-16: the next Tab stop after the chosen card creates the board from it. The footer's Create button
 * was 12 Tabs away (every other card, Title, Project, the checkbox, Cancel). Like a skip link, it shows
 * on the card only while it has the keyboard; the mouse keeps the footer button and double click.
 */
function CreateHere({
  choice,
  entry,
  onChoose,
}: {
  choice: TemplateChoice
  entry: CatalogEntry | null
  onChoose(choice: TemplateChoice, entry: CatalogEntry | null): void
}) {
  const [shown, setShown] = useState(false)
  return (
    <button
      type="button"
      className={shown ? 'dr-btn dr-btn--primary dr-btn--sm' : 'dr-sr-only'}
      style={shown ? { position: 'absolute', top: 8, right: 8, maxWidth: 'calc(100% - 16px)' } : undefined}
      data-testid="template-create-here"
      onFocus={() => setShown(true)}
      onBlur={() => setShown(false)}
      onClick={() => onChoose(choice, entry)}
    >
      {entry && choice !== 'blank' ? `Create from ${entry.name}` : 'Create board'}
    </button>
  )
}

/** The empty dashboard's "Start with the sample board": a new private board with the Lobby tour on it. */
export function SampleBoardButton({
  workspaceId,
  projectId,
  onError,
}: {
  workspaceId: string
  projectId: string | null
  onError(message: string): void
}) {
  const [pending, setPending] = useState(false)
  const start = async () => {
    setPending(true)
    try {
      navigate(await createSampleBoard(api.createBoard, workspaceId, projectId))
    } catch (e) {
      setPending(false)
      onError(isApiError(e) ? e.message : 'The sample board could not be created.')
    }
  }
  return (
    <button
      type="button"
      className="dr-btn"
      data-testid="start-sample-board"
      disabled={pending}
      aria-busy={pending || undefined}
      title="A six-frame tour of Lobby, ready to present"
      onClick={() => void start()}
    >
      {pending ? 'Creating…' : 'Start with the sample board'}
    </button>
  )
}

/** Frames as labelled sections, notes as coloured squares, boxes and text lines inside them. */
export function TemplateThumb({ preview }: { preview: TemplatePreview }) {
  const { bounds } = preview
  // Stroke widths and corner radii follow the template's size. A strip wider than 3:1 (the six-frame
  // tour) is sized by its height instead, or its outlines would be as thick as its frames are tall.
  const size = Math.min(Math.max(bounds.w, bounds.h), bounds.h * 3)
  const pad = size * 0.03
  const view = `${bounds.x - pad} ${bounds.y - pad} ${bounds.w + pad * 2} ${bounds.h + pad * 2}`
  const unit = size / 160
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
        it.kind === 'note' || it.kind === 'swatch' ? (
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
