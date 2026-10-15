// The element library (wave Q, the Elements panel's Library tab; OWNER: WS2 after the wave Q foundation for the routes,
// WS3 for the panel; docs/WAVE-Q-CONTRACTS.md §2). Saved selections, kept per workspace (the workspace library) or per
// person (the personal library), in Postgres (migration 0033_library). Frozen by the foundation.
//
//   GET    /api/workspaces/:wid/library?scope=&q=&folder=&tag=&deleted=&cursor=   → 200 ListLibraryResponse
//   GET    /api/workspaces/:wid/library/items/:id                                 → 200 LibraryItem
//   POST   /api/workspaces/:wid/library/items          CreateLibraryItemInput     → 201 LibraryItemSummary
//   PATCH  /api/workspaces/:wid/library/items/:id      PatchLibraryItemInput      → 200 LibraryItemSummary (stale → 409)
//   DELETE /api/workspaces/:wid/library/items/:id                                 → 204 (soft; restorable 30 days)
//   POST   /api/workspaces/:wid/library/items/:id/restore                         → 200 LibraryItemSummary
//   POST   /api/workspaces/:wid/library/import         ImportLibraryInput         → 200 ImportLibraryResponse
//   GET    /api/workspaces/:wid/library/folders?scope=                            → 200 ListLibraryFoldersResponse
//   POST   /api/workspaces/:wid/library/folders        CreateLibraryFolderInput   → 201 LibraryFolder
//   PATCH  /api/workspaces/:wid/library/folders/:fid   PatchLibraryFolderInput    → 200 LibraryFolder
//   DELETE /api/workspaces/:wid/library/folders/:fid                              → 204 (its items keep, folderless)
//   GET    /api/workspaces/:wid/library/marks                                     → 200 ListLibraryMarksResponse
//   PUT    /api/workspaces/:wid/library/marks          PutLibraryMarkInput        → 200 LibraryMark
//   POST   /api/boards/:bid/library/items/:id/place                               → 200 PlaceLibraryItemResponse
//   POST   /api/boards/:bid/library/items/:id/place/confirm                       → 204 (the push succeeded: links stay)
//   GET    /api/workspaces/:wid/library/items/:id/files/:ver/thumb                → the version's thumb derivative
//
// Who (all server-side; the guards first, then a fail-closed check in the route):
//  - a name-only guest: every route refused (403 GUEST_ACCOUNT_REQUIRED; guests/guard.ts, LIBRARY_GUEST_ROUTE_KEYS).
//    Guests keep the built-in icons and shapes (static, client-side).
//  - a workspace guest or a board-only collaborator (no workspace role): 403 (a stranger to the workspace: 404).
//  - a workspace member who is not a creator (an outsider): reads and inserts the workspace library except
//    `internalOnly` items; saves, imports and folders only in the personal scope (workspace scope: 403
//    CREATOR_REQUIRED, decided in the route: domain-access/guard.ts 'in-route', LIBRARY_CREATOR_IN_ROUTE_KEYS).
//  - a creator member: saves to the workspace library and edits or deletes their own items; workspace owners and
//    admins (creators) any workspace item and folder.
//  - the personal scope: only its owner ever sees or changes it.
//  - `place`: the caller reads the item and edits the board (canvasActions edit; not archived, not in the trash); item
//    and board in the same workspace, else 404. Saving from a board needs view access to it and the board's export
//    policy (export-control mayExport), and a save from an internal-only project marks the item internalOnly.
// Images: an item's image elements keep `fileId` = a version id; the api records each version in library_item_files
// (only versions the source board can show), and `place` links them into the target board (board_asset_links) in the
// same transaction, BEFORE the client pushes the elements. No element ever carries data:, blob: or a signed URL.
// Placed copies are independent: editing an item never changes a board.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { IconSetId } from './icons.ts'

// ---- ids, scope, limits -------------------------------------------------------------------------------------

export const LIBRARY_ITEM_ID_PATTERN = /^lbi_[0-9A-Za-z]{10,40}$/
export const LIBRARY_FOLDER_ID_PATTERN = /^lbf_[0-9A-Za-z]{10,40}$/
export const LibraryItemId = z.string().regex(LIBRARY_ITEM_ID_PATTERN)
export const LibraryFolderId = z.string().regex(LIBRARY_FOLDER_ID_PATTERN)

