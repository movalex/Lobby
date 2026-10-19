// OWNER: WS2 (wave W, background removal). docs/WAVE-W-CONTRACTS.md §4.1 step 3: the `remove-bg` kind's work on the api,
// inside the shared ops state machine (worker/ops-jobs.ts), registered in worker/ops-kinds.ts OP_KINDS.
//
//   checkOutput  one `original` per attempt: a PNG, at most REMOVE_BG_LIMITS.maxOutputEdge on each side and
//                maxOutputBytes; anything else is refused (400) before a key is handed out.
//   acceptText   never (400): remove-bg has no text.
//   complete     in the op's complete transaction, under its lease: exactly that one published PNG and a
//                RemoveBgResult that agrees with it; the requester still exists and may still edit the board, the
//                board is still active (else 409 CANCELLED); the workspace still has room for the PNG (else 409
//                QUOTA_EXCEEDED: the quota may have filled up while the worker ran); then a NEW asset and version
//                (the output's ids, kind image, image/png, `noBackgroundName(<source name>)`, board_id = the op's
//                board, uploaded_by = the requester, derived_from_version_id = the source) and its preview job, so
//                thumbnails and the display image come from the normal pipeline. The worker reads a 409 with one of
//                those op codes as the op's end (apps/worker ops/loop.ts), so the requester is told why.
//
// The new version is announced after COMMIT (`assets.version`, the op's requester gets `file.op`): worker/ops-routes.ts.
// The sha256 is the worker's (it computed it over the bytes it PUT; the blob's size was verified by completeOp). Never
// base64: the result exists only as a stored blob under its own `ver_` id.

