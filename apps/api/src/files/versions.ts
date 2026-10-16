// OWNER: WS2 (wave S, versions of a deliverable). The version list and the chain rules the upload's
// X-Lobby-Supersedes uses (@draftroom/contracts asset-versions.ts; docs/WAVE-S-CONTRACTS.md §3):
//
//   GET /api/boards/:bid/asset-versions/:ast   the asset's versions servable on this board, oldest first        S2-1
//
// A version of a deliverable is an asset_versions row with the deliverable's asset id; `supersedes` names the version
// it replaced (0037: inside one asset by key, linear by a unique index). Visibility follows the VERSION, as for every
// file route (files-auth.ts): a board serves the versions uploaded to it and the ones linked to it
// (board_asset_links, same workspace). So the list numbers only those: a copy that only links v3 shows it as its v1.
// Chain order is the `supersedes` walk (a chain whose middle version was deleted with its board continues in upload
// order), never created_at alone (two uploads in one millisecond keep their order).
//
// The list: view access through the board (a name-only guest on a link reads it like any viewer; the link's role
// decides); thread counts as the caller may see them (this board's threads pinned to the version, team-only ones only
// for the team, a thread whose every comment was deleted is gone); the last review status given to the version on
// this board. A separate path, so the files plugin's /api/boards/:bid/assets/:ast/:ver routes and their 405
// catch-alls stay as they are.

import {
  ASSET_VERSION_EVENT,
  ASSET_VERSION_ROUTES,
  type AssetVersionEntry,
  type ListAssetVersionsResponse,
  REVIEW_ITEM_EVENT,
  type ReviewActor,
  type ReviewItem,
  type ReviewStatus,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { isId } from '@draftroom/dev-assets'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../access.ts'
import { type CreatorLookup, knownOutsideSql, matchParams } from '../auth/creator-sql.ts'
import type { Params } from '../context.ts'
import { notFound } from '../errors.ts'
import type { EventHub } from '../events/hub.ts'
import { isTeamMember } from '../features/comments/store.ts'
import type { FeatureContext } from '../features/context.ts'
import { routeUnlessPending } from '../features/pending-routes.ts'
import { probeFacts } from './meta.ts'

// ---- the chain --------------------------------------------------------------------------------------------------

export interface ChainLink {
  id: string
  supersedes: string | null
  created_at: Date
}

const byUpload = (a: ChainLink, b: ChainLink) =>
  a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id)

/**
 * The versions of one asset in chain order: each first version (no predecessor, or its predecessor is gone) in upload
 * order, each followed by its successors. Rows that a walk never reaches (impossible under 0037's keys) follow in
 * upload order, so nothing is ever dropped.
 */
export function chainOrder<T extends ChainLink>(rows: readonly T[]): T[] {
  const ids = new Set(rows.map((r) => r.id))
  const next = new Map<string, T>()
  for (const r of rows) if (r.supersedes && ids.has(r.supersedes)) next.set(r.supersedes, r)
  const out: T[] = []
  const seen = new Set<string>()
  const sorted = [...rows].sort(byUpload)
  for (const root of sorted) {
    if (root.supersedes && ids.has(root.supersedes)) continue
    let at: T | undefined = root
    while (at && !seen.has(at.id)) {
      seen.add(at.id)
      out.push(at)
      at = next.get(at.id)
    }
  }
  for (const r of sorted) if (!seen.has(r.id)) out.push(r)
  return out
}

export interface ChainVersionRow extends ChainLink {
  asset_id: string
  board_id: string
  kind: 'image' | 'pdf' | 'video' | 'other'
  /** uploaded to the board asked about, or linked to it */
  servable: boolean
}

/**
 * Every version of `assetId` in the workspace, in chain order, each with whether `boardId` may serve it (files-auth.ts:
 * uploaded to it, or a board_asset_links row of the workspace whose uploading board is in the workspace too).
 */
export async function chainOnBoard(
  q: Queryable,
  workspaceId: string,
  boardId: string,
  assetId: string,
): Promise<ChainVersionRow[]> {
  const rows = await q.query<ChainVersionRow>(
    `SELECT v.id, v.asset_id, v.supersedes, v.board_id, v.kind, v.created_at,
            (v.board_id = $3 OR EXISTS (
              SELECT 1 FROM board_asset_links l
                JOIN boards owner ON owner.id = v.board_id AND owner.workspace_id = l.workspace_id
               WHERE l.workspace_id = $2 AND l.board_id = $3 AND l.asset_id = v.asset_id AND l.version_id = v.id
            )) AS servable
       FROM asset_versions v
      WHERE v.asset_id = $1 AND v.workspace_id = $2`,
    [assetId, workspaceId, boardId],
  )
  return chainOrder(rows.rows)
}

