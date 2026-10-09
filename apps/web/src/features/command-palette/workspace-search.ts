// OWNER: W3 (wave L, L3-2). The palette's workspace search, on the board and on the dashboard: GET
// /api/workspaces/:wid/search (the server filters every search by what this person may open: a name-only
// guest finds only their own links' boards). On a board, that board's hits are left to its "On this board"
// group. A hit opens its board at the object (lib/deep-link.ts elementsLink, `?el=<id>`), which the board's
// first view selects and brings into view. No canvas here (the dashboard's palette chunk imports it).
import type { SearchBoardGroup, SearchHit, SnippetPart } from '@draftroom/contracts'
import { type ApiClient, isApiError } from '../../api/client.ts'
import { hitHref, isSearchable, kindLabel, searchApi } from '../../dashboard/search/content-search.ts'
import { navigate } from '../../lib/routing.ts'
import type { PaletteEntry, PaletteSearch } from './model.ts'

export const WORKSPACE_HITS_MAX = 8

/** A snippet's words as one line of text (the marks are the server's; the palette shows plain text). */
export const snippetText = (parts: readonly SnippetPart[], cutStart = false, cutEnd = false): string =>
  `${cutStart ? '…' : ''}${parts.map((p) => p.text).join('')}${cutEnd ? '…' : ''}`.replace(/\s+/g, ' ').trim()

/** The workspace search's hits as palette lines, the board `boardId` left out, best boards first. */
export function workspaceEntries(
  groups: readonly SearchBoardGroup[],
  boardId: string | null,
  open: (href: string) => void = (href) => navigate(href),
): PaletteEntry[] {
  const out: PaletteEntry[] = []
  for (const g of groups) {
    if (g.board.id === boardId) continue
    for (const hit of g.hits as readonly SearchHit[]) {
      const href = hitHref(g.board.id, hit)
      out.push({
        id: `ws:${g.board.id}:${hit.objectId}`,
        label: snippetText(hit.snippet, hit.cutStart, hit.cutEnd) || kindLabel(hit.kind),
        group: 'In this workspace',
        detail: `${kindLabel(hit.kind)} · ${g.board.title}`,
        run: () => open(href),
      })
      if (out.length >= WORKSPACE_HITS_MAX) return out
    }
  }
  return out
}

/** "In this workspace": the server's permission-filtered search of the workspace's (other) boards. */
export function workspaceSearch(
  api: ApiClient,
  workspaceId: string,
  boardId: string | null,
  open?: (href: string) => void,
): PaletteSearch {
  const searcher = searchApi(api)
  return {
    id: 'workspace',
    title: 'In this workspace',
    limit: WORKSPACE_HITS_MAX,
    find: async (query, signal) => {
      if (!isSearchable(query)) return []
      try {
        const r = await searcher.search(workspaceId, { status: 'active', projectId: null }, query, signal)
        return workspaceEntries(r.groups, boardId, open)
      } catch (e) {
        // not a member of the workspace (an outside account on one board): nothing to search, not an error
        if (isApiError(e) && (e.status === 403 || e.status === 404)) return []
        throw e
      }
    },
  }
}