/** The board id grammar (index.ts BOARD_ID_PATTERN, repeated: this module may not import index.ts). */
const BoardIdLike = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/)
const UserIdLike = z.string().regex(/^usr_[0-9A-Za-z]{10,40}$/)
/** canvas-schema limits.ts ASSET_ID_PATTERN and VERSION_ID_PATTERN (contracts may not import canvas-schema). */
export const LIBRARY_ASSET_ID_PATTERN = /^ast_[0-9A-Za-z]{10,40}$/
export const LIBRARY_VERSION_ID_PATTERN = /^ver_[0-9A-Za-z]{10,40}$/

export const LIBRARY_SCOPES = ['workspace', 'personal'] as const
export const LibraryScope = z.enum(LIBRARY_SCOPES)
export type LibraryScope = z.infer<typeof LibraryScope>

export const LIBRARY_LIMITS = {
  /** elements per item (= canvas-schema MAX_OPS_PER_PUSH: an item is placed in one push) */
  itemElements: 500,
  /** element JSON per item, UTF-8 bytes (fits one MAX_PUSH_BYTES push with room for the envelope) */
  itemBytes: 262_144,
  /** image elements per item */
  itemImages: 20,
  tags: 10,
  tagChars: 32,
  nameChars: 80,
  folderNameChars: 60,
  /** live items of a workspace library, of one personal library */
  workspaceItems: 5_000,
  personalItems: 500,
  /** folders (flat, one level) */
  workspaceFolders: 200,
  personalFolders: 50,
  /** an `.excalidrawlib` import: the request body, and its items */
  importBytes: 5 * 1024 * 1024,
  importItems: 500,
  importWarnings: 50,
  licenceChars: 300,
  fileNameChars: 200,
  authorChars: 100,
  /** items per list page */
  pageSize: 60,
  /** the panel's Recents row */
  recents: 12,
  /** favourites per person and workspace */
  favourites: 500,
  /** a deleted item is restorable this long, then purged */
  restoreDays: 30,
  /** search text */
  queryChars: 80,
} as const

/** Per person, per minute (the api's rate limiter). */
export const LIBRARY_RATE_LIMITS = {
  save: { max: 60, windowMs: 60_000 },
  import: { max: 5, windowMs: 60_000 },
  place: { max: 120, windowMs: 60_000 },
} as const

/** The licence note an imported library item carries when its file states none. */
export const LIBRARY_DEFAULT_LICENCE = 'From an Excalidraw community library; check its licence.'

/** The refusals the panel tells apart (the generic ones keep their codes: 403 CREATOR_REQUIRED, 404 NOT_FOUND). */
export const LIBRARY_CODES = {
  /** 409: PATCH with a revision that is not the item's current one (someone changed it meanwhile) */
  staleRevision: 'LIBRARY_STALE_REVISION',
  /** 409: the library holds its limit of items or folders */
  full: 'LIBRARY_FULL',
  /** 409: a folder of that name exists in that scope */
  folderExists: 'LIBRARY_FOLDER_EXISTS',
  /** 400: an element fails the server's checks (types, schema, references, links, customData) */
  invalidElements: 'LIBRARY_INVALID_ELEMENTS',
  /** 413: over itemElements, itemBytes, itemImages or the import's caps */
  tooLarge: 'LIBRARY_TOO_LARGE',
  /** 400: an image whose version the source board cannot show, or whose facts do not match it */
  fileNotServable: 'LIBRARY_FILE_NOT_SERVABLE',
  /** 403: the source board's export policy does not let this person copy its content out */
  exportRefused: 'LIBRARY_EXPORT_REFUSED',
} as const

// ---- items --------------------------------------------------------------------------------------------------

const ItemName = z.string().trim().min(1).max(LIBRARY_LIMITS.nameChars)
const FolderName = z.string().trim().min(1).max(LIBRARY_LIMITS.folderNameChars)
/** A tag: a short lowercase word or phrase (trimmed, lowercased on input). */
export const LibraryTag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(LIBRARY_LIMITS.tagChars)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u)
const Tags = z
  .array(LibraryTag)
  .max(LIBRARY_LIMITS.tags)
  .transform((t) => [...new Set(t)])

