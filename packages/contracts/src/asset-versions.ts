// Wave S, versions of a deliverable (docs/WAVE-S-CONTRACTS.md §3; migration 0037 asset_versions.supersedes). OWNER:
// WS2 after the wave S foundation, which froze this file: change it through the lead.
//
//   POST /api/boards/:bid/assets  + header X-Lobby-Supersedes: ver_…  (dev-assets SUPERSEDES_HEADER; edit)
//        a NEW VERSION of the superseded version's asset (same asset id, supersedes = that version), in the upload's
//        one transaction. Without the header: today's fresh asset. Refusals: the superseded version is not servable
//        on this board → 404 (no probing); not the newest servable version of its asset → 409 VERSION_NOT_LATEST
//        {latestVersionId}; an image superseding a non-image or the other way round → 400 VERSION_KIND_MISMATCH. The
//        chain is linear (UNIQUE supersedes): of two people superseding v3 at once, the second gets 409. Review items
//        on the asset are reset to pending in the same transaction (review.ts reason new_version), and the board event
//        ASSET_VERSION_EVENT goes out after COMMIT.
//   GET  /api/boards/:bid/asset-versions/:ast   → 200 ListAssetVersionsResponse (view)
//        the versions of the asset that are servable on this board (files-auth.ts: uploaded to it, or linked to it),
//        oldest first. A separate path, so the files plugin's /api/boards/:bid/assets/:ast/:ver routes and their 405
//        catch-alls are untouched.
//
// Until WS2 ships: the header is IGNORED by the upload (an upload that sends it makes a fresh asset, exactly what an
// api before wave S does; the web treats a fresh asset as "the chain starts again at v1"), and the list route is
// pending (404 like an unknown route). The file collector already keeps whole chains and comment-pinned versions
// (apps/api/src/files/gc.ts, landed by the foundation), so no build that writes chains can lose old versions.
//
// Do not import values from ./index.ts here: index.ts re-exports this module.

import { z } from 'zod'
import { ReviewActor } from './review.ts'
import { ReviewStatus } from './review-status.ts'

const prefixed = (p: string) => z.string().regex(new RegExp(`^${p}_[0-9A-Za-z]{10,40}$`))
const AssetIdLike = prefixed('ast')
const VersionIdLike = prefixed('ver')
const isoDate = z.string()

export const ASSET_VERSION_KINDS = ['image', 'pdf', 'video', 'other'] as const
export const ASSET_VERSION_STATUSES = ['queued', 'processing', 'ready', 'failed'] as const

/**
 * Whether a version of kind `next` may supersede one of kind `previous`: images replace images, anything else
 * replaces anything but an image (the web's Replace media rule, file-card/ported/edit-media.tsx replaceRefusal).
 */
export function versionKindsCompatible(
  previous: (typeof ASSET_VERSION_KINDS)[number],
  next: (typeof ASSET_VERSION_KINDS)[number],
): boolean {
  return (previous === 'image') === (next === 'image')
}

/** One version as the list shows it. `n` is 1-based among the versions servable on THIS board. */
export const AssetVersionEntry = z.object({
  n: z.number().int().min(1),
  versionId: VersionIdLike,
  /** the version it superseded (null: the first of its chain, or its predecessor is gone) */
  supersedes: VersionIdLike.nullable(),
  name: z.string(),
  kind: z.enum(ASSET_VERSION_KINDS),
  sizeBytes: z.number().int().min(0),
  uploadedBy: ReviewActor,
  createdAt: isoDate,
  status: z.enum(ASSET_VERSION_STATUSES),
  pageCount: z.number().int().min(1).nullable(),
  durationMs: z.number().int().min(0).nullable(),
  /** the threads pinned to this version (comments.ts asset anchors), as the caller may see them */
  threads: z.object({ open: z.number().int().min(0), resolved: z.number().int().min(0) }),
  /** the last status a review item gave this version, when one did */
  review: z.object({ status: ReviewStatus, by: ReviewActor, at: isoDate }).nullable(),
})
export type AssetVersionEntry = z.infer<typeof AssetVersionEntry>

export const ListAssetVersionsResponse = z.object({
  assetId: AssetIdLike,
  versions: z.array(AssetVersionEntry),
  /** the newest servable version (what a status must be about, and what "Upload new version" supersedes) */
  latestVersionId: VersionIdLike,
})
export type ListAssetVersionsResponse = z.infer<typeof ListAssetVersionsResponse>

export const ASSET_VERSION_CODES = {
  /** 409: the superseded version is not the newest servable one (the body carries latestVersionId) */
  notLatest: 'VERSION_NOT_LATEST',
  /** 400: an image for a non-image, or the other way round */
  kindMismatch: 'VERSION_KIND_MISMATCH',
  /** 400: the header is not one version id */
  badHeader: 'INVALID_SUPERSEDES',
} as const

export const VersionNotLatestBody = z.object({
  error: z.object({ code: z.literal(ASSET_VERSION_CODES.notLatest), message: z.string() }),
  latestVersionId: VersionIdLike,
})

/** Board event after a new version's COMMIT: open tabs refresh the version chips of cards showing the asset. */
export const ASSET_VERSION_EVENT = 'asset.version'
export const AssetVersionEvent = z.object({ assetId: AssetIdLike, versionId: VersionIdLike })

export const ASSET_VERSION_ROUTES = { list: '/api/boards/:bid/asset-versions/:ast' } as const
export const ASSET_VERSION_ROUTE_KEYS = [`GET ${ASSET_VERSION_ROUTES.list}`] as const
export const assetVersionsPath = (bid: string, ast: string) =>
  `/api/boards/${encodeURIComponent(bid)}/asset-versions/${encodeURIComponent(ast)}`

// ---- media comments (WS3): the rules the api checks on an `asset` anchor (comments.ts) -----------------------------

export const MEDIA_COMMENT_RULES = {
  /** a timeMs may run past the probed duration by this much (rounding of the probe and the player) */
  timeSlackMs: 1_000,
  /** the frame step when the probe has no frame rate */
  defaultFrameRate: 25,
  /** the code of every refused asset anchor or spot (400) */
  invalidAnchor: 'INVALID_ANCHOR',
} as const
