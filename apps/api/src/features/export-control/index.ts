// Feature module: export-control (docs/WAVE3-CONTRACTS.md): the per-board "viewers can export and
// download" policy. Board owners change it in the Share dialog; everyone who can view the board reads
// it (and whether it limits them). A change publishes `export-control.policy` after it committed, so
// open clients hide or show their export, copy and download entries without a reload.
//
// Enforcement lives with the routes it protects, through ./policy.ts: original file downloads
// (files-auth.ts), the board archive, duplicate and restore-as-new (features/history).

import {
  EXPORT_CONTROL_EVENTS,
  type ExportPolicy,
  type ExportPolicyEvent,
  type ExportPolicyState,
  PutExportPolicyInput,
} from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { requireBoardAction } from '../../access.ts'
import type { Params } from '../../context.ts'
import { parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { exportAllowedForCaller, loadExportPolicy, loadExportPolicyRow } from './policy.ts'

/** Owners flipping the checkbox back and forth: generous, but not a firehose of board events. */
const PUT_RATE = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }

export async function registerExportControl(app: FastifyInstance, ctx: FeatureContext): Promise<void> {
  const { db } = ctx

  app.get('/api/boards/:bid/export-policy', async (req): Promise<ExportPolicyState> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const access = await requireBoardAction(db, bid, user.id, 'view')
    const { policy: exportPolicy, set } = await loadExportPolicyRow(db, access.board.id)
    return {
      exportPolicy,
      canExport: await exportAllowedForCaller(db, access, user.id, exportPolicy),
      policySet: set,
    }
  })

  app.put('/api/boards/:bid/export-policy', PUT_RATE, async (req): Promise<ExportPolicyState> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(PutExportPolicyInput, req.body)
    // manage_access = board owners (workspace owners and admins resolve to owner), like every other
    // sharing setting. The row lock serializes two owners changing it at once.
    const { previous, access } = await db.transaction(async (tx) => {
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      const previous = await loadExportPolicy(tx, access.board.id)
      await tx.query(
        `INSERT INTO board_export_policies (board_id, workspace_id, policy, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (board_id) DO UPDATE
           SET policy = EXCLUDED.policy, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [access.board.id, access.board.workspace_id, input.exportPolicy, user.id, ctx.now()],
      )
      return { previous, access }
    })
    // After the commit; nothing to tell anyone when nothing changed.
    if (previous !== input.exportPolicy) publishExportPolicy(ctx, access.board.id, input.exportPolicy)
    return {
      exportPolicy: input.exportPolicy,
      canExport: await exportAllowedForCaller(db, access, user.id, input.exportPolicy),
      policySet: true,
    }
  })
}

/**
 * The board's policy only: the same, safe payload for every viewer of the board. After the change
 * committed (a PUT here, or a client link that set it: dashboard/review-links.ts).
 */
export function publishExportPolicy(ctx: FeatureContext, boardId: string, exportPolicy: ExportPolicy) {
  const data: ExportPolicyEvent = { exportPolicy }
  ctx.events.publish(boardId, { type: EXPORT_CONTROL_EVENTS.policy, data })
}