/**
 * An item's elements as the client sends them and the api stores them: portable WireElement-shaped records with
 * item-local ids (board-ops elements/library.ts serializeLibraryItem). This schema only bounds the envelope; the api
 * checks every element with canvas-schema's checkElement and checkInvariants, as the room does.
 */
export const LibraryElements = z
  .array(z.record(z.string(), z.unknown()))
  .min(1)
  .max(LIBRARY_LIMITS.itemElements)

/**
 * Where an item came from (shown in its details). `boardId` is null for a caller who cannot view that board (any
 * more): the api answers it only to those who may still see it (stored, it is always set).
 */
export const LibraryItemSource = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('board'), boardId: BoardIdLike.nullable() }),
  z.strictObject({
    kind: z.literal('excalidrawlib'),
    fileName: z.string().min(1).max(LIBRARY_LIMITS.fileNameChars),
    licence: z.string().min(1).max(LIBRARY_LIMITS.licenceChars),
    author: z.string().min(1).max(LIBRARY_LIMITS.authorChars).nullable().optional(),
  }),
])
export type LibraryItemSource = z.infer<typeof LibraryItemSource>

/** A file version an item shows (library_item_files). */
export const LibraryFileRef = z.strictObject({
  assetId: z.string().regex(LIBRARY_ASSET_ID_PATTERN),
  versionId: z.string().regex(LIBRARY_VERSION_ID_PATTERN),
})
export type LibraryFileRef = z.infer<typeof LibraryFileRef>

/** A file's stable facts, as `customData.lobby.file` holds them (canvas-schema custom-data.ts FileValue, mirrored). */
export const LibraryFileFacts = LibraryFileRef.extend({
  kind: z.enum(['image', 'pdf', 'video', 'other']),
  name: z.string().max(255),
  mimeType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
})
export type LibraryFileFacts = z.infer<typeof LibraryFileFacts>

