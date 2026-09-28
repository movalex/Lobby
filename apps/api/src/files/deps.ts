// Boundary between the file routes (apps/api/src/files/**) and the rest of the API.
// The API core supplies `authorize`; the file routes never read sessions or ACL tables themselves.
// Metadata lives in Postgres (packages/db 0007_assets) and bytes in the blob store (M3 §2–§3).

import type { Db } from '@draftroom/db'
import type { FastifyRequest } from 'fastify'
import type { BlobStore } from './blobs.ts'

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

export interface FilesDeps {
  db: Db
  blobs: BlobStore
  authorize: FileAuthorizer
  /** Clock for row timestamps (tests); default `new Date()`. */
  now?: () => Date
}
