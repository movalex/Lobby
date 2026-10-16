/**
 * The Miro side of an import, without the engine (the api reads only this module: `@draftroom/miro-import/sources`):
 * the shapes of Miro REST API v2 answers as Lobby reads them, the seed body the api sends to sync (`miro-v2`), the
 * file references an item holds, and the slimming that keeps only what the converter reads.
 *
 * Everything Miro sends is untrusted: every reader here checks types and sizes and drops what it does not know.
 * Numbers may arrive as strings (Miro's style fields do). No URL found in content is ever followed: the only URLs
 * the api fetches are a resource path of MIRO_RESOURCE_PATH_PATTERN on Miro's API host (rewritten by the api) and
 * the signed URL its answer names (checked by the egress rules). Pure; nothing here logs.
 */
import {
  MIRO_API_HOST,
  MIRO_BOARD_ID_PATTERN,
  MIRO_RESOURCE_PATH_PATTERN,
  type MiroItemType,
} from '@draftroom/contracts'

export const MIRO_SEED_FORMAT = 'miro-v2' as const

/** A Miro item as the converter reads it (after `slimItem`). */
export interface MiroItem {
  readonly id: string
  readonly type: string
  readonly data?: Readonly<Record<string, unknown>>
  readonly style?: Readonly<Record<string, unknown>>
  readonly geometry?: Readonly<Record<string, unknown>>
  readonly position?: Readonly<Record<string, unknown>>
  readonly parent?: { readonly id: string } | null
}

/** One end of a connector: the item and where on it (`"50%"` strings, Miro's own). */
export interface MiroConnectorEnd {
  readonly id: string
  readonly position?: { readonly x?: unknown; readonly y?: unknown } | null
}

export interface MiroCaption {
  readonly content?: unknown
  readonly position?: unknown
}

export interface MiroConnector {
  readonly id: string
  readonly shape?: unknown
  readonly startItem?: MiroConnectorEnd | null
  readonly endItem?: MiroConnectorEnd | null
  readonly style?: Readonly<Record<string, unknown>>
  readonly captions?: readonly MiroCaption[]
  readonly isSupported?: unknown
}

export interface MiroGroup {
  readonly id: string
  readonly items: readonly string[]
}

export interface MiroTag {
  readonly id: string
  readonly title: string
  readonly fillColor: string
}

/** The stable facts of a file the api stored as a version of the importing board (canvas-schema FileValue). */
export interface MiroStoredFile {
  readonly assetId: string
  readonly versionId: string
  readonly kind: 'image' | 'pdf' | 'video' | 'other'
  readonly name: string
  readonly mimeType: string
  readonly sizeBytes: number
}

/** Why a file is not on the board (a report note: the item becomes a placeholder card). */
export const MIRO_FILE_FAILURES = [
  /** MIRO_DOWNLOAD_HOSTS is empty (the owner's probe has not run yet): no download was tried */
  'file-not-imported-yet',
  /** the resource answer pointed at a host the egress rules refuse */
  'file-host-refused',
  /** the download failed (an error, a timeout, an expired URL, a wrong length) */
  'file-failed',
  /** over the upload limits of its kind, or the import's file limits */
  'file-too-large',
] as const
export type MiroFileFailure = (typeof MIRO_FILE_FAILURES)[number]

export type MiroFileOutcome = { readonly stored: MiroStoredFile } | { readonly failed: MiroFileFailure }

/**
 * POST /internal/boards/:bid/seed with `format: 'miro-v2'` (apps/sync room-internal/seed.ts): what the api read
 * from Miro, slimmed, and what became of each item's file (by item id). Sync converts it in a worker thread
 * (convert-miro.ts) and answers with the board's report.
 */