/** The newest version `boardId` may serve (what "Upload new version" supersedes and a status is about), or null. */
export const latestServable = (chain: readonly ChainVersionRow[]): ChainVersionRow | null =>
  [...chain].reverse().find((v) => v.servable) ?? null

/**
 * Why `versionId` cannot be superseded on `boardId` now (null: it can), for the upload's checks before the body and
 * again in its transaction: 'missing' (not a version of this workspace this board serves: a 404, no probing),
 * 'not-latest' (a newer servable version exists, or the version already has a successor, perhaps on another board),
 * 'not-origin' (the newest version was uploaded to another board and is only LINKED here, as a copy links what its
 * canvas showed: only the board it was uploaded to, its origin, continues the chain; a copy uploads a new file
 * instead, which the web's fallback does, and the review item on the copy is then "File replaced: review again").
 */
export async function supersedeCheck(
  q: Queryable,
  workspaceId: string,
  boardId: string,
  versionId: string,
  opts: { lock?: boolean } = {},
): Promise<
  | { ok: true; version: ChainVersionRow }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'not-latest' | 'not-origin'; latestVersionId: string }
> {
  const row = await q.maybeOne<{ asset_id: string }>(
    `SELECT asset_id FROM asset_versions WHERE id = $1 AND workspace_id = $2${opts.lock ? ' FOR SHARE' : ''}`,
    [versionId, workspaceId],
  )
  if (!row) return { ok: false, reason: 'missing' }
  const chain = await chainOnBoard(q, workspaceId, boardId, row.asset_id)
  const version = chain.find((v) => v.id === versionId)
  if (!version?.servable) return { ok: false, reason: 'missing' }
  const latest = latestServable(chain) as ChainVersionRow
  if (latest.id !== versionId || chain.some((v) => v.supersedes === versionId))
    return { ok: false, reason: 'not-latest', latestVersionId: latest.id }
  if (version.board_id !== boardId) return { ok: false, reason: 'not-origin', latestVersionId: versionId }
  return { ok: true, version }
}

// ---- after COMMIT --------------------------------------------------------------------------------------------------

/** What a committed upload with X-Lobby-Supersedes hands to the host to publish. */
export interface NewVersionCommitted {
  boardId: string
  assetId: string
  versionId: string
  /** review items the new version reset (features/review/hooks.ts resetForNewVersion) */
  items: readonly ReviewItem[]
}

/**
 * The board events of a new version, after COMMIT: ASSET_VERSION_EVENT on the board it was uploaded to (the only board
 * that serves it yet: open tabs refresh the card's chip and list), and REVIEW_ITEM_EVENT for every item it reset. The
 * same payload for every viewer.
 */
export function publishNewVersion(events: Pick<EventHub, 'publish'>, c: NewVersionCommitted): void {
  events.publish(c.boardId, {
    type: ASSET_VERSION_EVENT,
    data: { assetId: c.assetId, versionId: c.versionId },
  })
  for (const item of c.items) events.publish(item.boardId, { type: REVIEW_ITEM_EVENT, data: { item } })
}

// ---- the list -----------------------------------------------------------------------------------------------------

interface EntryRow {
  id: string
  name: string
  kind: AssetVersionEntry['kind']
  size_bytes: number
  status: AssetVersionEntry['status']
  probe: unknown
  created_at: Date
  uploader_id: string | null
  uploader_name: string | null
  uploader_kind: string | null
  uploader_guest_name: string | null
  uploader_external: boolean | null
}

interface ThreadCountRow {
  version_id: string
  status: string
  n: number
}

interface ReviewRow {
  version_id: string
  status: ReviewStatus
  actor_id: string | null
  actor_name: string
  actor_kind: ReviewActor['kind']
  actor_external: boolean
  created_at: Date
}

const intOrNull = (v: number | null, min: number) =>
  v === null || !Number.isFinite(v) || v < min ? null : Math.round(v)