import {
  noBackgroundName,
  REMOVE_BG_LIMITS,
  RemoveBgResult,
  type WorkerOpOutputInput,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { PREVIEW_PROFILE } from '@draftroom/dev-assets'
import { can } from '@draftroom/permissions'
import { loadBoardAccess } from '../../../access.ts'
import { DEFAULT_UPLOAD_LIMITS } from '../../../config.ts'
import { EMPTY_PROBE } from '../../../files/meta.ts'
import { workspaceUsage } from '../../../files/usage.ts'
// Types only: worker/ops-kinds.ts registers this kind (its OP_KINDS imports this module), so a value import back would
// be a cycle that breaks whichever module loads first; OpRefused is loaded when a refusal is made (refuse() below).
import type { LockedOp, OpCompletion, OpKindHandler, PublishedOutput } from '../../../worker/ops-kinds.ts'

/**
 * The workspace quota the completer re-checks (the upload route's: DRAFTROOM_WORKSPACE_QUOTA_MB and
 * DRAFTROOM_WORKSPACE_MAX_FILES). OP_KINDS is a static registry, so the api's config reaches it here: set by
 * registerRemoveBackground (./index.ts) when the routes register, from the same ApiConfig the upload route reads.
 */
export const removeBgQuota: { maxBytes: number; maxFiles: number } = {
  maxBytes: DEFAULT_UPLOAD_LIMITS.workspaceQuotaBytes,
  maxFiles: DEFAULT_UPLOAD_LIMITS.workspaceMaxFiles,
}

/** Whether one more file of `bytes` fits the workspace (the upload rule: files + 1 and used + bytes). */
export async function hasRoom(q: Queryable, workspaceId: string, bytes: number): Promise<boolean> {
  const usage = await workspaceUsage(q, workspaceId)
  return usage.files + 1 <= removeBgQuota.maxFiles && usage.used + bytes <= removeBgQuota.maxBytes
}

/** An OpRefused (a 4xx with a stable code to the worker). */
async function refuse(code: string, message: string, status = 400): Promise<Error> {
  const { OpRefused } = await import('../../../worker/ops-kinds.ts')
  return new OpRefused(status, code, message)
}

export const removeBgKind: OpKindHandler = {
  kind: 'remove-bg',

  async checkOutput(tx: Queryable, op: LockedOp, input: WorkerOpOutputInput): Promise<void> {
    if (input.role !== 'original' || input.mimeType !== 'image/png')
      throw await refuse('OUTPUT_NOT_ALLOWED', 'Background removal makes one PNG original.')
    if (
      input.width > REMOVE_BG_LIMITS.maxOutputEdge ||
      input.height > REMOVE_BG_LIMITS.maxOutputEdge ||
      input.bytes > REMOVE_BG_LIMITS.maxOutputBytes
    )
      throw await refuse('OUTPUT_TOO_LARGE', 'The result is larger than background removal allows.')
    const { n } = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM worker_op_outputs WHERE op_id = $1 AND attempt = $2 AND role = 'original'`,
      [op.id, op.attempt],
    )
    if (n >= 1) throw await refuse('OUTPUT_NOT_ALLOWED', 'Background removal makes one PNG original.')
  },

  async acceptText(): Promise<void> {
    throw await refuse('TEXT_NOT_ALLOWED', 'Background removal has no text.')
  },

  async complete(
    tx: Queryable,
    op: LockedOp,
    done: { outputs: PublishedOutput[]; result: Record<string, unknown>; now: Date },
  ): Promise<OpCompletion> {
    const [out, ...more] = done.outputs
    if (!out || more.length || out.role !== 'original' || out.mimeType !== 'image/png')
      throw await refuse('BAD_OUTPUT', 'Background removal completes with its one PNG.')
    const parsed = RemoveBgResult.safeParse(done.result)
    if (
      !parsed.success ||
      parsed.data.width !== out.width ||
      parsed.data.height !== out.height ||
      parsed.data.bytes !== out.bytes
    )
      throw await refuse('BAD_RESULT', 'The result does not match its PNG.')
    const result = parsed.data

    const cancelled = () => refuse('CANCELLED', 'The board or its editor changed: nothing was made.', 409)
    if (!op.requestedBy) throw await cancelled()
    const access = await loadBoardAccess(tx, op.boardId, op.requestedBy)
    if (access?.board.status !== 'active' || !can(access.role, 'edit', access.board.status))
      throw await cancelled()

    const source = await tx.maybeOne<{ name: string }>(
      'SELECT name FROM asset_versions WHERE id = $1 AND workspace_id = $2',
      [op.sourceVersionId, op.workspaceId],
    )
    if (!source) throw await cancelled()

    // serializes this workspace's quota decisions with the upload route (NO KEY: boards and members are not blocked)
    await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [op.workspaceId])
    if (!(await hasRoom(tx, op.workspaceId, out.bytes)))
      throw await refuse('QUOTA_EXCEEDED', 'This workspace is out of storage.', 409)

    await tx.query(
      `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
         size_bytes, sha256, uploaded_by, status, attempts, probe, created_at, updated_at, derived_from_version_id)
       VALUES ($1, $2, $3, $4, $5, 'image/png', 'image/png', 'image', $6, $7, $8, 'queued', 0, $9::jsonb, $10, $10,
               $11)`,
      [
        out.versionId,
        out.assetId,
        op.workspaceId,
        op.boardId,
        noBackgroundName(source.name),
        out.bytes,
        result.sha256,
        op.requestedBy,
        JSON.stringify(EMPTY_PROBE),
        done.now,
        op.sourceVersionId,
      ],
    )
    await tx.query(
      `INSERT INTO preview_jobs (version_id, profile, status, attempts, run_after, created_at, updated_at)
       VALUES ($1, $2, 'queued', 0, $3, $3, $3)`,
      [out.versionId, PREVIEW_PROFILE, done.now],
    )
    return {
      result,
      resultVersionId: out.versionId,
      versionChanges: [
        { versionId: out.versionId, assetId: out.assetId, boardId: op.boardId, workspaceId: op.workspaceId },
      ],
    }
  },
}