export interface MiroSeedBody {
  readonly format: typeof MIRO_SEED_FORMAT
  readonly board: { readonly id: string; readonly name: string }
  readonly items: readonly MiroItem[]
  readonly connectors: readonly MiroConnector[]
  readonly groups: readonly MiroGroup[]
  readonly tags: readonly MiroTag[]
  /** tag id → the ids of the items that carry it (Miro's items have no tag ids: one list per tag) */
  readonly tagItems: Readonly<Record<string, readonly string[]>>
  /** board member id → display name (a card's assignee; never an email) */
  readonly members: Readonly<Record<string, string>>
  readonly files: Readonly<Record<string, MiroFileOutcome>>
}

// ---- readers -------------------------------------------------------------------------------------------------------

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A Miro id: digits in practice; any short id-like string is accepted. */
const ITEM_ID = /^[A-Za-z0-9_=-]{1,64}$/
export const isMiroItemId = (v: unknown): v is string => typeof v === 'string' && ITEM_ID.test(v)

/** At most this many characters of any one string the converter may read (the converter caps texts again). */
export const MAX_SOURCE_STRING = 256 * 1024

function cleanValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > MAX_SOURCE_STRING ? v.slice(0, MAX_SOURCE_STRING) : v
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'boolean' || v === null) return v
  if (depth <= 0) return undefined
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => cleanValue(x, depth - 1))
  if (isRecord(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v).slice(0, 100)) {
      if (k === '__proto__' || k.length > 64) continue
      const c = cleanValue(x, depth - 1)
      if (c !== undefined) out[k] = c
    }
    return out
  }
  return undefined
}

const record = (v: unknown): Record<string, unknown> | undefined =>
  isRecord(v) ? (cleanValue(v, 4) as Record<string, unknown>) : undefined

/** Item `data` fields the converter never reads and the seed never carries (URLs, markup, previews). */
const DROPPED_DATA_KEYS = new Set(['html', 'previewUrl', 'imageUrl', 'documentUrl', 'providerUrl', 'links'])

/** The item as the converter reads it, or null when it is not an item (no id or type). */
export function slimItem(raw: unknown): MiroItem | null {
  if (!isRecord(raw) || !isMiroItemId(raw.id) || typeof raw.type !== 'string' || raw.type.length > 48)
    return null
  const data = record(raw.data)
  if (data) for (const k of DROPPED_DATA_KEYS) delete data[k]
  const parent = isRecord(raw.parent) && isMiroItemId(raw.parent.id) ? { id: raw.parent.id } : null
  return {
    id: raw.id,
    type: raw.type,
    ...(data ? { data } : {}),
    ...(record(raw.style) ? { style: record(raw.style) } : {}),
    ...(record(raw.geometry) ? { geometry: record(raw.geometry) } : {}),
    ...(record(raw.position) ? { position: record(raw.position) } : {}),
    parent,
  }
}

function slimEnd(v: unknown): MiroConnectorEnd | null {
  if (!isRecord(v) || !isMiroItemId(v.id)) return null
  const p = isRecord(v.position) ? { x: v.position.x, y: v.position.y } : null
  return { id: v.id, position: p }
}

/** The connector as the converter reads it, or null. */
export function slimConnector(raw: unknown): MiroConnector | null {
  if (!isRecord(raw) || !isMiroItemId(raw.id)) return null
  const captions = Array.isArray(raw.captions)
    ? raw.captions
        .filter(isRecord)
        .slice(0, 20)
        .map((c) => ({ content: cleanValue(c.content, 0), position: cleanValue(c.position, 0) }))
    : []
  return {
    id: raw.id,
    shape: typeof raw.shape === 'string' ? raw.shape.slice(0, 32) : undefined,
    startItem: slimEnd(raw.startItem),
    endItem: slimEnd(raw.endItem),
    ...(record(raw.style) ? { style: record(raw.style) } : {}),
    captions,
    isSupported: raw.isSupported === false ? false : undefined,
  }
}

/** A group (`{ id, data: { items } }`; an item may be an id or `{ id }`), or null. */
export function slimGroup(raw: unknown): MiroGroup | null {
  if (!isRecord(raw) || !isMiroItemId(raw.id)) return null
  const data = isRecord(raw.data) ? raw.data : {}
  const list = Array.isArray(data.items) ? data.items : Array.isArray(raw.items) ? raw.items : []
  const items: string[] = []
  for (const x of list.slice(0, 10_000)) {
    const id = isRecord(x) ? x.id : x
    if (isMiroItemId(id)) items.push(id)
  }
  return { id: raw.id, items }
}