/** The version list of `assetId` on `board` for a caller (`team`: on the team, so team-only threads count). */
export async function listAssetVersions(
  q: Queryable,
  board: { id: string; workspace_id: string },
  assetId: string,
  opts: { team: boolean; lookup: CreatorLookup },
): Promise<ListAssetVersionsResponse | null> {
  const chain = (await chainOnBoard(q, board.workspace_id, board.id, assetId)).filter((v) => v.servable)
  if (chain.length === 0) return null
  const ids = chain.map((v) => v.id)
  const rows = await q.query<EntryRow>(
    `SELECT v.id, v.name, v.kind, v.size_bytes::float8 AS size_bytes, v.status, v.probe, v.created_at,
            u.id AS uploader_id, u.name AS uploader_name, u.kind AS uploader_kind, u.guest_name AS uploader_guest_name,
            ${knownOutsideSql('u', 3)} AS uploader_external
       FROM asset_versions v
       LEFT JOIN users u ON u.id = v.uploaded_by
      WHERE v.id = ANY($1::text[]) AND v.workspace_id = $2`,
    [ids, board.workspace_id, ...matchParams(opts.lookup)],
  )
  const threads = await q.query<ThreadCountRow>(
    `SELECT t.anchor ->> 'versionId' AS version_id, t.status, count(*)::int AS n
       FROM comment_threads t
      WHERE t.workspace_id = $1 AND t.board_id = $2 AND t.anchor ->> 'kind' = 'asset'
        AND t.anchor ->> 'versionId' = ANY($3::text[])
        AND ($4::boolean OR t.visibility = 'everyone')
        AND EXISTS (SELECT 1 FROM comments c WHERE c.thread_id = t.id AND c.deleted_at IS NULL)
      GROUP BY 1, 2`,
    [board.workspace_id, board.id, ids, opts.team],
  )
  const reviews = await q.query<ReviewRow>(
    `SELECT DISTINCT ON (e.version_id) e.version_id, e.status, e.actor_id, e.actor_name, e.actor_kind,
            e.actor_external, e.created_at
       FROM review_events e
      WHERE e.workspace_id = $1 AND e.board_id = $2 AND e.kind = 'status' AND e.version_id = ANY($3::text[])
      ORDER BY e.version_id, e.seq DESC`,
    [board.workspace_id, board.id, ids],
  )
  const byId = new Map(rows.rows.map((r) => [r.id, r]))
  const counts = new Map<string, { open: number; resolved: number }>()
  for (const t of threads.rows) {
    const c = counts.get(t.version_id) ?? { open: 0, resolved: 0 }
    if (t.status === 'resolved') c.resolved += t.n
    else c.open += t.n
    counts.set(t.version_id, c)
  }
  const reviewOf = new Map(reviews.rows.map((r) => [r.version_id, r]))
  const versions: AssetVersionEntry[] = []
  for (const v of chain) {
    const r = byId.get(v.id)
    if (!r) continue
    const probe = probeFacts(r.probe)
    const guest = r.uploader_kind === 'guest'
    const review = reviewOf.get(v.id)
    versions.push({
      n: versions.length + 1,
      versionId: v.id,
      // only a predecessor this board serves: a copy never learns the id of a version it cannot open
      supersedes: v.supersedes && ids.includes(v.supersedes) ? v.supersedes : null,
      name: r.name,
      kind: r.kind,
      sizeBytes: Number(r.size_bytes),
      uploadedBy: {
        id: r.uploader_id,
        // a guest by the name as typed (reviewActorLabel adds " (guest)"); a removed account reads "Someone"
        name: (guest ? r.uploader_guest_name : r.uploader_name) || r.uploader_name || 'Someone',
        kind: guest ? 'guest' : 'account',
        external: !guest && r.uploader_external === true,
      },
      createdAt: r.created_at.toISOString(),
      status: r.status,
      pageCount: intOrNull(probe.pageCount, 1),
      durationMs: intOrNull(probe.durationMs, 0),
      threads: counts.get(v.id) ?? { open: 0, resolved: 0 },
      review: review
        ? {
            status: review.status,
            by: {
              id: review.actor_id,
              name: review.actor_name,
              kind: review.actor_kind,
              external: review.actor_external,
            },
            at: review.created_at.toISOString(),
          }
        : null,
    })
  }
  const latest = versions[versions.length - 1]
  return latest ? { assetId, versions, latestVersionId: latest.versionId } : null
}

export async function registerAssetVersions(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db } = ctx
  routeUnlessPending(app, 'GET', ASSET_VERSION_ROUTES.list, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { bid = '', ast = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    if (!isId('ast', ast)) throw notFound()
    const lookup = ctx.identity.lookup
    const team = await isTeamMember(db, access.board.workspace_id, user.id, { lookup, now: ctx.now() })
    const list = await listAssetVersions(db, access.board, ast, { team, lookup })
    if (!list) throw notFound()
    reply.header('cache-control', 'no-store')
    return list
  })
}
