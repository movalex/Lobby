// OWNER: WS1 (wave S; the signature is the foundation's contract with WS2, docs/WAVE-S-CONTRACTS.md §3.1). The one
// review step another workstream's code runs inside its own transaction.
//
// resetForNewVersion: WS2's upload with X-Lobby-Supersedes calls it in the upload's one transaction, after the new
// version row is inserted: every live review item on the asset whose status is not 'pending' goes back to 'pending'
// (event reason 'new_version', actor = the uploader, version = the new one), with the notifications and chat outbox
// rows of the reset in the same transaction (ONE notification per recipient for the whole reset). It returns the
// items it changed so the caller can publish REVIEW_ITEM_EVENT for each after COMMIT (never before).
//
// Until WS1 implements it, it changes nothing and returns []: no review item can exist while the review routes are
// pending, and the foundation's upload ignores the header anyway.

import type { ReviewItem } from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'

export interface NewVersionReset {
  workspaceId: string
  assetId: string
  /** the new version (what the reset events record) */
  versionId: string
  /** the uploader: the session's user (its kind and name are read from users in the same transaction) */
  actorId: string
}

/** Resets the asset's live, non-pending review items to pending. Runs in the caller's transaction (`tx`). */
export async function resetForNewVersion(_tx: Queryable, _reset: NewVersionReset): Promise<ReviewItem[]> {
  return []
}
