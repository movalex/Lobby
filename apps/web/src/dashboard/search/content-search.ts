// Dashboard search inside boards (docs/WAVE4-CONTRACTS.md "search"; checklist DSH-08): pure helpers
// for the "Inside boards" results (ContentSearch.tsx). No React, no tldraw (the dashboard bundle must
// not pull the canvas in just to build a link).

import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import {
  FILE_HIT_QUERY,
  parseFileHitObjectId,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_MIN_TERM_CHARS,
  type SearchHit,
  type SearchHitKind,
  SearchResponse,
  type SearchStatus,
} from '@draftroom/contracts'
import type { ApiClient } from '../../api/client.ts'
import { NEW_CANVAS_BOARD_PAGE } from '../../lib/board-engine.ts'
import { elementsLink, legacyShapesLink } from '../../lib/deep-link.ts'
import { boardPath, type DashboardSection } from '../../lib/routing.ts'

/** Typing pauses this long before a search goes out. */
export const SEARCH_DEBOUNCE_MS = 250
/** Boards shown before "Show more boards". */
export const VISIBLE_BOARDS = 5
/** When some boards were still being indexed, the same search runs once more after this. */
export const PENDING_RETRY_MS = 3_000

export { SEARCH_MAX_QUERY_CHARS }

export interface SearchScope {
  status: SearchStatus
  projectId: string | null
}

/**
 * What the content search covers for the dashboard list on screen: the same boards the list shows
 * (active ones, one project's, or archived ones). Trash has none: a trashed board cannot be opened.
 */
export function scopeForSection(section: DashboardSection): SearchScope | null {
  switch (section.kind) {
    case 'recent':
    case 'all':
      return { status: 'active', projectId: null }
    case 'project':
      return { status: 'active', projectId: section.projectId }
    case 'archived':
      return { status: 'archived', projectId: null }
    case 'trash':
      return null
  }
}

/** Whether a query is worth sending: at least one word of two or more letters or digits. */
export function isSearchable(query: string): boolean {
  const q = query.trim()
  if (!q || [...q].length > SEARCH_MAX_QUERY_CHARS) return false
  for (const m of q.matchAll(/[\p{L}\p{N}]+/gu)) if ([...m[0]].length >= SEARCH_MIN_TERM_CHARS) return true
  return false
}

/** Whether the dashboard shows "Inside boards" results for this list and query. */
export const contentSearchApplies = (section: DashboardSection, query: string): boolean =>
  scopeForSection(section) !== null && isSearchable(query)

const KIND_LABELS: Record<SearchHitKind, string> = {
  note: 'Note',
  text: 'Text',
  shape: 'Shape',
  arrow: 'Connector',
  frame: 'Frame',
  file: 'File',
  image: 'Image',
  video: 'Video',
  other: 'Object',
  comment: 'Comment',
  'resolved-comment': 'Resolved comment',
}

/** Short label of what a hit is (the in-board search uses the same words). */
export const kindLabel = (kind: SearchHitKind): string => KIND_LABELS[kind]

/**
 * A tldraw deep-link string to shapes (`s<id>.<id>`), as Editor.createDeepLink builds it: the id
 * without its `shape:` prefix, URI-encoded, with dots encoded too (they separate ids).
 */
export const shapesDeepLink = (shapeIds: readonly string[]): string => legacyShapesLink(shapeIds)

/**
 * Which link the board page of this build reads: `el` on the new canvas (docs/EXCALIDRAW-MIGRATION.md
 * §3.6: `?el=<id>`, whose board page also reads the legacy `?d=`), `d` on the tldraw board page.
 */
export type HitLinkFormat = 'd' | 'el'
export const HIT_LINK_FORMAT: HitLinkFormat = NEW_CANVAS_BOARD_PAGE ? 'el' : 'd'

/**
 * Where a hit opens: the board zoomed to the object and with it selected (`?d=`, or `?el=` on the new
 * canvas, handled by the board's start view), or with the comment thread open (`?thread=`, handled by
 * comments).
 */
