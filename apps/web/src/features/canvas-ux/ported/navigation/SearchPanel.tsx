// MAK-12 board search on the new canvas (dock panel `search`, Ctrl/Cmd+F): board-ops `searchElements`
// over the live elements (notes, text, shape and connector labels, frame names, image alt text and file
// names; case- and accent-insensitive; every word must match). Results show snippets with the matches
// marked; a type filter narrows them. Enter / click zooms to a result and selects it (Enter again = next,
// Shift+Enter = previous, ↑/↓ move through the list). While the panel is open the canvas dims everything
// except the matches (SearchHighlights). Esc closes the panel and returns focus to the board.
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../../canvas/api/index.ts'
import { useValue } from '../../../../lib/signals.ts'
import { isTextEntry } from '../../../../ui/focus.ts'
import {
  SearchTagFilter,
  searchWithTags,
  textOfQuery,
  useCanvasSearchTag,
} from '../../../tags/ported/SearchTagFilter.tsx'
import {
  highlightParts,
  SEARCH_FILTERS,
  type SearchFilter,
  stepIndex,
  typeLabel,
} from '../../search-filter.ts'
import { type NavSearchHit, searchCanvas } from './model.ts'
import { searchMatches, searchState } from './state.ts'

export const RESULT_LIMIT = 200

/** Selects the element and fits it, never zooming in past 100% just to show one note. */
export function goToElement(canvas: LobbyCanvas, id: string) {
  const b = canvas.bounds(id)
  if (!b) return
  canvas.select([id])
  canvas.viewport.zoomTo(b, { maxZoom: 1, inset: 60, animate: { durationMs: 260 } })
}

/** Re-runs the search at most every 250 ms while the document changes (drags, remote edits). */
function useDocumentVersion(canvas: LobbyCanvas): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const stop = canvas.on('changed', () => {
      if (t) return
      t = setTimeout(() => {
        t = null
        setVersion((v) => v + 1)
      }, 250)
    })
    return () => {
      stop()
      if (t) clearTimeout(t)
    }
  }, [canvas])
  return version
}