export const LibraryItemSummary = z.object({
  id: LibraryItemId,
  scope: LibraryScope,
  folderId: LibraryFolderId.nullable(),
  name: z.string(),
  tags: z.array(z.string()),
  elementCount: z.number().int().min(1).max(LIBRARY_LIMITS.itemElements),
  imageCount: z.number().int().min(0).max(LIBRARY_LIMITS.itemImages),
  /** the item's box (scene px) for previews and placement */
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
  /** saved from an internal-only project: only creators see it */
  internalOnly: z.boolean(),
  /** 1 on create, +1 on every change; PATCH sends the one it read */
  revision: z.number().int().min(1),
  sourceKind: z.enum(['board', 'excalidrawlib']),
  /** null once that account is gone */
  createdBy: z.object({ id: UserIdLike, name: z.string() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** set on an item in "Recently deleted" (the list's `deleted=1`) */
  deletedAt: z.string().nullable(),
  /** whether this caller may rename, retag, move, change or delete it */
  canEdit: z.boolean(),
})
export type LibraryItemSummary = z.infer<typeof LibraryItemSummary>

/** GET …/library/items/:id: the summary, its elements and the file versions they show. */
export const LibraryItem = LibraryItemSummary.extend({
  elements: LibraryElements,
  files: z.array(LibraryFileRef).max(LIBRARY_LIMITS.itemImages),
  source: LibraryItemSource,
})
export type LibraryItem = z.infer<typeof LibraryItem>

/** GET /api/workspaces/:wid/library: one page of summaries, newest change first (no elements). */
export const ListLibraryQuery = z.strictObject({
  scope: LibraryScope.default('workspace'),
  q: z.string().trim().max(LIBRARY_LIMITS.queryChars).optional(),
  /** a folder id, or 'none' for the items in no folder; absent = every folder */
  folder: z.union([LibraryFolderId, z.literal('none')]).optional(),
  tag: LibraryTag.optional(),
  /** '1': "Recently deleted" (the caller's restorable items) */
  deleted: z.literal('1').optional(),
  cursor: z.string().min(1).max(200).optional(),
})
export type ListLibraryQuery = z.infer<typeof ListLibraryQuery>

export const ListLibraryResponse = z.object({
  items: z.array(LibraryItemSummary).max(LIBRARY_LIMITS.pageSize),
  /** opaque; null on the last page */
  nextCursor: z.string().nullable(),
})
export type ListLibraryResponse = z.infer<typeof ListLibraryResponse>

/** POST …/library/items: save a selection of `sourceBoardId` (made by serializeLibraryItem on the client). */
export const CreateLibraryItemInput = z.strictObject({
  scope: LibraryScope,
  name: ItemName,
  tags: Tags.default([]),
  folderId: LibraryFolderId.nullable().default(null),
  sourceBoardId: BoardIdLike,
  elements: LibraryElements,
})
export type CreateLibraryItemInput = z.infer<typeof CreateLibraryItemInput>

/** PATCH …/library/items/:id: `revision` is the one the caller read (409 LIBRARY_STALE_REVISION otherwise). */
export const PatchLibraryItemInput = z
  .strictObject({
    revision: z.number().int().min(1),
    name: ItemName.optional(),
    tags: Tags.optional(),
    folderId: LibraryFolderId.nullable().optional(),
    /** new elements replace the item's; a board to check them against is needed then (its files, its policy) */
    elements: LibraryElements.optional(),
    sourceBoardId: BoardIdLike.optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'revision' && k !== 'sourceBoardId'), 'nothing to update')
  .refine((v) => v.elements === undefined || v.sourceBoardId !== undefined, 'elements need a sourceBoardId')
export type PatchLibraryItemInput = z.infer<typeof PatchLibraryItemInput>

/**
 * POST …/library/import: an `.excalidrawlib`, normalised by the client first (apps/web/src/canvas/library, the only
 * place that reads one with the engine's own parser). Images are dropped there; the api validates every item as a
 * save. Lobby never fetches a library from anywhere.
 */
export const ImportLibraryInput = z.strictObject({
  scope: LibraryScope,
  fileName: z.string().trim().min(1).max(LIBRARY_LIMITS.fileNameChars),
  licence: z.string().trim().min(1).max(LIBRARY_LIMITS.licenceChars).default(LIBRARY_DEFAULT_LICENCE),
  author: z.string().trim().min(1).max(LIBRARY_LIMITS.authorChars).nullable().default(null),
  folderId: LibraryFolderId.nullable().default(null),
  items: z
    .array(z.strictObject({ name: ItemName, elements: LibraryElements }))
    .min(1)
    .max(LIBRARY_LIMITS.importItems),
})
export type ImportLibraryInput = z.infer<typeof ImportLibraryInput>

export const ImportLibraryResponse = z.object({
  created: z.number().int().nonnegative(),
  /** items left out (invalid, too large, over the library's limit) */
  skipped: z.number().int().nonnegative(),
  /** what was dropped or repaired, as counts (never content) */
  warnings: z.array(z.string().max(300)).max(LIBRARY_LIMITS.importWarnings),
})
export type ImportLibraryResponse = z.infer<typeof ImportLibraryResponse>

// ---- folders ------------------------------------------------------------------------------------------------

export const LibraryFolder = z.object({
  id: LibraryFolderId,
  scope: LibraryScope,
  name: z.string(),
  position: z.number().int(),
  /** live items in it */
  itemCount: z.number().int().nonnegative(),
  canEdit: z.boolean(),
})
export type LibraryFolder = z.infer<typeof LibraryFolder>

export const ListLibraryFoldersQuery = z.strictObject({ scope: LibraryScope.default('workspace') })
export const ListLibraryFoldersResponse = z.object({ folders: z.array(LibraryFolder) })
export type ListLibraryFoldersResponse = z.infer<typeof ListLibraryFoldersResponse>

export const CreateLibraryFolderInput = z.strictObject({ scope: LibraryScope, name: FolderName })
export type CreateLibraryFolderInput = z.infer<typeof CreateLibraryFolderInput>

export const PatchLibraryFolderInput = z
  .strictObject({ name: FolderName.optional(), position: z.number().int().min(0).max(10_000).optional() })
  .refine((v) => Object.keys(v).length > 0, 'nothing to update')
export type PatchLibraryFolderInput = z.infer<typeof PatchLibraryFolderInput>

// ---- favourites and recents ("marks") -------------------------------------------------------------------------

/** A built-in piece id (packages/templates pieces catalog: `piece-<id>` must fit the 32-character kind). */
export const PIECE_ID_PATTERN = /^[a-z][a-z0-9-]{0,25}$/

/**
 * What a mark names, for every source of the panel:
 *   icon:<set>:<name>@<setVersion>   a built-in icon of that set's pinned version (another version's key is hidden)
 *   piece:<pieceId>                  a built-in shape
 *   item:<lbi_…>                     a library item (a deleted or unreadable one is hidden)
 */
export const LIBRARY_MARK_KEY_PATTERN =
  /^(?:icon:(lucide|tabler):([a-z0-9]+(?:-[a-z0-9]+)*)@(\d{1,4}\.\d{1,4}\.\d{1,4})|piece:([a-z][a-z0-9-]{0,25})|item:(lbi_[0-9A-Za-z]{10,40}))$/
export const LIBRARY_MARK_KEY_MAX = 120
export const LibraryMarkKey = z.string().min(3).max(LIBRARY_MARK_KEY_MAX).regex(LIBRARY_MARK_KEY_PATTERN)

export type LibraryMarkTarget =
  | { source: 'icon'; set: IconSetId; name: string; version: string }
  | { source: 'piece'; id: string }
  | { source: 'item'; id: string }

export function libraryMarkKey(target: LibraryMarkTarget): string {
  switch (target.source) {
    case 'icon':
      return `icon:${target.set}:${target.name}@${target.version}`
    case 'piece':
      return `piece:${target.id}`
    case 'item':
      return `item:${target.id}`
  }
}

/** The target of a mark key, or null when it is not one. */
export function parseLibraryMarkKey(key: unknown): LibraryMarkTarget | null {
  if (typeof key !== 'string' || key.length > LIBRARY_MARK_KEY_MAX) return null
  const m = LIBRARY_MARK_KEY_PATTERN.exec(key)
  if (!m) return null
  if (m[1] && m[2] && m[3]) {
    const set = IconSetId.safeParse(m[1])
    return set.success ? { source: 'icon', set: set.data, name: m[2], version: m[3] } : null
  }
  if (m[4]) return { source: 'piece', id: m[4] }
  if (m[5]) return { source: 'item', id: m[5] }
  return null
}

/** PUT …/library/marks: star or unstar, and/or stamp a use (an insert of a built-in; `place` stamps items itself). */
export const PutLibraryMarkInput = z
  .strictObject({ key: LibraryMarkKey, favourite: z.boolean().optional(), used: z.literal(true).optional() })
  .refine((v) => v.favourite !== undefined || v.used !== undefined, 'nothing to update')
export type PutLibraryMarkInput = z.infer<typeof PutLibraryMarkInput>

export const LibraryMark = z.object({
  key: LibraryMarkKey,
  favourite: z.boolean(),
  usedAt: z.string().nullable(),
})
export type LibraryMark = z.infer<typeof LibraryMark>

/** GET …/library/marks: the caller's own favourites (all) and recents (the last LIBRARY_LIMITS.recents used). */
export const ListLibraryMarksResponse = z.object({
  favourites: z.array(LibraryMark).max(LIBRARY_LIMITS.favourites),
  recents: z.array(LibraryMark).max(LIBRARY_LIMITS.recents),
})
export type ListLibraryMarksResponse = z.infer<typeof ListLibraryMarksResponse>

// ---- place ----------------------------------------------------------------------------------------------------

/**
 * POST /api/boards/:bid/library/items/:id/place (no body): the item's elements (item-local ids; the client re-keys
 * them, apps/web/src/features/elements/place.ts) and the facts of the files they show, now linked into the board.
 * The client calls it BEFORE it pushes (sync's file-refs check caches a negative answer for 30 s).
 */
export const PlaceLibraryItemResponse = z.object({
  item: z.object({ id: LibraryItemId, name: z.string(), revision: z.number().int().min(1) }),
  elements: LibraryElements,
  files: z.array(LibraryFileFacts).max(LIBRARY_LIMITS.itemImages),
})
export type PlaceLibraryItemResponse = z.infer<typeof PlaceLibraryItemResponse>

// ---- routes and the guard lists ---------------------------------------------------------------------------------

export const LIBRARY_ROUTES = {
  list: '/api/workspaces/:wid/library',
  items: '/api/workspaces/:wid/library/items',
  item: '/api/workspaces/:wid/library/items/:id',
  restore: '/api/workspaces/:wid/library/items/:id/restore',
  thumb: '/api/workspaces/:wid/library/items/:id/files/:ver/thumb',
  import: '/api/workspaces/:wid/library/import',
  folders: '/api/workspaces/:wid/library/folders',
  folder: '/api/workspaces/:wid/library/folders/:fid',
  marks: '/api/workspaces/:wid/library/marks',
  place: '/api/boards/:bid/library/items/:id/place',
  /** after the push of a place's elements succeeded: the links it made stay (review fix; docs/WAVE-Q-CONTRACTS.md §9) */
  placeConfirm: '/api/boards/:bid/library/items/:id/place/confirm',
} as const

const R = LIBRARY_ROUTES
/** Every library route, as the api's guard lists key them (`METHOD pattern`; HEAD reads as GET). */
export const LIBRARY_ROUTE_KEYS = [
  `GET ${R.list}`,
  `GET ${R.item}`,
  `POST ${R.items}`,
  `PATCH ${R.item}`,
  `DELETE ${R.item}`,
  `POST ${R.restore}`,
  `GET ${R.thumb}`,
  `POST ${R.import}`,
  `GET ${R.folders}`,
  `POST ${R.folders}`,
  `PATCH ${R.folder}`,
  `DELETE ${R.folder}`,
  `GET ${R.marks}`,
  `PUT ${R.marks}`,
  `POST ${R.place}`,
  `POST ${R.placeConfirm}`,
] as const
export type LibraryRouteKey = (typeof LIBRARY_ROUTE_KEYS)[number]

/** A name-only guest is refused every one of them (guests/guard.ts GUEST_REFUSED_ROUTES). */
export const LIBRARY_GUEST_ROUTE_KEYS: readonly LibraryRouteKey[] = LIBRARY_ROUTE_KEYS
export const LIBRARY_GUESTS_MESSAGE =
  'The element library is for people with an account. Sign in with an account to use it.'

/**
 * The writes that need a creator in the workspace scope and are open to everyone in the personal scope: the
 * domain-access guard freshens the caller ('in-route'), and the route calls requireCreator when the scope (from the
 * body, or from the stored item or folder) is 'workspace'.
 */
export const LIBRARY_CREATOR_IN_ROUTE_KEYS: readonly LibraryRouteKey[] = [
  `POST ${R.items}`,
  `PATCH ${R.item}`,
  `DELETE ${R.item}`,
  `POST ${R.restore}`,
  `POST ${R.import}`,
  `POST ${R.folders}`,
  `PATCH ${R.folder}`,
  `DELETE ${R.folder}`,
]

const ws = (wid: string) => `/api/workspaces/${encodeURIComponent(wid)}/library`
const enc = encodeURIComponent

/** GET …/library with its query (undefined values left out). */
export function libraryListPath(workspaceId: string, query: Partial<ListLibraryQuery> = {}): string {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
    .join('&')
  return qs ? `${ws(workspaceId)}?${qs}` : ws(workspaceId)
}
export const libraryItemsPath = (wid: string) => `${ws(wid)}/items`
export const libraryItemPath = (wid: string, id: string) => `${ws(wid)}/items/${enc(id)}`
export const libraryRestorePath = (wid: string, id: string) => `${libraryItemPath(wid, id)}/restore`
/** The thumb of a version an item shows; with `page`, that page of a PDF (a placed PDF page, `ver_….p<n>`). */
export const libraryThumbPath = (wid: string, id: string, versionId: string, page?: number) =>
  `${libraryItemPath(wid, id)}/files/${enc(versionId)}/thumb${page === undefined ? '' : `?page=${page}`}`
export const libraryImportPath = (wid: string) => `${ws(wid)}/import`
export const libraryFoldersPath = (wid: string, scope?: LibraryScope) =>
  scope ? `${ws(wid)}/folders?scope=${scope}` : `${ws(wid)}/folders`
export const libraryFolderPath = (wid: string, fid: string) => `${ws(wid)}/folders/${enc(fid)}`
export const libraryMarksPath = (wid: string) => `${ws(wid)}/marks`
export const libraryPlacePath = (boardId: string, id: string) =>
  `/api/boards/${enc(boardId)}/library/items/${enc(id)}/place`
export const libraryPlaceConfirmPath = (boardId: string, id: string) => `${libraryPlacePath(boardId, id)}/confirm`
