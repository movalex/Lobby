// The per-board export policy (docs/WAVE3-CONTRACTS.md "export-control"), read by every route that
// enforces it: original file downloads (files-auth.ts), the board archive, duplicate and restore-as-new
// (features/history). One place decides, so the routes cannot drift apart.
//
// Rule (packages/contracts exportAllowedFor): with policy 'editors', a caller whose board role is below
// editor (viewers, commenters, guests on review links) is refused. Owners and editors never are, and
// neither is anyone on a board with policy 'everyone' (the default: no row).

import {
  DEFAULT_EXPORT_POLICY,
  EXPORT_DISABLED_CODE,
  EXPORT_DISABLED_MESSAGE,
  type ExportPolicy,
  exportAllowedFor,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import type { AssetKind, AssetStatus } from '@draftroom/dev-assets'
import { roleAtLeast } from '@draftroom/permissions'
import type { FastifyRequest } from 'fastify'
import type { BoardAccess } from '../../access.ts'
import { ApiError } from '../../errors.ts'
import { INLINE_MIMES } from '../../files/mime.ts'

/** The board's policy ('everyone' when its owner never changed it). */
export async function loadExportPolicy(q: Queryable, boardId: string): Promise<ExportPolicy> {
  const row = await q.maybeOne<{ policy: ExportPolicy }>(
    'SELECT policy FROM board_export_policies WHERE board_id = $1',
    [boardId],
  )
  return row?.policy ?? DEFAULT_EXPORT_POLICY
}

/** Whether the caller behind `access` may export, copy and download on that board. */
export async function mayExport(q: Queryable, access: BoardAccess): Promise<boolean> {
  // Owners and editors are never limited: no query needed.
  if (roleAtLeast(access.role, 'editor')) return true
  return exportAllowedFor(access.role, await loadExportPolicy(q, access.board.id))
}

export const exportDisabled = () => new ApiError(403, EXPORT_DISABLED_CODE, EXPORT_DISABLED_MESSAGE)

/** 403 EXPORT_DISABLED unless the caller may export (API routes; `access` already passed `view`). */
export async function requireExportAllowed(q: Queryable, access: BoardAccess): Promise<void> {
  if (!(await mayExport(q, access))) throw exportDisabled()
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

/**
 * Whether a version is one the board itself renders from its original (its uploaded board or a board
 * linked to it): a video (<video> plays the original), or an image shown before or instead of its
 * previews (an animated GIF, a small image still processing, one without usable previews). Only kinds
 * and types the file routes serve inline, and never a failed version (served as an attachment).
 */
async function rendersFromOriginal(
  q: Queryable,
  access: BoardAccess,
  assetId: string,
  versionId: string,
): Promise<boolean> {
  const row = await q.maybeOne<{ kind: AssetKind; mime_type: string; status: AssetStatus }>(
    `SELECT v.kind, v.mime_type, v.status FROM asset_versions v
      WHERE v.asset_id = $1 AND v.id = $2 AND v.workspace_id = $3
        AND (v.board_id = $4 OR EXISTS (
          SELECT 1 FROM board_asset_links l
           WHERE l.workspace_id = $3 AND l.board_id = $4 AND l.asset_id = $1 AND l.version_id = $2))`,
    [assetId, versionId, access.board.workspace_id, access.board.id],
  )
  if (!row || row.status === 'failed') return false
  if (row.kind !== 'image' && row.kind !== 'video') return false
  return INLINE_MIMES[row.kind].includes(row.mime_type)
}

/**
 * `GET|HEAD /files/:ast/:ver/original?board=` for a caller who can view the board. Refused (false)
 * only when exporting is off for them AND the request is a download: anything but a media element
 * loading an image or video the canvas renders from its original. Previews and PDF pages (derivatives)
 * are never asked about: they always render.
 */
export async function originalDownloadAllowed(
  q: Queryable,
  req: FastifyRequest,
  access: BoardAccess,
): Promise<boolean> {
  if (await mayExport(q, access)) return true
  if (!isMediaElementLoad(req)) return false
  const { ast, ver } = (req.params ?? {}) as { ast?: unknown; ver?: unknown }
  if (typeof ast !== 'string' || typeof ver !== 'string') return false
  return rendersFromOriginal(q, access, ast, ver)
}
