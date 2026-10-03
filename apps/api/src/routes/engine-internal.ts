// The api side of the Excalidraw engine's internal contracts (docs/EXCALIDRAW-MIGRATION.md §1 A1, A2,
// §2.10.2; the contract is @draftroom/contracts sync-internal.ts, frozen at spike B's C0). Shipped in the
// bridge release R0 (§5.10, §7.5 step 5), reviewed from the spike branch: the tldraw sync never calls
// these routes; the Excalidraw sync does, including while a roll-forward runs against R0's api.
//
//   A1  GET /internal/boards/:bid/file-refs?ids=ver_a,ver_b,…  → 200 FileRefsResponse
//   A2  GET /internal/boards/:bid/workshop-state               → 200 WorkshopStateBody
//
// Server-to-server only (the web proxy never forwards /internal). GETs, like `touched` and
// `/internal/access`, because the root CSRF hook refuses server-to-server POSTs. The internal secret is
// checked before anything else by the root guard every `/internal` route shares (app.ts
// registerInternalSecretGuard; it answers these two routes in the contract's shape: engineBadSecret).
// Errors are the contract's
// `{ error: { code, message } }` with its codes: 401 `bad-secret`, 400 `bad-request`, 404
// `board-not-found`, 503 `unavailable`. Sync fails closed on anything but 200 (and after its 3 s
// timeout): ops that need an unresolved file get `UNAVAILABLE`.
//
// A1's answer is the same check the `/files/…` routes use to serve a version to a board
// (files/serve.ts loadBoardVersion): a version is `ok` for a board when it was uploaded to that board,
// or when the board holds a history link to it inside its own workspace (board_asset_links, as
// files-auth.ts isAssetLinked checks). Every other asked id is `missing`: an id with no version row,
// and an existing version the board cannot show (another workspace, or a board of the same workspace
// that holds no link), which `/files` answers with the same 404 so that access to one board can never
// probe for versions elsewhere (security audit L4: the answer was once split into `foreign` and
// `missing`; the contract keeps the `foreign` list for its shape, and it is always empty from this
// build on; sync treats both alike, as `INVALID`). Every asked id appears in exactly one list, once.
// Like `/files`, A1 answers only for a board that can be opened: a trashed board is 404
// `board-not-found` (sync fails closed: the op gets `UNAVAILABLE`), an archived one still answers.

import {
  type FileRef,
  type FileRefsResponse,
  parseFileRefsIds,
  SYNC_INTERNAL_ERROR_STATUS,
  type SyncInternalErrorCode,
  type WorkshopStateBody,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { type BoardStatus, can } from '@draftroom/permissions'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isBoardId } from '../access.ts'
import type { AppContext, Params } from '../context.ts'
import { ApiError } from '../errors.ts'
import { workshopStateOf } from '../features/workshops/workshop-state.ts'
import { probeFacts } from '../files/meta.ts'

export const FILE_REFS_ROUTE = '/internal/boards/:bid/file-refs'
export const WORKSHOP_STATE_ROUTE = '/internal/boards/:bid/workshop-state'

const MESSAGES: Record<SyncInternalErrorCode, string> = {
  'bad-secret': 'Internal credentials required.',
  'bad-request': 'The request is not valid.',
  'board-not-found': 'No such board.',
  unavailable: 'Try again in a moment.',
}
const fail = (code: SyncInternalErrorCode, message = MESSAGES[code]) =>
  new ApiError(SYNC_INTERNAL_ERROR_STATUS[code], code, message)

/** The two routes with a typed error contract: the root secret guard (app.ts) answers them with `engineBadSecret`. */
export const ENGINE_INTERNAL_ROUTES: ReadonlySet<string> = new Set([FILE_REFS_ROUTE, WORKSHOP_STATE_ROUTE])

/**
 * The body of 401 `bad-secret` in the contract's error shape (SyncInternalErrorBody; the status is
 * SYNC_INTERNAL_ERROR_STATUS['bad-secret'], 401, pinned by the contracts package's own test).
 */
export const engineBadSecretBody = () => ({
  error: { code: 'bad-secret' as const, message: MESSAGES['bad-secret'] },
})

/** Every value of query parameter `name` from the raw URL (independent of the querystring parser). */
function rawParams(req: FastifyRequest, name: string): string[] {
  const q = req.url.indexOf('?')
  return q === -1 ? [] : new URLSearchParams(req.url.slice(q + 1)).getAll(name)
}

