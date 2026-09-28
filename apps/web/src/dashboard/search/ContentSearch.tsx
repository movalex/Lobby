// Dashboard: "Inside boards" (docs/WAVE4-CONTRACTS.md "search"; checklist DSH-08). While the dashboard's
// search box filters the cards by title, this section searches the text inside the boards of the same
// list: notes, text, shape and connector labels, frame and file names, alt text and comment threads.
// A result names the board and the object with a snippet; opening it lands on the board zoomed to the
// object (or with the comment thread open).
//
// The server decides what anyone may find (permissions are checked on every search); this component
// only renders its answer. Snippet text is rendered as React text, never as HTML.
//
// Keyboard: ArrowDown in the search box jumps into the results; ArrowUp/ArrowDown/Home/End move
// through them; Escape goes back to the search box.

import type {
  SearchBoardGroup,
  SearchHit,
  SearchHitKind,
  SearchResponse,
  SnippetPart,
} from '@draftroom/contracts'
import { type RefObject, useEffect, useId, useRef, useState } from 'react'
import { api, isApiError } from '../../api/client.ts'
import { boardPath, type DashboardSection, linkClick } from '../../lib/routing.ts'
import {
  hitHref,
  isSearchable,
  kindLabel,
  PENDING_RETRY_MS,
  pendingNote,
  SEARCH_DEBOUNCE_MS,
  scopeForSection,
  searchApi,
  searchKey,
  summary,
  VISIBLE_BOARDS,
} from './content-search.ts'
import './content-search.css'

const searcher = searchApi(api)

type View =
  | { phase: 'idle' }
  | { phase: 'loading'; key: string; shown: SearchResponse | null }
  | { phase: 'ready'; key: string; shown: SearchResponse }
  | { phase: 'error'; key: string; message: string; shown: SearchResponse | null }

interface Props {
  workspaceId: string
  /** The dashboard search box's text. */
  query: string
  section: DashboardSection
  /** The dashboard's search box: ArrowDown moves from it into the results, Escape comes back. */
  inputRef: RefObject<HTMLInputElement | null>
  /** A project's name for the result headers (null: none). */
  projectName?: (projectId: string | null) => string | null
}