export function slimTag(raw: unknown): MiroTag | null {
  if (!isRecord(raw) || !isMiroItemId(raw.id) || typeof raw.title !== 'string') return null
  return {
    id: raw.id,
    title: raw.title.slice(0, 200),
    fillColor: typeof raw.fillColor === 'string' ? raw.fillColor.slice(0, 32) : 'gray',
  }
}

// ---- pages ---------------------------------------------------------------------------------------------------------

/** One page of a Miro list (`data` and its paging: a `cursor`, or `offset`/`total`). */
export interface MiroPage {
  readonly data: readonly unknown[]
  readonly cursor: string | null
  readonly total: number | null
  readonly offset: number | null
  readonly size: number | null
}

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000_000 ? v : null

/** A Miro list answer, or null when the body is not one. */
export function readPage(body: unknown): MiroPage | null {
  if (!isRecord(body) || !Array.isArray(body.data)) return null
  const cursor =
    typeof body.cursor === 'string' && /^[A-Za-z0-9_=+/.-]{1,512}$/.test(body.cursor) ? body.cursor : null
  return {
    data: body.data,
    cursor,
    total: count(body.total),
    offset: count(body.offset),
    size: count(body.size),
  }
}

// ---- files ---------------------------------------------------------------------------------------------------------

/** What an image or document item points at: a Miro resource the api may ask for (by path, on Miro's API host). */
export interface MiroFileRef {
  /**
   * the dedupe and resume key (`image-<id>` or `document-<id>`; board_import_files.source_key's shape): a board can
   * show one file many times
   */
  readonly key: string
  readonly kind: 'images' | 'documents'
  /** the resource's id in Miro */
  readonly id: string
  /** the resource path (MIRO_RESOURCE_PATH_PATTERN), without the query */
  readonly path: string
  /** the item's title (an image's or document's name in Miro), cleaned by the api before it is stored */
  readonly title: string | null
}

/**
 * The resource an image (`data.imageUrl`) or document (`data.documentUrl`) item points at, or null when it points
 * anywhere else: only `https://api.miro.com/v2/boards/<this board>/resources/(images|documents)/<id>` is taken (any
 * query is dropped: the api asks for `?format=original&redirect=false` itself).
 */
export function fileRefOf(raw: unknown, boardId: string): MiroFileRef | null {
  if (!isRecord(raw) || (raw.type !== 'image' && raw.type !== 'document') || !isRecord(raw.data)) return null
  const href = raw.type === 'image' ? raw.data.imageUrl : raw.data.documentUrl
  if (typeof href !== 'string' || href.length > 2048 || !MIRO_BOARD_ID_PATTERN.test(boardId)) return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== MIRO_API_HOST || url.port !== '' || url.username)
    return null
  // a board id with `=` may arrive percent-encoded (`%3D`): the path is compared decoded
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (!MIRO_RESOURCE_PATH_PATTERN.test(path)) return null
  const [, , , board, , kind, id] = path.split('/')
  if (board !== boardId || !id || (kind !== 'images' && kind !== 'documents')) return null
  const title =
    typeof raw.data.title === 'string' && raw.data.title.trim() ? raw.data.title.slice(0, 400) : null
  return { key: `${kind === 'images' ? 'image' : 'document'}-${id}`, kind, id, path, title }
}

/** The item types the converter maps (every one of MIRO_ITEM_TYPES; the converter's test checks the list). */
export const MAPPED_ITEM_TYPES: readonly MiroItemType[] = [
  'text',
  'shape',
  'sticky_note',
  'image',
  'document',
  'card',
  'app_card',
  'preview',
  'frame',
  'embed',
  'doc_format',
  'data_table_format',
  'unknown',
]
