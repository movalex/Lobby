// MAK-12 board search (dock panel `search`, Ctrl/Cmd+F): board-ops `searchBoard` over the current page
// (notes, text, shapes, connector labels, frame names, file names, image alt text and the file names
// images and videos were uploaded with (F15: the page's asset records go in too); case- and
// accent-insensitive; every word must match). Results show snippets with the matches marked; a type
// filter narrows them. Enter / click zooms to a result and selects it (Enter again = next, Shift+Enter
// = previous, ↑/↓ move through the list). While the panel is open the canvas dims everything except
// the matches (SearchHighlights). Esc closes the panel and returns focus to the board.

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { type Editor, type TLShapeId, useValue } from 'tldraw'
import { SearchTagFilter, searchWithTags, textOfQuery, useSearchTag } from '../tags/SearchTagFilter.tsx'
import type { FeatureContext } from '../types.ts'
import { searchMatches, searchState } from './bridge.ts'
import type { SearchHit } from './deps.ts'
import {
  highlightParts,
  matchesFilter,
  SEARCH_FILTERS,
  type SearchFilter,
  stepIndex,
  typeLabel,
} from './search-filter.ts'

const RESULT_LIMIT = 200

function goToShape(editor: Editor, id: string) {
  const shapeId = id as TLShapeId
  const shape = editor.getShape(shapeId)
  if (!shape) return
  const pageId = editor.getAncestorPageId(shape)
  if (pageId && pageId !== editor.getCurrentPageId()) editor.setCurrentPage(pageId)
  const bounds = editor.getShapePageBounds(shapeId)
  if (!bounds) return
  editor.select(shapeId)
  // Fit the shape, but never zoom in past 100% just to show one note.
  editor.zoomToBounds(bounds, { targetZoom: 1, animation: { duration: 260 }, inset: 120 })
}

/** Re-runs the search at most every 250 ms while the document changes (drags, remote edits). */
function useDocumentVersion(editor: Editor): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const stop = editor.store.listen(
      () => {
        if (t) return
        t = setTimeout(() => {
          t = null
          setVersion((v) => v + 1)
        }, 250)
      },
      { scope: 'document' },
    )
    return () => {
      stop()
      if (t) clearTimeout(t)
    }
  }, [editor])
  return version
}

export function SearchPanel({ ctx, close }: { ctx: FeatureContext; close(): void }) {
  const editor = ctx.editor
  const state = searchState(editor)
  const { query, filter, activeId, focusTick } = useValue('dr-search-state', () => state.get(), [state])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const version = useDocumentVersion(editor)

  const set = (patch: Partial<ReturnType<typeof state.get>>) => state.set({ ...state.get(), ...patch })

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusTick])

  // Wave 4 tags: words also match tag names, `#word` matches tags only, and the tag filter below the
  // type chips narrows to one tag (tags/search.ts).
  const tag = useSearchTag(editor)
  const hits: SearchHit[] = useMemo(() => {
    void version
    if (!query.trim() && !tag) return []
    const records = [editor.getCurrentPage(), ...editor.getCurrentPageShapes(), ...editor.getAssets()]
    return searchWithTags(editor, records, query, { limit: RESULT_LIMIT, tag }).filter((h) =>
      matchesFilter(h.type, filter),
    )
  }, [editor, query, filter, version, tag])

  useEffect(() => {
    searchMatches(editor).set(hits.map((h) => h.shapeId))
  }, [editor, hits])
  useEffect(
    () => () => {
      searchMatches(editor).set([])
    },
    [editor],
  )

  const activeIndex = hits.findIndex((h) => h.shapeId === activeId)

  const activate = (index: number) => {
    const hit = hits[index]
    if (!hit) return
    set({ activeId: hit.shapeId })
    goToShape(editor, hit.shapeId)
    listRef.current
      ?.querySelector(`[data-shape-id="${CSS.escape(hit.shapeId)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      editor.focus()
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
          aria-controls="dr-search-results"
          aria-describedby="dr-search-status"
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
      <SearchTagFilter editor={editor} onChange={() => set({ activeId: null })} />
      <p id="dr-search-status" className="dr-cux-muted" role="status" data-testid="search-status">
        {!trimmed && !tag
          ? 'Type to search. Enter goes to the next match.'
          : hits.length === 0
            ? 'No matches.'
            : `${hits.length}${hits.length === RESULT_LIMIT ? '+' : ''} ${hits.length === 1 ? 'match' : 'matches'}${
                activeIndex >= 0 ? ` · ${activeIndex + 1} of ${hits.length}` : ''
              }`}
      </p>
      <ul id="dr-search-results" ref={listRef} className="dr-cux-results" aria-label="Search results">
        {hits.map((hit, index) => (
          <li key={hit.shapeId}>
            <button
              type="button"
              className="dr-cux-result"
              data-testid="search-result"
              data-shape-id={hit.shapeId}
              aria-current={hit.shapeId === activeId ? 'true' : undefined}
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