export function ContentSearch({ workspaceId, query, section, inputRef, projectName }: Props) {
  const scope = scopeForSection(section)
  const status = scope?.status ?? null
  const projectId = scope?.projectId ?? null
  const q = status && isSearchable(query) ? query.trim() : ''
  const key = status && q ? searchKey(workspaceId, { status, projectId }, q) : null
  const [view, setView] = useState<View>({ phase: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const [expandedFor, setExpandedFor] = useState<string | null>(null)
  const retriedFor = useRef<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const headingId = useId()

  // No client cache: every answer is the server's current one (a board shared or trashed a moment
  // ago, an edit on its way). While the next answer is on its way the previous one stays, dimmed,
  // so typing does not flicker.
  useEffect(() => {
    void attempt // "Try again" and the pending re-check run the same search once more
    if (!key || !status) {
      setView({ phase: 'idle' })
      return
    }
    setView((v) => ({ phase: 'loading', key, shown: v.phase === 'idle' ? null : v.shown }))
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searcher.search(workspaceId, { status, projectId }, q, controller.signal).then(
        (data) => {
          if (controller.signal.aborted) return
          setView({ phase: 'ready', key, shown: data })
        },
        (e: unknown) => {
          if (controller.signal.aborted) return
          const message = isApiError(e)
            ? e.message
            : 'Search inside boards is not available right now. Try again in a moment.'
          setView((v) => ({ phase: 'error', key, message, shown: v.phase === 'idle' ? null : v.shown }))
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, status, projectId, q, workspaceId, attempt])

  // Boards that were still being indexed: look once more a moment later.
  useEffect(() => {
    if (view.phase !== 'ready' || view.shown.pendingBoards === 0 || retriedFor.current === view.key) return
    retriedFor.current = view.key
    const t = setTimeout(() => setAttempt((a) => a + 1), PENDING_RETRY_MS)
    return () => clearTimeout(t)
  }, [view])

  // ArrowDown in the search box: into the results.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'ArrowDown' || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const first = listRef.current?.querySelector<HTMLElement>('[data-nav]')
      if (!first) return
      e.preventDefault()
      first.focus()
    }
    input.addEventListener('keydown', onKey)
    return () => input.removeEventListener('keydown', onKey)
  }, [inputRef])

  // Arrow keys, Home/End and Escape inside the results (the list exists while there is a query).
  const hasKey = key !== null
  useEffect(() => {
    const list = hasKey ? listRef.current : null
    if (!list) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const items = [...list.querySelectorAll<HTMLElement>('[data-nav]')]
      const at = items.indexOf(document.activeElement as HTMLElement)
      let next: HTMLElement | undefined
      if (e.key === 'ArrowDown') next = items[Math.min(items.length - 1, at + 1)]
      else if (e.key === 'ArrowUp') next = at <= 0 ? (inputRef.current ?? undefined) : items[at - 1]
      else if (e.key === 'Home') next = items[0]
      else if (e.key === 'End') next = items.at(-1)
      else if (e.key === 'Escape') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        return
      } else return
      e.preventDefault()
      next?.focus()
    }
    list.addEventListener('keydown', onKey)
    return () => list.removeEventListener('keydown', onKey)
  }, [hasKey, inputRef])

  if (!key) return null

  const shown = view.phase === 'idle' ? null : view.shown
  // Right after the query changes (before the effect above has run) the view still belongs to the
  // previous query: it is "loading" until this query's answer arrives.
  const phase = view.phase === 'idle' || view.key !== key ? 'loading' : view.phase
  const loading = phase === 'loading'
  const groups = shown?.groups ?? []
  const expanded = expandedFor === key
  const visible = expanded ? groups : groups.slice(0, VISIBLE_BOARDS)
  const hidden = groups.length - visible.length
  const pending = phase === 'ready' && shown ? pendingNote(shown.pendingBoards) : null
  const statusText =
    phase === 'error' && view.phase === 'error'
      ? view.message
      : phase === 'ready' && shown
        ? summary(shown)
        : 'Searching inside boards…'

  return (
    <section
      className="dr-csearch"
      aria-labelledby={headingId}
      aria-busy={loading}
      data-testid="content-search"
      data-state={phase}
      data-query={q}
    >
      <div className="dr-csearch__head">
        <h2 id={headingId} className="dr-dash__group-title dr-csearch__title">
          Inside boards
        </h2>
        <p className="dr-csearch__status" role="status" data-testid="content-search-status">
          {statusText}
        </p>
        {phase === 'error' && (
          <button
            type="button"
            className="dr-btn dr-csearch__retry"
            data-testid="content-search-retry"
            onClick={() => setAttempt((a) => a + 1)}
          >
            Try again
          </button>
        )}
      </div>
      {pending && (
        <p className="dr-csearch__note" data-testid="content-search-pending">
          {pending}
        </p>
      )}
      <div ref={listRef} className="dr-csearch__results">
        {groups.length > 0 && (
          <ul className="dr-csearch__groups" aria-label="Matches inside boards">
            {visible.map((g) => (
              <GroupItem key={g.board.id} group={g} projectName={projectName?.(g.board.projectId) ?? null} />
            ))}
          </ul>
        )}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          className="dr-btn dr-btn--ghost dr-csearch__more-boards"
          data-testid="content-search-more-boards"
          onClick={() => setExpandedFor(key)}
        >
          Show {hidden} more {hidden === 1 ? 'board' : 'boards'}
        </button>
      )}
      {shown && expanded && shown.totalBoards > groups.length && (
        <p className="dr-csearch__rest">
          Showing the {groups.length} best-matching boards. Add a word to narrow the search.
        </p>
      )}
    </section>
  )
}

