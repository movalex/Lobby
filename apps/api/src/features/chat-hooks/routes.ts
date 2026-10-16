// The chat hook routes (wave R, WS2; contracts chat-hooks.ts; docs/WAVE-R-CONTRACTS.md §4.1):
//
//   GET    /api/workspaces/:wid/chat-hooks            the workspace's hooks (hints only)        owner/admin + creator
//   POST   /api/workspaces/:wid/chat-hooks            add one (URL checked, then sealed)        owner/admin + creator
//   PATCH  /api/workspaces/:wid/chat-hooks/:hid       rename, new URL, snippets, re-enable      owner/admin + creator
//   DELETE /api/workspaces/:wid/chat-hooks/:hid       remove                                    any owner/admin
//   POST   /api/workspaces/:wid/chat-hooks/:hid/test  send a test message                       owner/admin + creator
//
// The creator rule is the guard's (domain-access/guard.ts, 'always', before the handler); the role is the route's. With no
// DRAFTROOM_WEBHOOK_SECRET every route answers 404 CHAT_HOOKS_OFF. A name-only guest is refused (guests/guard.ts, and
// here again). The URL is checked (urls.ts), sealed under the secret with the row's identity as additional data, and
// only its hint ever comes back; no response, audit row or log line holds it.

import {
  CHAT_HOOK_CODES,
  CHAT_HOOK_GUESTS_MESSAGE,
  CHAT_HOOK_LIMITS,
  CHAT_HOOK_ROUTES,
  type ChatHook,
  ChatHookId,
  CreateChatHookInput,
  cleanDisplayText,
  type ListChatHooksResponse,
  PatchChatHookInput,
  type TestChatHookResponse,
} from '@draftroom/contracts'
import { newId, type Queryable } from '@draftroom/db'
import { canManageWorkspace } from '@draftroom/permissions'
import type { FastifyInstance } from 'fastify'
import { requireWorkspaceRole } from '../../access.ts'
import { audit } from '../../audit.ts'
import type { SessionUser } from '../../auth/session.ts'
import type { Params } from '../../context.ts'
import { chatHookAad, type SecretBox } from '../../crypto/sealed.ts'
import { ApiError, conflict, forbidden, notFound, parse } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { UserRateLimiter } from '../dashboard/shared.ts'
import { guestRefused } from '../guests/guard.ts'
import { type PendingMethod, routeUnlessPending } from '../pending-routes.ts'
import { noticePayloadFor, workspaceLink } from './render.ts'
import type { PostFn } from './send.ts'
import { findHook, HOOK_COLUMNS, HOOK_FROM, type HookRow, listHooks, toChatHook } from './store.ts'
import { checkHookUrl } from './urls.ts'

const R = CHAT_HOOK_ROUTES
const NOT_MANAGER = 'Only workspace owners and admins can manage chat notifications.'
const TESTS_PER_MINUTE = 10

export const chatHooksOff = () =>
  new ApiError(404, CHAT_HOOK_CODES.off, 'Chat notifications are not switched on for this Lobby.')

/** The pieces every chat route needs. */
export interface ChatRouteEnv {
  app: FastifyInstance
  ctx: FeatureContext
  /** null: no DRAFTROOM_WEBHOOK_SECRET, chat hooks are off */
  box: SecretBox | null
  post: PostFn
}

/** Registers a route unless it is still pending (../pending-routes.ts). */
export function chatRoute(
  env: ChatRouteEnv,
  method: PendingMethod,
  url: string,
  handler: Parameters<typeof routeUnlessPending>[3],
): void {
  routeUnlessPending(env.app, method, url, handler)
}

/** The sealing box, or the 404 of a server with hooks off. */
export function requireBox(env: ChatRouteEnv): SecretBox {
  if (!env.box) throw chatHooksOff()
  return env.box
}

/**
 * An owner or admin of the workspace (404 for a stranger, 403 for anyone else, GUEST_ACCOUNT_REQUIRED for a guest).
 * With `route`, also a creator ('share': the guard has checked already; this is the route's own check, so the rule
 * holds with the guard off).
 */
