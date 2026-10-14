// L8-3: the Pieces dock panel. A search box and category chips over a list of the shape kits' pieces, each
// drawn small. It is a combobox: the search box keeps the keyboard, the arrow keys move the active piece
// (aria-activedescendant), Enter or a click inserts it at the middle of the view, and dragging one onto the
// board drops it at the pointer (inside the unlocked frame there). Only people who can edit see the panel.
import {
  PIECE_CATEGORIES,
  type PieceCategory,
  type PieceId,
  type PieceInfo,
} from '@draftroom/templates/pieces/catalog'
import { useEffect, useId, useReducer, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { failureText, insertPiece, loadPieces } from './insert.ts'
import { dragPayload, INITIAL, onKey, type PanelState, reduce, resultsOf } from './model.ts'
import { PiecePreview, type PreviewEl } from './Preview.tsx'
import './pieces.css'

type Previews = ReadonlyMap<PieceId, readonly PreviewEl[]>

/** The previews, drawn from the pieces' own elements once the builders have loaded. */
function usePreviews(): Previews | undefined {
  const [previews, set] = useState<Previews | undefined>(undefined)
  useEffect(() => {
    let live = true
    void loadPieces()
      .then(async (m) => {
        // the faces the pieces' words are measured with
        try {
          await (document as Document).fonts?.ready
        } catch {
          // measure with what there is
        }
        const out = new Map<PieceId, readonly PreviewEl[]>()
        for (const p of m.PIECES) {
          try {
            out.set(
              p.id,
              m.instantiatePiece(p.id, { origin: { x: 0, y: 0 } }).elements as unknown as PreviewEl[],
            )
          } catch (e) {
            console.warn('pieces: no preview for', p.id, e)
          }
        }
        if (live) set(out)
      })
      .catch((e) => console.warn('pieces: the builders did not load', e))
    return () => {
      live = false
    }
  }, [])
  return previews
}

export const optionId = (base: string, id: PieceId) => `${base}-${id}`

/** The list of pieces: one option each, the active one marked. Pure markup (a Node test renders it). */
export function PieceList({
  base,
  results,
  active,
  previews,
  readonly,
  onPick,
  onPoint,
  onDragStart,
}: {
  base: string
  results: readonly PieceInfo[]
  active: number
  previews?: Previews
  readonly: boolean
  onPick?(id: PieceId): void
  onPoint?(index: number): void
  onDragStart?(e: React.DragEvent, id: PieceId): void
}) {
  if (results.length === 0) return <p className="dr-pieces__empty">No pieces match.</p>
  return (
    <div className="dr-pieces__list" role="listbox" aria-label="Shapes" id={`${base}-list`}>
      {results.map((p, i) => (
        <div
          key={p.id}
          id={optionId(base, p.id)}
          role="option"
          tabIndex={-1}
          aria-selected={i === active}
          aria-disabled={readonly || undefined}
          className="dr-pieces__option"
          data-testid="piece-option"
          data-piece-id={p.id}
          data-active={i === active || undefined}
          draggable={!readonly}
          onClick={() => !readonly && onPick?.(p.id)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            if (!readonly) onPick?.(p.id)
          }}
          onMouseMove={() => i !== active && onPoint?.(i)}
          onDragStart={(e) => onDragStart?.(e, p.id)}
        >
          <PiecePreview info={p} elements={previews?.get(p.id)} />
          <span className="dr-pieces__text">
            <span className="dr-pieces__name">{p.name}</span>
            <span className="dr-pieces__desc">{p.description}</span>
          </span>
        </div>
      ))}
    </div>
  )
}

export function PiecesPanel({ ctx, close }: { ctx: CanvasFeatureContext; close(): void }) {
  const base = useId().replace(/:/g, '')
  const [state, dispatch] = useReducer(reduce, INITIAL as PanelState)
  const previews = usePreviews()
  const input = useRef<HTMLInputElement>(null)
  const readonly = ctx.canvas.readOnly()
  const results = resultsOf(state)
  const active = results[state.active]

  useEffect(() => {
    input.current?.focus({ preventScroll: true })
  }, [])
  // the active option scrolls into view as the arrows move it
  useEffect(() => {
    if (!active) return
    document.getElementById(optionId(base, active.id))?.scrollIntoView?.({ block: 'nearest' })
  }, [base, active])

  const insert = async (id: PieceId) => {
    if (readonly) return
    const r = await insertPiece(ctx.canvas, id)
    if (!r.ok)
      ctx.notify({
        key: 'piece-insert',
        tone: 'error',
        text: failureText(r.reason),
        testId: 'piece-insert-failed',
      })
    else ctx.canvas.focus({ preventScroll: true })
  }

  return (
    <div className="dr-pieces" data-testid="pieces-panel">
      <label className="dr-pieces__search">
        <span className="dr-sr-only">Search shapes</span>
        <input
          ref={input}
          type="search"
          className="dr-input"
          placeholder="Search shapes"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? `${base}-list` : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active ? optionId(base, active.id) : undefined}
          value={state.query}
          data-testid="piece-search"
          onChange={(e) => dispatch({ type: 'query', query: e.target.value })}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            const r = onKey(state, e.key)
            if (!r.handled) return
            e.preventDefault()
            e.stopPropagation()
            if (r.close) {
              close()
              return
            }
            if (r.state !== state) {
              if (r.state.query !== state.query) dispatch({ type: 'query', query: r.state.query })
              else dispatch({ type: 'point', index: r.state.active })
            }
            if (r.insert) void insert(r.insert)
          }}
        />
      </label>
      <fieldset className="dr-pieces__chips">
        <legend className="dr-sr-only">Piece categories</legend>
        {(
          [{ id: 'all', label: 'All' }, ...PIECE_CATEGORIES] as { id: PieceCategory | 'all'; label: string }[]
        ).map((c) => (
          <button
            key={c.id}
            type="button"
            className="dr-pieces__chip"
            aria-pressed={state.category === c.id}
            data-testid="piece-category"
            data-category={c.id}
            onClick={() => dispatch({ type: 'category', category: c.id })}
          >
            {c.label}
          </button>
        ))}
      </fieldset>
      {readonly && <p className="dr-pieces__note">You can view this board but not add to it.</p>}
      <PieceList
        base={base}
        results={results}
        active={state.active}
        previews={previews}
        readonly={readonly}
        onPick={(id) => void insert(id)}
        onPoint={(index) => dispatch({ type: 'point', index })}
        onDragStart={(e, id) => {
          e.dataTransfer.setData('text/plain', dragPayload(id))
          e.dataTransfer.effectAllowed = 'copy'
        }}
      />
      <p className="dr-pieces__hint" aria-live="polite">
        {results.length === 1 ? '1 piece' : `${results.length} pieces`}. Click or press Enter to add one to
        the middle of the view, or drag it onto the board.
      </p>
    </div>
  )
}