function GroupItem({ group, projectName }: { group: SearchBoardGroup; projectName: string | null }) {
  const { board, hits, more, truncated } = group
  const href = boardPath(board.id)
  const count = hits.length + more
  return (
    <li className="dr-csearch__group" data-testid="content-search-board" data-board-id={board.id}>
      <div className="dr-csearch__board">
        <a
          className="dr-csearch__board-link"
          href={href}
          onClick={linkClick(href)}
          data-nav=""
          data-testid="content-search-board-link"
        >
          <BoardGlyph />
          <span className="dr-csearch__board-title">{board.title}</span>
        </a>
        <span className="dr-csearch__board-meta">
          {projectName && <span>{projectName}</span>}
          {board.status === 'archived' && <span className="dr-role">Archived</span>}
          <span>
            {count} {count === 1 ? 'match' : 'matches'}
          </span>
        </span>
      </div>
      <ul className="dr-csearch__hits" aria-label={`Matches in ${board.title}`}>
        {hits.map((h) => (
          <HitItem key={`${h.kind}:${h.objectId}`} boardId={board.id} boardTitle={board.title} hit={h} />
        ))}
      </ul>
      {more > 0 && (
        <p className="dr-csearch__rest">
          {more} more {more === 1 ? 'match' : 'matches'} in this board. Open it and press Ctrl+F to see them
          all.
        </p>
      )}
      {truncated && (
        <p className="dr-csearch__rest" data-testid="content-search-truncated">
          This board holds more text than search keeps, so only part of it was searched.
        </p>
      )}
    </li>
  )
}

/** Snippet parts keyed by their offset in the snippet (stable for a given answer). */
function snippetNodes(parts: readonly SnippetPart[]) {
  let offset = 0
  return parts.map((p) => {
    const key = `${offset}:${p.hit ? 'm' : 't'}`
    offset += p.text.length
    return p.hit ? <mark key={key}>{p.text}</mark> : <span key={key}>{p.text}</span>
  })
}

function HitItem({ boardId, boardTitle, hit }: { boardId: string; boardTitle: string; hit: SearchHit }) {
  const href = hitHref(boardId, hit)
  return (
    <li>
      <a
        className="dr-csearch__hit"
        href={href}
        onClick={linkClick(href)}
        data-nav=""
        data-testid="content-search-hit"
        data-kind={hit.kind}
        data-object-id={hit.objectId}
      >
        <span className="dr-csearch__kind" data-kind={hit.kind}>
          <KindIcon kind={hit.kind} />
          {kindLabel(hit.kind)}
        </span>
        <span className="dr-csearch__snippet">
          {hit.cutStart && '…'}
          {snippetNodes(hit.snippet)}
          {hit.cutEnd && '…'}
        </span>
        <span className="dr-sr-only">, in {boardTitle}</span>
      </a>
    </li>
  )
}

function BoardGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" className="dr-csearch__glyph">
      <rect
        x="2.5"
        y="3.5"
        width="15"
        height="13"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect x="5.5" y="6.5" width="4" height="4" rx="0.8" fill="var(--dr-amber)" />
      <path
        d="M11.5 8h3.5M11.5 11h2.5M5.5 13.5h9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

const ICON_PATHS: Record<SearchHitKind, string> = {
  note: 'M3 3h10v6.5L9.5 13H3zM9.5 13V9.5H13',
  text: 'M3.5 4h9M8 4v9M6 13h4',
  shape: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5z',
  arrow: 'M3 13L13 3M7.5 3H13v5.5',
  frame: 'M5 2.5v11M11 2.5v11M2.5 5h11M2.5 11h11',
  file: 'M4 2.5h5l3 3v8H4zM9 2.5v3h3',
  image: 'M2.5 3.5h11v9h-11zM2.5 10.5l3-3 3 3 2-2 3 3',
  video: 'M2.5 3.5h11v9h-11zM7 6v4l3.5-2z',
  other: 'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3z',
  comment: 'M2.5 3.5h11v7.5H7L4 13.5V11H2.5z',
  'resolved-comment': 'M2.5 3.5h11v7.5H7L4 13.5V11H2.5zM5.5 7.3l1.7 1.7 3.3-3.3',
}

function KindIcon({ kind }: { kind: SearchHitKind }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d={ICON_PATHS[kind]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
