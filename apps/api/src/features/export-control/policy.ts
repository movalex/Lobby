// The per-board export policy (docs/WAVE3-CONTRACTS.md "export-control"), read by every route that
// enforces it: original file downloads (files-auth.ts), the board archive, duplicate and restore-as-new
// (features/history). One place decides, so the routes cannot drift apart.
//
// Rule (packages/contracts exportAllowedFor): with policy 'editors', a caller whose board role is below
// editor (viewers, commenters, guests on review links) is refused. A name-only guest is refused under
// 'editors' AND under 'everyone' (the default: no row), whatever their role (a workshop link makes them
// editors: SEAM-04; audit L3): only 'everyone-including-guests', a board owner's explicit choice, lets
// them export and download originals. Owners and editors with an account never are refused, and neither
// is anyone with an account on a board with policy 'everyone'.

import {
  CANVAS_ORIGINAL_LIMITS,
  DEFAULT_EXPORT_POLICY,
  EXPORT_DISABLED_CODE,
  EXPORT_DISABLED_MESSAGE,
  type ExportPolicy,
  exportAllowedFor,
  policyIncludesGuests,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { AssetKind, AssetStatus } from '@draftroom/dev-assets'
import { roleAtLeast } from '@draftroom/permissions'
import type { FastifyRequest } from 'fastify'
import type { BoardAccess } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import { ApiError } from '../../errors.ts'
import { INLINE_MIMES } from '../../files/mime.ts'

/** The board's policy ('everyone' when its owner never changed it). */
export async function loadExportPolicy(q: Queryable, boardId: string): Promise<ExportPolicy> {
  return (await loadExportPolicyRow(q, boardId)).policy
}

/**
 * The board's policy and whether it is stored (`set`): false while the board still uses the default
 * because nobody chose one, which is when a client link may still change it (limitExportForClientLink).
 */
export async function loadExportPolicyRow(
  q: Queryable,
  boardId: string,
): Promise<{ policy: ExportPolicy; set: boolean }> {
  const row = await q.maybeOne<{ policy: ExportPolicy }>(
    'SELECT policy FROM board_export_policies WHERE board_id = $1',
    [boardId],
  )
  return { policy: row?.policy ?? DEFAULT_EXPORT_POLICY, set: row !== null }
}

/**
 * DANA2-01: the first client link (a viewer or commenter review link, the Share dialog's "Share with
 * a client") on a board whose owner never chose an export policy turns exporting off for the people
 * it lets in: the policy becomes 'editors', so a client cannot export the board or download its
 * original files unless the owner turns it back on. An owner's own choice (a stored row, 'everyone'
 * included) is never changed. Runs inside the link's transaction; true when it stored the policy, and
 * the caller then publishes it (publishExportPolicy) after the commit.
 */
export async function limitExportForClientLink(
  q: Queryable,
  board: { id: string; workspace_id: string },
  userId: string,
  at: Date,
): Promise<boolean> {
  const r = await q.query(
    `INSERT INTO board_export_policies (board_id, workspace_id, policy, updated_by, updated_at)
     VALUES ($1, $2, 'editors', $3, $4)
     ON CONFLICT (board_id) DO NOTHING`,
    [board.id, board.workspace_id, userId, at],
  )
  return r.rowCount > 0
}

/**
 * Whether `userId` (the caller behind `access`) may export, copy and download on that board under
 * `policy`. A name-only guest is looked up only when it can matter: a policy that does not include
 * guests, a role that would otherwise be allowed, and the workspace role every name-only guest has
 * ('guest').
 */
export async function exportAllowedForCaller(
  q: Queryable,
  access: BoardAccess,
  userId: string,
  policy: ExportPolicy,
): Promise<boolean> {
  if (!exportAllowedFor(access.role, policy)) return false
  if (policyIncludesGuests(policy) || access.workspaceRole !== 'guest') return true
  return exportAllowedFor(access.role, policy, { nameOnlyGuest: (await userKind(q, userId)) === 'guest' })
}

/** Whether `userId`, the caller behind `access`, may export, copy and download on that board. */
export async function mayExport(q: Queryable, access: BoardAccess, userId: string): Promise<boolean> {
  // Owners and editors with an account are never limited: no query needed. (Name-only guests always
  // hold the workspace role 'guest'.)
  if (roleAtLeast(access.role, 'editor') && access.workspaceRole !== 'guest') return true
  return exportAllowedForCaller(q, access, userId, await loadExportPolicy(q, access.board.id))
}

/**
 * The "keep sharing settings" duplicate (features/history): the copy gets the source's people grants,
 * so it gets the source's policy too, or the very viewers the owner limited could export the same
 * content from the copy. Runs right after the copy's row committed (history/new-board.ts owns that
 * transaction), before the route answers or anything announces the copy.
 */
export async function copyExportPolicy(
  q: Queryable,
  fromBoardId: string,
  to: { id: string; workspace_id: string },
  userId: string,
  at: Date,
): Promise<void> {
  await q.query(
    `INSERT INTO board_export_policies (board_id, workspace_id, policy, updated_by, updated_at)
     SELECT $1, $2, p.policy, $3, $4 FROM board_export_policies p
      WHERE p.board_id = $5 AND p.workspace_id = $2
     ON CONFLICT (board_id) DO NOTHING`,
    [to.id, to.workspace_id, userId, at, fromBoardId],
  )
}

export const exportDisabled = () => new ApiError(403, EXPORT_DISABLED_CODE, EXPORT_DISABLED_MESSAGE)

/** 403 EXPORT_DISABLED unless the caller may export (API routes; `access` already passed `view`). */
export async function requireExportAllowed(q: Queryable, access: BoardAccess, userId: string): Promise<void> {
  if (!(await mayExport(q, access, userId))) throw exportDisabled()
}

// ---- original files --------------------------------------------------------------------------------

/**
 * Fetch Metadata destinations of a media element (<img>, <video>, <audio>) loading its source. The
 * browser sets `Sec-Fetch-Dest` itself; page scripts cannot (fetch() and XHR send `empty`, a download or
 * a new tab `document`). A client outside a browser can send anything: like the setting itself, this
 * keeps honest browsers from downloading, it is not data protection.
 */
const MEDIA_DESTINATIONS = new Set(['image', 'video', 'audio'])

export function isMediaElementLoad(req: FastifyRequest): boolean {
  const dest = req.headers['sec-fetch-dest']
  return typeof dest === 'string' && MEDIA_DESTINATIONS.has(dest.toLowerCase())
}

/** What the file tables know about a version, as far as the canvas's choice depends on it. */
export interface CanvasVersionFacts {
  kind: AssetKind
  mimeType: string
  status: AssetStatus
  sizeBytes: number
  width: number | null
  height: number | null
  /** A still preview (a `thumb` or `display` derivative) the canvas can show instead. */
  hasStillPreview: boolean
}

/**
 * Whether the canvas (apps/web/src/assets/asset-store.ts resolveImageOrVideoUrl) loads this version's
 * ORIGINAL, rather than a preview, for a viewer who may not export (SEAM-10):
 * - a video: <video> plays the original;
 * - an image still being processed, when small (CANVAS_ORIGINAL_LIMITS.smallOriginalBytes);
 * - a ready image without a still preview (nothing else to show);
 * - a ready animated GIF within the animated limits (previews are single frames).
 * Never a still image that has a preview. Animated WebP is not here: only the uploading client knows it
 * is animated (a flag on the canvas asset), so for limited viewers the canvas shows its preview.
 * Only kinds and types the file routes serve inline, and never a failed version (an attachment).
 */
export function canvasRendersOriginal(v: CanvasVersionFacts): boolean {
  if (v.status === 'failed') return false
  if (v.kind !== 'image' && v.kind !== 'video') return false
  if (!INLINE_MIMES[v.kind].includes(v.mimeType)) return false
  if (v.kind === 'video') return true
  const L = CANVAS_ORIGINAL_LIMITS
  if (v.status !== 'ready') return v.sizeBytes <= L.smallOriginalBytes
  if (!v.hasStillPreview) return true
  if (v.mimeType !== 'image/gif' || v.sizeBytes > L.animatedMaxBytes) return false
  // Unknown dimensions: the canvas falls back to the asset's own, which the api cannot see.
  return v.width === null || v.height === null || v.width * v.height <= L.animatedMaxPixels
}

/**
 * The version as the board sees it (uploaded to this board, or linked to it), or null when the board
 * does not show it.
 */
async function versionOnBoard(
  q: Queryable,
  access: BoardAccess,
  assetId: string,
  versionId: string,
): Promise<CanvasVersionFacts | null> {
  const row = await q.maybeOne<{
    kind: AssetKind
    mime_type: string
    status: AssetStatus
    size_bytes: string | number
    width: number | null
    height: number | null
    has_still_preview: boolean
  }>(
    `SELECT v.kind, v.mime_type, v.status, v.size_bytes,
            CASE WHEN jsonb_typeof(v.probe->'width') = 'number' THEN (v.probe->>'width')::float8 END AS width,
            CASE WHEN jsonb_typeof(v.probe->'height') = 'number' THEN (v.probe->>'height')::float8 END AS height,
            EXISTS (SELECT 1 FROM asset_derivatives d
                     WHERE d.version_id = v.id AND d.role IN ('thumb', 'display')) AS has_still_preview
       FROM asset_versions v
      WHERE v.asset_id = $1 AND v.id = $2 AND v.workspace_id = $3
        AND (v.board_id = $4 OR EXISTS (
          SELECT 1 FROM board_asset_links l
           WHERE l.workspace_id = $3 AND l.board_id = $4 AND l.asset_id = $1 AND l.version_id = $2))`,
    [assetId, versionId, access.board.workspace_id, access.board.id],
  )
  if (!row) return null
  return {
    kind: row.kind,
    mimeType: row.mime_type,
    status: row.status,
    sizeBytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    hasStillPreview: row.has_still_preview,
  }
}

/**
 * `GET|HEAD /files/:ast/:ver/original?board=` for a caller who can view the board. Refused (false)
 * only when exporting is off for them AND the request is a download: anything but a media element
 * loading a version the canvas renders from its original (canvasRendersOriginal). Previews and PDF
 * pages (derivatives) are never asked about: they always render.
 */
export async function originalDownloadAllowed(
  q: Queryable,
  req: FastifyRequest,
  access: BoardAccess,
  userId: string,
): Promise<boolean> {
  if (await mayExport(q, access, userId)) return true
  if (!isMediaElementLoad(req)) return false
  const { ast, ver } = (req.params ?? {}) as { ast?: unknown; ver?: unknown }
  if (typeof ast !== 'string' || typeof ver !== 'string') return false
  const version = await versionOnBoard(q, access, ast, ver)
  return version !== null && canvasRendersOriginal(version)
}
