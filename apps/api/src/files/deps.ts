// Boundary between the file routes (apps/api/src/files/**) and the rest of the API.
// The API core supplies `authorize`; the file routes never read sessions or ACL tables themselves.
// Metadata lives in Postgres (packages/db 0007_assets) and bytes in the blob store (M3 §2–§3).

import type { Db } from '@draftroom/db'
import type { FastifyRequest } from 'fastify'
import { DEFAULT_UPLOAD_LIMITS } from '../config.ts'
import type { BlobStore } from './blobs.ts'
import { DEFAULT_STORAGE_CONFIG } from './storage-config.ts'

export type FileAction = 'view' | 'edit'

export type FileAuthorization =
  /** `workspaceId`: the board's workspace (a new upload's row carries it). */
  | { ok: true; userId: string; workspaceId: string }
  /** 401 = not signed in; 404 = cannot view the board (never reveal it exists); 403 = can view but not edit. */
  | { ok: false; status: 401 | 403 | 404 }

/** A version whose row names another board than the one in the request. */
export interface FileAssetRef {
  assetId: string
  versionId: string
  /** asset_versions.board_id: the board the version was uploaded to. */
  ownerBoardId: string
}

export interface FileAuthorizer {
  (req: FastifyRequest, boardId: string, action: FileAction): Promise<FileAuthorization>
  /**
   * Optional (history feature, packages/db 0003_history): may `boardId` also serve this version of
   * another board's asset (a board made from content that showed it)? Asked only for reads, after
   * `authorize(req, boardId, 'view')` succeeded. Absent = never (another board's asset is a 404).
   */
  linkedAsset?(req: FastifyRequest, boardId: string, asset: FileAssetRef): Promise<boolean>
}

/**
 * Upload limits (docs/SECURITY-REVIEW-2026-09-27.md FC-1). The byte quota covers everything the board's
 * workspace stores (originals, their previews and board thumbnails: usage.ts), the file cap its
 * uploaded versions, whoever uploaded them; the rate limit counts upload attempts per signed-in user,
 * never per IP. SEAM-02: a name-only guest (no account) is also held to `guestQuota`, over the
 * originals they uploaded to that workspace, so one anonymous workshop guest cannot fill it for everyone.
 */
export interface UploadPolicy {
  workspaceQuota: { maxBytes: number; maxFiles: number }
  perUser: { max: number; timeWindow: number }
  /** Per name-only guest per workspace; default DEFAULT_STORAGE_CONFIG.guestQuota (1 GB, 200 files). */
  guestQuota?: { maxBytes: number; maxFiles: number }
}

/** Used when the host passes no policy: the same staging defaults as the API's config. */
export const DEFAULT_UPLOAD_POLICY: Readonly<UploadPolicy> = {
  workspaceQuota: {
    maxBytes: DEFAULT_UPLOAD_LIMITS.workspaceQuotaBytes,
    maxFiles: DEFAULT_UPLOAD_LIMITS.workspaceMaxFiles,
  },
  perUser: { max: DEFAULT_UPLOAD_LIMITS.perUserPerMinute, timeWindow: 60_000 },
  guestQuota: DEFAULT_STORAGE_CONFIG.guestQuota,
}

export interface FilesDeps {
  db: Db
  blobs: BlobStore
  authorize: FileAuthorizer
  /** Clock for row timestamps and the upload rate limit (tests); default `new Date()`. */
  now?: () => Date
  /** Quota and rate limit; default DEFAULT_UPLOAD_POLICY (never unlimited). */
  uploads?: UploadPolicy
}
