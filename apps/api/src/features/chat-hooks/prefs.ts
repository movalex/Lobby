// A person's own choices (wave R, WS2; contracts chat-hooks.ts; docs/WAVE-R-CONTRACTS.md §4.1, §4.4):
//
//   GET /api/me/chat-prefs?workspace=   the workspace's hooks (a name and a provider: no hint, no URL) and the caller's kinds
//   PUT /api/me/chat-prefs              the caller's whole choice for one workspace
//
// For members of the workspace with an account (owner, admin, member): a name-only guest is refused (guests/guard.ts) and
// so is a workspace `guest`, who is not shown the names of the team's channels. Everything is off until the person turns
// a kind on for a hook (no row, nothing sent). A hook left out of a PUT, or sent with no kinds, loses the person's row.
// The row goes with the person's membership and with the hook (0036's foreign keys).

import {
  CHAT_HOOK_GUESTS_MESSAGE,
  CHAT_HOOK_KINDS,
  CHAT_HOOK_ROUTES,
  type ChatHookKind,
  ChatPrefsQuery,
  type ChatPrefsResponse,
  PutChatPrefsInput,
} from '@draftroom/contracts'
import { pgErrorCode, type Queryable } from '@draftroom/db'
import { requireWorkspaceRole } from '../../access.ts'
import type { SessionUser } from '../../auth/session.ts'
import { badRequest, forbidden, notFound, parse } from '../../errors.ts'
import { guestRefused } from '../guests/guard.ts'
import { type ChatRouteEnv, chatRoute, requireBox } from './routes.ts'

const MEMBERS_ONLY = 'Chat notifications are for members of this workspace.'
const FOREIGN_KEY_VIOLATION = '23503'
const DEADLOCK_DETECTED = '40P01'

async function requireMember(q: Queryable, workspaceId: string, user: SessionUser): Promise<void> {
  if (user.kind === 'guest') throw guestRefused(CHAT_HOOK_GUESTS_MESSAGE)
  const role = await requireWorkspaceRole(q, workspaceId, user.id)
  if (role === 'guest') throw forbidden(MEMBERS_ONLY)
}

const ORDER = new Map<string, number>(CHAT_HOOK_KINDS.map((k, i) => [k, i]))

/** The workspace's hooks and the person's choices in it. */
export async function prefsOf(q: Queryable, workspaceId: string, userId: string): Promise<ChatPrefsResponse> {
  const hooks = await q.query<{
    id: string
    name: string
    provider: 'slack' | 'teams'
    disabled_at: Date | null
  }>('SELECT id, name, provider, disabled_at FROM chat_hooks WHERE workspace_id = $1 ORDER BY created_at, id', [
    workspaceId,
  ])
  const prefs = await q.query<{ hook_id: string; kinds: ChatHookKind[] }>(
    'SELECT hook_id, kinds FROM chat_hook_prefs WHERE user_id = $1 AND workspace_id = $2 ORDER BY hook_id',
    [userId, workspaceId],
  )
  return {
    hooks: hooks.rows.map((h) => ({
      id: h.id,
      name: h.name,
      provider: h.provider,
      disabled: h.disabled_at !== null,
    })),
    prefs: prefs.rows
      .filter((p) => p.kinds.length > 0)
      .map((p) => ({
        hookId: p.hook_id,
        kinds: [...p.kinds].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0)),
      })),
  }
}

export function registerPrefRoutes(env: ChatRouteEnv): void {
  const { ctx } = env
  const { db, now } = ctx

  chatRoute(env, 'GET', CHAT_HOOK_ROUTES.prefs, async (req): Promise<ChatPrefsResponse> => {
    const user = await ctx.requireUser(req)
    requireBox(env)
    const { workspace } = parse(ChatPrefsQuery, req.query ?? {})
    await requireMember(db, workspace, user)
    return prefsOf(db, workspace, user.id)
  })

  chatRoute(env, 'PUT', CHAT_HOOK_ROUTES.prefs, async (req): Promise<ChatPrefsResponse> => {
    const user = await ctx.requireUser(req)
    requireBox(env)
    const input = parse(PutChatPrefsInput, req.body)
    const wid = input.workspaceId
    await requireMember(db, wid, user)
    const at = now()
    try {
      await db.transaction(async (tx) => {
        // the hooks must be this workspace's
        const known = await tx.query<{ id: string }>(
          `SELECT id FROM chat_hooks
            WHERE workspace_id = $1 AND id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
          [wid, JSON.stringify(input.prefs.map((p) => p.hookId))],
        )
        if (known.rows.length !== input.prefs.length)
          throw badRequest('hookId: no such chat hook in this workspace')
        const keep = input.prefs.filter((p) => p.kinds.length > 0)
        await tx.query(
          `DELETE FROM chat_hook_prefs
            WHERE user_id = $1 AND workspace_id = $2
              AND hook_id NOT IN (SELECT jsonb_array_elements_text($3::jsonb))`,
          [user.id, wid, JSON.stringify(keep.map((p) => p.hookId))],
        )
        for (const p of keep)
          await tx.query(
            `INSERT INTO chat_hook_prefs (user_id, workspace_id, hook_id, kinds, updated_at)
             VALUES ($1, $2, $3, ARRAY(SELECT jsonb_array_elements_text($4::jsonb)), $5)
             ON CONFLICT (user_id, hook_id)
             DO UPDATE SET kinds = EXCLUDED.kinds, updated_at = EXCLUDED.updated_at`,
            [user.id, wid, p.hookId, JSON.stringify(p.kinds), at],
          )
      })
    } catch (e) {
      // the person left the workspace between the check and the write (the membership foreign key; or the removal's
      // cascade and this write took each other's rows: the removal wins)
      const code = pgErrorCode(e)
      if (code === FOREIGN_KEY_VIOLATION || code === DEADLOCK_DETECTED) throw notFound()
      throw e
    }
    return prefsOf(db, wid, user.id)
  })
}