interface BoardRef {
  id: string
  workspace_id: string
  status: BoardStatus
}

/**
 * The board, or 404 `board-not-found`. Any status by default (sync asks for boards whose rooms are
 * open); with `openable`, only a board someone could still open (the `/files` routes' own status check:
 * a trashed board is nobody's to view until it is restored, so its files are a 404 for everyone).
 */
async function loadBoard(db: Queryable, bid: string, opts: { openable?: boolean } = {}): Promise<BoardRef> {
  if (!isBoardId(bid)) throw fail('board-not-found')
  const row = await guarded(() =>
    db.maybeOne<BoardRef>('SELECT id, workspace_id, status FROM boards WHERE id = $1', [bid]),
  )
  if (!row) throw fail('board-not-found')
  if (opts.openable && !can('viewer', 'view', row.status)) throw fail('board-not-found')
  return row
}

/** A database failure is 503 `unavailable` (sync retries; it never treats it as an answer). */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw fail('unavailable')
  }
}

interface VersionRefRow {
  id: string
  asset_id: string
  workspace_id: string
  board_id: string
  name: string
  mime_type: string
  kind: FileRef['kind']
  size_bytes: number
  probe: unknown
}

/** A1: the versions `ids` of `board`, split into ok / missing (`foreign` stays empty; see the header). */
export async function fileRefsFor(
  db: Queryable,
  board: BoardRef,
  ids: readonly string[],
): Promise<FileRefsResponse> {
  const unique = [...new Set(ids)]
  const rows = (
    await db.query<VersionRefRow>(
      `SELECT v.id, v.asset_id, v.workspace_id, v.board_id, v.name, v.mime_type, v.kind,
              v.size_bytes::float8 AS size_bytes, v.probe
         FROM asset_versions v WHERE v.id = ANY($1::text[])`,
      [unique],
    )
  ).rows
  const byId = new Map(rows.map((r) => [r.id, r]))
  // Versions of other boards of this workspace: servable only through a history link (files-auth.ts).
  const elsewhere = rows.filter((r) => r.board_id !== board.id && r.workspace_id === board.workspace_id)
  const linked = new Set<string>()
  if (elsewhere.length) {
    const links = await db.query<{ asset_id: string; version_id: string }>(
      `SELECT l.asset_id, l.version_id FROM board_asset_links l
        WHERE l.workspace_id = $1 AND l.board_id = $2 AND l.version_id = ANY($3::text[])`,
      [board.workspace_id, board.id, elsewhere.map((r) => r.id)],
    )
    for (const l of links.rows) linked.add(`${l.asset_id}/${l.version_id}`)
  }
  const out: FileRefsResponse = { ok: [], foreign: [], missing: [] }
  for (const id of unique) {
    const r = byId.get(id)
    // No row, or a version this board cannot show: the same `missing` (audit L4, no existence oracle).
    const servable =
      r !== undefined &&
      r.workspace_id === board.workspace_id &&
      (r.board_id === board.id || linked.has(`${r.asset_id}/${r.id}`))
    if (!servable) {
      out.missing.push(id)
      continue
    }
    const pages = r.kind === 'pdf' ? probeFacts(r.probe).pageCount : null
    out.ok.push({
      versionId: r.id,
      assetId: r.asset_id,
      kind: r.kind,
      name: r.name,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes),
      pageCount: pages !== null && Number.isInteger(pages) && pages >= 0 ? pages : null,
    })
  }
  return out
}

export function registerEngineInternalRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, now } = ctx

  app.get(FILE_REFS_ROUTE, async (req): Promise<FileRefsResponse> => {
    const raw = rawParams(req, 'ids')
    const ids = raw.length === 1 ? parseFileRefsIds(raw[0]) : null
    if (!ids) throw fail('bad-request', 'ids: 1-100 comma-separated version ids (ver_…).')
    const { bid = '' } = req.params as Params
    const board = await loadBoard(db, bid, { openable: true })
    return guarded(() => fileRefsFor(db, board, ids))
  })

  app.get(WORKSHOP_STATE_ROUTE, async (req): Promise<WorkshopStateBody> => {
    const { bid = '' } = req.params as Params
    const board = await loadBoard(db, bid)
    return guarded(() => workshopStateOf(db, board.id, now()))
  })
}