export function hitHref(
  boardId: string,
  hit: Pick<SearchHit, 'kind' | 'objectId'> & Partial<Pick<SearchHit, 'file'>>,
  format: HitLinkFormat = HIT_LINK_FORMAT,
): string {
  const base = boardPath(boardId)
  // wave W (WS3): a page of a file's text opens the file at that page (file-card/ported/open-file-hit.ts)
  const file = fileOfHit(hit)
  if (file) return fileHitHref(boardId, file.versionId, file.page)
  if (hit.kind === 'comment' || hit.kind === 'resolved-comment')
    return `${base}?${new URLSearchParams({ thread: hit.objectId })}`
  if (hit.objectId.startsWith('shape:')) {
    if (format === 'el') {
      const id = fromShapeRef(hit.objectId)
      return id ? elementsLink(base, [id]) : base
    }
    return `${base}?${new URLSearchParams({ d: shapesDeepLink([hit.objectId]) })}`
  }
  return base
}

// ---- wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): hits inside files -------------------------------------------------

/**
 * The file and page of a hit in a file's extracted text: its `file` field (the server's), checked against its object id
 * (`file:<ver>.p<page>`, contracts parseFileHitObjectId), or null for every other hit (and for a malformed one).
 */
export function fileOfHit(
  hit: Pick<SearchHit, 'kind' | 'objectId'> & Partial<Pick<SearchHit, 'file'>>,
): { versionId: string; page: number; name: string } | null {
  if (hit.kind !== 'file' || !hit.file) return null
  const ref = parseFileHitObjectId(hit.objectId)
  if (!ref || ref.versionId !== hit.file.versionId || ref.page !== hit.file.page) return null
  return { versionId: ref.versionId, page: ref.page, name: hit.file.name }
}

/** `/b/<id>?file=<ver>&page=<n>` (FILE_HIT_QUERY): the board opens the file's pages at that page. */
export function fileHitHref(boardId: string, versionId: string, page: number): string {
  return `${boardPath(boardId)}?${new URLSearchParams({
    [FILE_HIT_QUERY.file]: versionId,
    [FILE_HIT_QUERY.page]: String(page),
  })}`
}

/** "Page 3 · Brief.pdf": where in which file a hit is (a name the server sent, shown as text). */
export function fileHitLabel(file: { page: number; name: string }): string {
  const name = file.name.replace(/\s+/g, ' ').trim() || 'File'
  return `Page ${file.page} · ${name}`
}

/** "7 matches in 3 boards" (with "400+" when the server stopped counting). */
export function summary(r: Pick<SearchResponse, 'totalHits' | 'totalBoards' | 'capped'>): string {
  if (r.totalHits === 0) return 'No matches inside boards.'
  const hits = `${r.totalHits}${r.capped ? '+' : ''} ${r.totalHits === 1 && !r.capped ? 'match' : 'matches'}`
  const boards = `${r.totalBoards}${r.capped ? '+' : ''} ${r.totalBoards === 1 && !r.capped ? 'board' : 'boards'}`
  return `${hits} in ${boards}`
}

export function pendingNote(pendingBoards: number): string | null {
  if (pendingBoards <= 0) return null
  return pendingBoards === 1
    ? '1 board is still being indexed, so its newest text may be missing.'
    : `${pendingBoards} boards are still being indexed, so their newest text may be missing.`
}

/** Identifies one search (workspace, list, query): a new key is a new search. */
export function searchKey(workspaceId: string, scope: SearchScope, query: string): string {
  return `${workspaceId}|${scope.status}|${scope.projectId ?? ''}|${query.trim().toLowerCase()}`
}

export function searchApi(api: ApiClient) {
  return {
    search: (workspaceId: string, scope: SearchScope, q: string, signal?: AbortSignal) => {
      const params = new URLSearchParams({ q: q.trim() })
      if (scope.status !== 'active') params.set('status', scope.status)
      if (scope.projectId) params.set('projectId', scope.projectId)
      return api.request('GET', `/api/workspaces/${encodeURIComponent(workspaceId)}/search?${params}`, {
        schema: SearchResponse,
        signal,
      })
    },
  }
}
