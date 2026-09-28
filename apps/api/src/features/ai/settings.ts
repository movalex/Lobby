// AI on or off per board, with a workspace default (reviewer finding DANA-04; migration 0018_ai_settings).
//
//   PUT /api/boards/:bid/ai/settings          { enabled: boolean | null } → AiSettings (board owners)
//   PUT /api/workspaces/:wid/ai/settings      { enabled: boolean }        → { enabled } (owners, admins)
//
// - The board's own choice wins; without one the workspace default applies; without that, AI is on.
// - Board owners decide for a board (manage_access: workspace owners and admins resolve to owner), like
//   every other sharing setting; workspace owners and admins decide the default. Name-only guests never.
// - The AI routes (index.ts) read the effective setting for every status and every call, and refuse a
//   call on a board where AI is off (403 AI_BOARD_OFF) before anything is read or sent.
// - A change publishes `ai.settings` (no payload: a hint) to the board, or to every board of the
//   workspace, after it committed, so open clients re-read their AiStatus and hide or show AI at once.

import {
  AI_SETTINGS_EVENT,
  type AiSettings,
  PutAiBoardSettingsInput,
  PutAiWorkspaceSettingsInput,
} from '@draftroom/contracts'
import type { Queryable } from '@draftroom/db'
import { can, canManageWorkspace } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { type BoardAccess, requireBoardAction, requireWorkspaceRole } from '../../access.ts'
import { userKind } from '../../auth/users.ts'
import type { Params } from '../../context.ts'
import { forbidden, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { guestRefused } from '../guests/guard.ts'

/** Owners flipping the switch back and forth: generous, but not a firehose of board events. */
const PUT_RATE = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } }
/** pg_advisory_xact_lock namespace (the two-key form) of one workspace's AI default ("DRAS"). */
export const AI_SETTINGS_LOCK_NS = 0x44524153

export interface AiSwitches {
  board: boolean | null
  workspaceDefault: boolean
}

export const aiOn = (s: AiSwitches) => s.board ?? s.workspaceDefault

/** The board's own choice and its workspace default (no rows: null and on). */
export async function loadAiSwitches(q: Queryable, board: BoardAccess['board']): Promise<AiSwitches> {
  const row = await q.one<{ board: boolean | null; workspace: boolean | null }>(
    `SELECT (SELECT enabled FROM board_ai_settings WHERE board_id = $1) AS board,
            (SELECT enabled FROM workspace_ai_settings WHERE workspace_id = $2) AS workspace`,
    [board.id, board.workspace_id],
  )
  return { board: row.board, workspaceDefault: row.workspace ?? true }
}

export function settingsFor(access: BoardAccess, s: AiSwitches): AiSettings {
  return {
    board: s.board,
    workspaceDefault: s.workspaceDefault,
    on: aiOn(s),
    canManageBoard: can(access.role, 'manage_access', access.board.status),
    canManageWorkspace: canManageWorkspace(access.workspaceRole),
  }
}

const GUEST_MESSAGE = 'Only people with a Lobby account can change AI settings.'

export function registerAiSettings(app: FastifyInstance, ctx: FeatureContext): void {
  const { db } = ctx
  const hint = (boardId: string) => ctx.events.publish(boardId, { type: AI_SETTINGS_EVENT, data: {} })

  app.put('/api/boards/:bid/ai/settings', PUT_RATE, async (req): Promise<AiSettings> => {
    const user = await ctx.requireUser(req)
    const { bid = '' } = req.params as Params
    const input = parse(PutAiBoardSettingsInput, req.body)
    const { access, before, after } = await db.transaction(async (tx) => {
      // 404 for people who cannot see the board, 403 for everyone below owner.
      const access = await requireBoardAction(tx, bid, user.id, 'manage_access', { forUpdate: true })
      if ((await userKind(tx, user.id)) === 'guest') throw guestRefused(GUEST_MESSAGE)
      const before = await loadAiSwitches(tx, access.board)
      if (input.enabled === null)
        await tx.query('DELETE FROM board_ai_settings WHERE board_id = $1', [access.board.id])
      else
        await tx.query(
          `INSERT INTO board_ai_settings (board_id, workspace_id, enabled, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (board_id) DO UPDATE
             SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
          [access.board.id, access.board.workspace_id, input.enabled, user.id, ctx.now()],
        )
      return { access, before, after: { ...before, board: input.enabled } }
    })
    if (aiOn(before) !== aiOn(after) || before.board !== after.board) hint(access.board.id)
    return settingsFor(access, after)
  })

  app.put('/api/workspaces/:wid/ai/settings', PUT_RATE, async (req): Promise<{ enabled: boolean }> => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const input = parse(PutAiWorkspaceSettingsInput, req.body)
    // AIPV-05: one transaction, serialized per workspace, so two admins changing the default at once
    // each compare against the value the other committed (and the one whose change flips it publishes).
    // An advisory lock rather than a row lock: the row may not exist yet. Taken before any row lock.
    const toHint = await db.transaction(async (tx) => {
      const role = await requireWorkspaceRole(tx, wid, user.id)
      if (!canManageWorkspace(role)) throw forbidden('Only workspace owners and admins can change this.')
      await tx.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2::text))', [AI_SETTINGS_LOCK_NS, wid])
      const previous = await tx.maybeOne<{ enabled: boolean }>(
        'SELECT enabled FROM workspace_ai_settings WHERE workspace_id = $1',
        [wid],
      )
      await tx.query(
        `INSERT INTO workspace_ai_settings (workspace_id, enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id) DO UPDATE
           SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [wid, input.enabled, user.id, ctx.now()],
      )
      if ((previous?.enabled ?? true) === input.enabled) return []
      // Boards without their own choice change with it; the hint costs nothing on a board nobody has open.
      const boards = await tx.query<{ id: string }>(
        `SELECT b.id FROM boards b
          WHERE b.workspace_id = $1 AND b.status <> 'trashed'
            AND NOT EXISTS (SELECT 1 FROM board_ai_settings s WHERE s.board_id = b.id)`,
        [wid],
      )
      return boards.rows.map((b) => b.id)
    })
    // After the commit, so a client that re-reads on the hint sees the new default.
    for (const id of toHint) hint(id)
    return { enabled: input.enabled }
  })
}