export function SearchPanel({ ctx, close }: { ctx: CanvasFeatureContext; close(): void }) {
  const { canvas } = ctx
  const state = searchState(canvas)
  const { query, filter, activeId, focusTick } = useValue('nav-search-state', () => state.get(), [state])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const version = useDocumentVersion(canvas)
  const statusId = useId()
  const resultsId = useId()

  const set = (patch: Partial<ReturnType<typeof state.get>>) => state.set({ ...state.get(), ...patch })

  useEffect(() => {
    void focusTick
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
    // A11Y-13: the board could take the focus back right after the Ctrl/Cmd+F that opened the panel (the
    // canvas, or a note's text editor). Check again a frame later and twice more shortly after (focus
    // only: what was typed meanwhile stays). A field outside the board keeps the focus.
    const again = () => {
      const a = document.activeElement
      if (!input.isConnected || a === input) return
      if (isTextEntry(a) && !canvas.container()?.contains(a)) return
      input.focus()
    }
    const raf = requestAnimationFrame(again)
    const timers = [setTimeout(again, 150), setTimeout(again, 300)]
    return () => {
      cancelAnimationFrame(raf)
      for (const t of timers) clearTimeout(t)
    }
  }, [focusTick, canvas])

  // Tags (3d, wired at the wave-3 integration): words also match tag names, `#word` matches tags only,
  // and the tag filter below the type chips narrows to one tag (tags/ported/search.ts), as on the tldraw
  // board.
  const tag = useCanvasSearchTag(canvas)
  const hits: NavSearchHit[] = useMemo(() => {
    void version
    if (!query.trim() && !tag) return []
    return searchCanvas(canvas.items(), query, {
      limit: RESULT_LIMIT,
      filter,
      isHidden: (id) => canvas.isHidden(id),
      tag,
      search: (elements, q, o) => searchWithTags(canvas, elements, q, { limit: o.limit, tag }),
    })
  }, [canvas, query, filter, version, tag])

  useEffect(() => {
    searchMatches(canvas).set(hits.map((h) => h.id))
  }, [canvas, hits])
  useEffect(
    () => () => {
      searchMatches(canvas).set([])
    },
    [canvas],
  )

  const activeIndex = hits.findIndex((h) => h.id === activeId)

  const activate = (index: number) => {
    const hit = hits[index]
    if (!hit) return
    set({ activeId: hit.id })
    goToElement(canvas, hit.id)
    listRef.current
      ?.querySelector(`[data-shape-id="${CSS.escape(hit.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // the dock hands the keyboard back to what opened the panel: the board after Ctrl/Cmd+F, the rail
      // button after a click on it (A11Y-01)
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      activate(stepIndex(activeIndex, hits.length, e.shiftKey ? -1 : activeIndex < 0 ? 0 : 1))
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      activate(stepIndex(activeIndex, hits.length, e.key === 'ArrowDown' ? 1 : -1))
    }
  }

  const trimmed = query.trim()
  const marked = textOfQuery(trimmed)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard handling for the whole panel (Esc, Enter, arrows)
    <div className="dr-cux-search" data-testid="board-search" onKeyDown={onKeyDown}>
      <label className="dr-cux-field">
        <span className="dr-sr-only">Search this board</span>
        <input
          ref={inputRef}
          type="search"
          className="dr-input dr-input--block"
          data-testid="search-input"
          placeholder="Search notes, text, frames, files, #tags…"
          value={query}
          aria-controls={resultsId}
          aria-describedby={statusId}
          onChange={(e) => set({ query: e.target.value, activeId: null })}
        />
      </label>
      <fieldset className="dr-cux-chips">
        <legend className="dr-sr-only">Filter results by type</legend>
        {SEARCH_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className="dr-cux-chip"
            data-testid="search-filter"
            data-filter={f.id}
            aria-pressed={filter === f.id}
            onClick={() => set({ filter: f.id as SearchFilter, activeId: null })}
          >
            {f.label}
          </button>
        ))}
      </fieldset>
      <SearchTagFilter canvas={canvas} onChange={() => set({ activeId: null })} />
      <p id={statusId} className="dr-cux-muted" role="status" data-testid="search-status">
        {!trimmed && !tag
          ? 'Type to search. Enter goes to the next match.'
          : hits.length === 0
            ? 'No matches.'
            : `${hits.length}${hits.length === RESULT_LIMIT ? '+' : ''} ${hits.length === 1 ? 'match' : 'matches'}${
                activeIndex >= 0 ? ` · ${activeIndex + 1} of ${hits.length}` : ''
              }`}
      </p>
      <ul id={resultsId} ref={listRef} className="dr-cux-results" aria-label="Search results">
        {hits.map((hit, index) => (
          <li key={hit.id}>
            <button
              type="button"
              className="dr-cux-result"
              data-testid="search-result"
              data-shape-id={hit.id}
              aria-current={hit.id === activeId ? 'true' : undefined}
              onClick={() => activate(index)}
            >
              <span className="dr-cux-result__type">{typeLabel(hit.type)}</span>
              <span className="dr-cux-result__snippet">
                {highlightParts(hit.snippet, marked).map((p, i) =>
                  p.match ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The search's canvas dim (MAK-12): everything but the matches, while the search panel is open. */
export function SearchHighlights({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const maskId = useId().replace(/:/g, '')
  const open = ctx.activePanel === 'search'
  const view = useValue('nav-search-boxes', () => {
    const ids = searchMatches(canvas).get()
    if (!ids.length) return null
    const v = canvas.viewport.get()
    const w = v.width * v.zoom
    const h = v.height * v.zoom
    const active = searchState(canvas).get().activeId
    const boxes: { id: string; x: number; y: number; w: number; h: number; active: boolean }[] = []
    for (const id of ids) {
      const b = canvas.bounds(id)
      if (!b) continue
      const tl = canvas.sceneToOverlay({ x: b.x, y: b.y })
      boxes.push({
        id,
        x: tl.x - 6,
        y: tl.y - 6,
        w: b.width * v.zoom + 12,
        h: b.height * v.zoom + 12,
        active: id === active,
      })
    }
    return { w, h, boxes }
  }, [canvas])
  if (!open || !view) return null
  return (
    <svg
      className="dr-cux-search-dim"
      width={view.w}
      height={view.h}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      data-testid="search-highlights"
      data-match-count={view.boxes.length}
      aria-hidden="true"
    >
      <defs>
        <mask id={maskId}>
          <rect width={view.w} height={view.h} fill="white" />
          {view.boxes.map((b) => (
            <rect key={b.id} x={b.x} y={b.y} width={b.w} height={b.h} rx="8" fill="black" />
          ))}
        </mask>
      </defs>
      <rect width={view.w} height={view.h} className="dr-cux-search-dim__veil" mask={`url(#${maskId})`} />
      {view.boxes.map((b) => (
        <rect
          key={b.id}
          x={b.x}
          y={b.y}
          width={b.w}
          height={b.h}
          rx="8"
          className={
            b.active ? 'dr-cux-search-dim__ring dr-cux-search-dim__ring--active' : 'dr-cux-search-dim__ring'
          }
          data-shape-id={b.id}
        />
      ))}
    </svg>
  )
}
