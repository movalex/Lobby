// API schemas for search across boards (docs/WAVE4-CONTRACTS.md "search"). Browser-safe. Owned by the
// search owner.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.
//
// Route (apps/api/src/features/search):
//   GET /api/workspaces/:wid/search?q=&status=&projectId=&limit=  → SearchResponse
//     404 unless the caller is a member of the workspace (guests included). Results are filtered by
//     permission at query time: only boards the caller can open right now (a guest: the boards of
//     their grants; a viewer: boards they can view). Trashed boards are never searched.
//
// What is searched: the text of notes, text shapes, shape labels, arrow labels, frame names, file
// names (file cards, image and video names) and alt text, and comment threads (live comments only).
// A hit names its board, the object and a snippet whose matching words are marked.

import { z } from 'zod'

/** Longer queries are refused (400 QUERY_TOO_LONG). The web input caps itself at this length. */
export const SEARCH_MAX_QUERY_CHARS = 200
/** Words after the first eight are ignored. */
export const SEARCH_MAX_TERMS = 8
/** Words shorter than this are ignored (one letter would match nearly everything). */
export const SEARCH_MIN_TERM_CHARS = 2
/** Board groups per response (default and maximum). */
export const SEARCH_DEFAULT_LIMIT = 20
export const SEARCH_MAX_LIMIT = 50
/** Hits returned per board; `more` counts the rest. */
export const SEARCH_HITS_PER_BOARD = 5
/**
 * Indexed text per board: canvas text up to 768 KiB and comment text up to 256 KiB, 1 MiB together
 * (UTF-8). Beyond that the board is searched in part, and its group says `truncated`.
 */
export const SEARCH_CANVAS_TEXT_BYTES = 768 * 1024
export const SEARCH_COMMENT_TEXT_BYTES = 256 * 1024
/** Searches per signed-in user in a sliding window (429 with Retry-After beyond it). */
export const SEARCH_RATE_LIMIT = { max: 40, timeWindow: 20_000 }

export const SearchStatus = z.enum(['active', 'archived'])
export type SearchStatus = z.infer<typeof SearchStatus>

export const SearchQuery = z.object({
  q: z.string(),
  /** Which list to search: active boards (default) or archived ones. */
  status: SearchStatus.optional(),
  projectId: z
    .string()
    .regex(/^prj_[0-9A-Za-z]{10,40}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
})
export type SearchQuery = z.infer<typeof SearchQuery>

/**
 * What a hit is. Shapes use their tldraw type ('shape' is a geo shape's label, 'file' a file card);
 * 'comment' is an open comment thread, 'resolved-comment' a resolved one.
 */
export const SEARCH_HIT_KINDS = [
  'note',
  'text',
  'shape',
  'arrow',
  'frame',
  'file',
  'image',
  'video',
  'other',
  'comment',
  'resolved-comment',
] as const
export const SearchHitKind = z.enum(SEARCH_HIT_KINDS)
export type SearchHitKind = z.infer<typeof SearchHitKind>

/** A piece of a snippet; `hit` marks a matching word. Render as text (never as HTML). */
export const SnippetPart = z.object({ text: z.string(), hit: z.boolean() })
export type SnippetPart = z.infer<typeof SnippetPart>

export const SearchHit = z.object({
  kind: SearchHitKind,
  /**
   * The object to open: a shape id (`shape:…`) for canvas hits, a thread id (`thr_…`) for comments.
   * Opening the board with it zooms to the object (web: `?d=` deep link, or `?thread=`).
   */
  objectId: z.string(),
  /** The canvas page of a shape hit (null for comments). */
  pageId: z.string().nullable(),
  /** Whether the snippet starts / ends inside the text (show an ellipsis). */
  cutStart: z.boolean(),
  cutEnd: z.boolean(),
  snippet: z.array(SnippetPart),
  /**
   * Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): a hit in a file's extracted text. `kind` stays 'file' (no enum value
   * is added, so LOBBY_CLIENT_REV stays 3), `objectId` is `file:<ver>.p<page>` (formats.ts fileHitObjectId), and this
   * names the version, the page and the file's display name. Optional: an older api sends none, an older web strips
   * it and opens the board. Only versions served on the hit's board AND placed on its canvas, checked at query time.
   */
  file: z
    .object({
      versionId: z.string().regex(/^ver_[0-9A-Za-z]{10,40}$/),
      page: z.number().int().min(1),
      name: z.string(),
    })
    .optional(),
})
export type SearchHit = z.infer<typeof SearchHit>

export const SearchBoardGroup = z.object({
  board: z.object({
    id: z.string(),
    title: z.string(),
    projectId: z.string().nullable(),
    status: SearchStatus,
  }),
  hits: z.array(SearchHit),
  /** Further hits in this board that were not returned. */
  more: z.number().int().min(0),
  /** The board has more text than the index keeps (see SEARCH_CANVAS_TEXT_BYTES): searched in part. */
  truncated: z.boolean(),
})
export type SearchBoardGroup = z.infer<typeof SearchBoardGroup>

export const SearchResponse = z.object({
  /** The words that were searched for (after normalization); empty when the query had none. */
  terms: z.array(z.string()),
  groups: z.array(SearchBoardGroup),
  /** Matching boards in total (groups beyond `limit` are not returned). */
  totalBoards: z.number().int().min(0),
  /**
   * Matches in all matching boards. `capped` would say the count stopped at a server ceiling; the
   * server currently counts every match (each board ranked on its own), so it is false.
   */
  totalHits: z.number().int().min(0),
  capped: z.boolean(),
  /**
   * Boards in scope whose latest changes are not in the index yet (being indexed now): results may
   * miss them for a few seconds.
   */
  pendingBoards: z.number().int().min(0),
})
export type SearchResponse = z.infer<typeof SearchResponse>