export async function requireManager(
  env: ChatRouteEnv,
  q: Queryable,
  workspaceId: string,
  user: SessionUser,
  route?: string,
): Promise<void> {
  if (user.kind === 'guest') throw guestRefused(CHAT_HOOK_GUESTS_MESSAGE)
  const role = await requireWorkspaceRole(q, workspaceId, user.id)
  if (!canManageWorkspace(role)) throw forbidden(NOT_MANAGER)
  if (route !== undefined) await env.ctx.identity.requireCreator(q, user.id, 'share', { route, by: 'route' })
}

const isHookId = (v: string) => ChatHookId.safeParse(v).success

export function registerHookRoutes(env: ChatRouteEnv): void {
  const { ctx } = env
  const { db, now } = ctx
  const testLimiter = new UserRateLimiter({
    max: TESTS_PER_MINUTE,
    windowMs: 60_000,
    now: () => now().getTime(),
  })

  chatRoute(env, 'GET', R.hooks, async (req): Promise<ListChatHooksResponse> => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    requireBox(env)
    await requireManager(env, db, wid, user, R.hooks)
    return { hooks: (await listHooks(db, wid)).map(toChatHook) }
  })

  chatRoute(env, 'POST', R.hooks, async (req, reply): Promise<ChatHook> => {
    const user = await ctx.requireUser(req)
    const { wid = '' } = req.params as Params
    const box = requireBox(env)
    await requireManager(env, db, wid, user, R.hooks)
    const input = parse(CreateChatHookInput, req.body)
    const check = checkHookUrl(input.url, input.provider, ctx.config.chatHookTestOrigins)
    if (!check.ok) throw new ApiError(400, check.code, check.message)
    const id = newId('chk')
    const sealed = box.seal(check.url.href, chatHookAad(wid, id))
    const at = now()
    await db.transaction(async (tx) => {
      // the workspace row first: the cap cannot race, and a manager removed meanwhile adds nothing
      await tx.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [wid])
      await requireManager(env, tx, wid, user, R.hooks)
      const held = await tx.one<{ n: number }>(
        'SELECT count(*)::int AS n FROM chat_hooks WHERE workspace_id = $1',
        [wid],
      )
      if (Number(held.n) >= CHAT_HOOK_LIMITS.hooksPerWorkspace)
        throw conflict(
          CHAT_HOOK_CODES.full,
          `A workspace can have at most ${CHAT_HOOK_LIMITS.hooksPerWorkspace} chat hooks. Remove one first.`,
        )
      await tx.query(
        `INSERT INTO chat_hooks (id, workspace_id, name, provider, url_sealed, key_id, url_hint,
                                 include_snippets, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
        [
          id,
          wid,
          input.name,
          check.provider,
          sealed.sealed,
          sealed.keyId,
          check.hint,
          input.includeSnippets,
          user.id,
          at,
        ],
      )
      await audit(tx, {
        workspaceId: wid,
        actorId: user.id,
        action: 'chat_hook.create',
        target: id,
        detail: { provider: check.provider },
        at,
      })
    })
    const row = await findHook(db, wid, id)
    if (!row) throw notFound()
    return reply.code(201).send(toChatHook(row))
  })

  chatRoute(env, 'PATCH', R.hook, async (req): Promise<ChatHook> => {
    const user = await ctx.requireUser(req)
    const { wid = '', hid = '' } = req.params as Params
    const box = requireBox(env)
    await requireManager(env, db, wid, user, R.hook)
    if (!isHookId(hid)) throw notFound()
    const input = parse(PatchChatHookInput, req.body)
    const at = now()
    await db.transaction(async (tx) => {
      const row = await tx.maybeOne<HookRow>(
        `SELECT ${HOOK_COLUMNS} ${HOOK_FROM} WHERE h.workspace_id = $1 AND h.id = $2 FOR UPDATE OF h`,
        [wid, hid],
      )
      if (!row) throw notFound()
      await requireManager(env, tx, wid, user, R.hook)
      const sets: string[] = ['updated_at = $3']
      const params: unknown[] = [wid, hid, at]
      const changed: string[] = []
      const set = (column: string, value: unknown) => {
        params.push(value)
        sets.push(`${column} = $${params.length}`)
      }
      if (input.name !== undefined) {
        set('name', input.name)
        changed.push('name')
      }
      if (input.includeSnippets !== undefined) {
        set('include_snippets', input.includeSnippets)
        changed.push('includeSnippets')
      }
      if (input.url !== undefined) {
        const check = checkHookUrl(input.url, row.provider, ctx.config.chatHookTestOrigins)
        if (!check.ok) throw new ApiError(400, check.code, check.message)
        const sealed = box.seal(check.url.href, chatHookAad(wid, hid))
        set('url_sealed', sealed.sealed)
        set('key_id', sealed.keyId)
        set('url_hint', check.hint)
        sets.push('last_error_code = NULL')
        changed.push('url')
      }
      if (input.enabled === true) {
        sets.push('disabled_at = NULL', 'disabled_reason = NULL', 'last_error_code = NULL')
        changed.push('enabled')
      }
      await tx.query(`UPDATE chat_hooks SET ${sets.join(', ')} WHERE workspace_id = $1 AND id = $2`, params)
      await audit(tx, {
        workspaceId: wid,
        actorId: user.id,
        action: 'chat_hook.update',
        target: hid,
        detail: { changed },
        at,
      })
    })
    const row = await findHook(db, wid, hid)
    if (!row) throw notFound()
    return toChatHook(row)
  })

  chatRoute(env, 'DELETE', R.hook, async (req, reply) => {
    const user = await ctx.requireUser(req)
    const { wid = '', hid = '' } = req.params as Params
    requireBox(env)
    await requireManager(env, db, wid, user)
    if (!isHookId(hid)) throw notFound()
    const at = now()
    await db.transaction(async (tx) => {
      const gone = await tx.maybeOne<{ provider: string }>(
        'DELETE FROM chat_hooks WHERE workspace_id = $1 AND id = $2 RETURNING provider',
        [wid, hid],
      )
      if (!gone) throw notFound()
      await audit(tx, {
        workspaceId: wid,
        actorId: user.id,
        action: 'chat_hook.delete',
        target: hid,
        detail: { provider: gone.provider },
        at,
      })
    })
    return reply.code(204).send()
  })

  chatRoute(env, 'POST', R.test, async (req): Promise<TestChatHookResponse> => {
    const user = await ctx.requireUser(req)
    const { wid = '', hid = '' } = req.params as Params
    const box = requireBox(env)
    await requireManager(env, db, wid, user, R.test)
    if (!isHookId(hid)) throw notFound()
    const row = await findHook(db, wid, hid)
    if (!row) throw notFound()
    if (!testLimiter.hit(user.id))
      throw new ApiError(429, 'RATE_LIMITED', 'Too many test messages. Wait a minute and try again.')
    let url: string
    try {
      url = box.open(Buffer.from(row.url_sealed), row.key_id, chatHookAad(wid, hid)).value
    } catch {
      await db.query('UPDATE chat_hooks SET last_error_code = $2 WHERE id = $1', [hid, 'unsealed'])
      return { status: 'failed', code: 'unsealed' }
    }
    const workspace = await db.one<{ name: string }>('SELECT name FROM workspaces WHERE id = $1', [wid])
    const who = cleanDisplayText(user.name) || 'Someone'
    const outcome = await env.post(
      url,
      noticePayloadFor(row.provider, {
        text: `${who} is testing Lobby notifications for this channel.`,
        link: workspaceLink(ctx.config.publicOrigin, wid),
        workspaceName: workspace.name,
      }),
    )
    const sent = outcome.kind === 'status' && outcome.status >= 200 && outcome.status < 300
    const code = outcome.kind === 'status' ? String(outcome.status) : outcome.code
    if (sent)
      await db.query('UPDATE chat_hooks SET last_ok_at = $2, last_error_code = NULL WHERE id = $1', [
        hid,
        now(),
      ])
    else await db.query('UPDATE chat_hooks SET last_error_code = $2 WHERE id = $1', [hid, code])
    return sent ? { status: 'sent', code: null } : { status: 'failed', code }
  })
}
