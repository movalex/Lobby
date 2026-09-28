// Feature module: search (docs/WAVE4-CONTRACTS.md "search"): search across boards, content included.
//
// GET /api/workspaces/:wid/search?q= answers with the boards of that workspace whose text matches,
// each with its matching objects (notes, text, shape and arrow labels, frame and file names, alt
// text, comment threads) and a snippet. Every search is filtered by permission at query time
// (scope.ts): the index itself (0015_board_search) holds text of every board and is never read
// without that filter. Decisions:
// - anyone who is a member of the workspace may search it, guests included (a name-only guest finds
//   text only on the boards of their own guest links, which they can already read in full);
// - viewers and commenters find text on boards they can view, comment threads included (they can
//   read those threads on the board); nothing that only editors see exists in the index ("Recently
//   deleted", private brainstorm drafts, note authors and comment authors are never indexed);
// - non-members get 404 (the workspace stays invisible); trashed boards are never searched, and are
//   dropped from the index when they are trashed.
// Limits: at most SEARCH_MAX_QUERY_CHARS characters (400 otherwise), SEARCH_RATE_LIMIT per user (429),
// and the per-board text caps of the indexer. Nothing here publishes board events.

import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_HITS_PER_BOARD,
  SEARCH_MAX_QUERY_CHARS,
  SEARCH_RATE_LIMIT,
  type SearchBoardGroup,
  type SearchHit,
  SearchQuery,
  type SearchResponse,
} from '@draftroom/contracts'
import type { WorkspaceRole } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { isBoardId, requireWorkspaceRole } from '../../access.ts'
import type { Params } from '../../context.ts'
import { ApiError, parse } from '../../errors.ts'
import { keyedLimit } from '../../rate-limit.ts'
import type { FeatureContext } from '../context.ts'
import { SearchIndexer, searchSettings } from './indexer.ts'
import { parseQuery, snippetFromHeadline } from './query.ts'
import { searchScope } from './scope.ts'
import { headlines, type RankedRow, rankedHits } from './store.ts'

export { searchSettings } from './indexer.ts'

export const SEARCH_ROUTE = '/api/workspaces/:wid/search'
const TRASH_ROUTE = '/api/boards/:bid/trash'

const indexers = new WeakMap<FastifyInstance, SearchIndexer>()
/** The app's indexer (tests drive passes and wait for refreshes through it). */
export function searchIndexerOf(app: FastifyInstance): SearchIndexer | undefined {
  return indexers.get(app)
}

export async function registerSearch(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db, now } = ctx
  const indexer = new SearchIndexer({ db, sync: ctx.sync, now, log: app.log, settings: searchSettings })
  indexers.set(app, indexer)
  indexer.start(app)
  const perUser = keyedLimit(
    SEARCH_RATE_LIMIT,
    now,
    'You’re searching faster than Lobby can keep up. Wait a moment and try again.',
  )

  app.get(SEARCH_ROUTE, async (req): Promise<SearchResponse> => {
    const user = await ctx.requireUser(req)
    perUser.take(user.id)
    const { wid = '' } = req.params as Params
    const input = parse(SearchQuery, req.query)
    const q = input.q.trim()
    if ([...q].length > SEARCH_MAX_QUERY_CHARS)
      throw new ApiError(
        400,
        'QUERY_TOO_LONG',
        `Search for at most ${SEARCH_MAX_QUERY_CHARS} characters at a time.`,
      )
    const workspaceRole = await requireWorkspaceRole(db, wid, user.id)
    return search(ctx, indexer, {
      workspaceId: wid,
      userId: user.id,
      workspaceRole,
      q,
      status: input.status ?? 'active',
      projectId: input.projectId ?? null,
      limit: input.limit ?? SEARCH_DEFAULT_LIMIT,
    })
  })

  // A trashed board leaves the index at once (the next pass would sweep it out anyway, and searches
  // never look at trashed boards). A root hook, so the M1 route stays untouched.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'POST' || reply.statusCode !== 200 || req.routeOptions.url !== TRASH_ROUTE) return
    const { bid } = req.params as Params
    if (isBoardId(bid)) await indexer.purge(bid)
  })
}

async function search(
  ctx: FeatureContext,
  indexer: SearchIndexer,
  opts: {
    workspaceId: string
    userId: string
    workspaceRole: WorkspaceRole
    q: string
    status: 'active' | 'archived'
    projectId: string | null
    limit: number
  },
): Promise<SearchResponse> {
  const parsed = parseQuery(opts.q)
  const empty: SearchResponse = {
    terms: parsed.terms,
    groups: [],
    totalBoards: 0,
    totalHits: 0,
    capped: false,
    pendingBoards: 0,
  }
  if (!parsed.simple) return empty
  const scope = await searchScope(ctx.db, opts)
  if (!scope.length) return empty
  const pendingBoards = await indexer.refreshForSearch(scope)
  const byId = new Map(scope.map((b) => [b.id, b]))
  const ranked = await rankedHits(ctx.db, {
    workspaceId: opts.workspaceId,
    boardIds: [...byId.keys()],
    query: parsed,
    boards: opts.limit,
    perBoard: SEARCH_HITS_PER_BOARD,
  })
  // Rows come board by board, best board first, each board's hits best first.
  const grouped = new Map<string, RankedRow[]>()
  for (const r of ranked) {
    if (!byId.has(r.board_id)) continue // by construction never; a second check costs nothing
    const list = grouped.get(r.board_id) ?? []
    list.push(r)
    grouped.set(r.board_id, list)
  }
  const chosen = [...grouped.entries()]
  const keys = chosen.flatMap(([boardId, hits]) =>
    hits.map((h) => ({ boardId, source: h.source, objectId: h.object_id })),
  )
  const heads = await headlines(ctx.db, parsed, keys)
  let k = 0
  const groups: SearchBoardGroup[] = []
  for (const [boardId, hits] of chosen) {
    const board = byId.get(boardId)
    if (!board) continue
    const shown: SearchHit[] = []
    for (const h of hits) {
      const head = heads.get(k++)
      if (!head) continue // re-indexed between the two queries: the object is gone
      const snippet = snippetFromHeadline(head.headline, head.body, parsed.terms)
      shown.push({
        kind: h.kind,
        objectId: h.object_id,
        pageId: h.page_id,
        cutStart: snippet.cutStart,
        cutEnd: snippet.cutEnd,
        snippet: snippet.parts,
      })
    }
    if (!shown.length) continue
    groups.push({
      board: { id: board.id, title: board.title, projectId: board.projectId, status: board.status },
      hits: shown,
      more: Math.max(0, (hits[0]?.board_hits ?? 0) - hits.length),
      truncated: !!(board.state?.canvasTruncated || board.state?.commentsTruncated),
    })
  }
  return {
    terms: parsed.terms,
    groups,
    totalBoards: ranked[0]?.total_boards ?? 0,
    totalHits: ranked[0]?.total_hits ?? 0,
    // Counts are exact: every match is ranked (per board), none is left uncounted.
    capped: false,
    pendingBoards,
  }
}
