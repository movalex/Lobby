// OWNER: WS2 (wave R, notifications to Slack and Teams; stubs landed by the wave R foundation). The chat hook routes
// (@draftroom/contracts chat-hooks.ts; migration 0036_chat_hooks; docs/WAVE-R-CONTRACTS.md §4; AGENTS.md "Server
// egress exception: chat notifications"):
//
//   GET    /api/workspaces/:wid/chat-hooks            the workspace's hooks (hints only)          R2-1
//   POST   /api/workspaces/:wid/chat-hooks            add one (URL checked, then sealed)           R2-1
//   PATCH  /api/workspaces/:wid/chat-hooks/:hid       rename, new URL, snippets, re-enable         R2-1
//   DELETE /api/workspaces/:wid/chat-hooks/:hid       remove                                       R2-1
//   POST   /api/workspaces/:wid/chat-hooks/:hid/test  send a test message                          R2-2
//   GET    /api/me/chat-prefs?workspace=              the caller's choices                         R2-3
//   PUT    /api/me/chat-prefs                         set them                                     R2-3
//
// What WS2 builds here: the routes, the outbox writer enqueueChatDeliveries (called at the three notification insert
// sites, in their transactions), the delivery loop (FOR UPDATE SKIP LOCKED, CHAT_DELIVERY), and the renderer (the
// contracts' slackPayload / teamsPayload from current rows). The URL is sealed with the secret box
// (../../crypto/sealed.ts createSecretBox(ctx.config.webhookSecret), AAD chatHookAad): with no
// DRAFTROOM_WEBHOOK_SECRET the box is null and every route answers 404 CHAT_HOOKS_OFF (fail closed). Posts go through
// the egress module (../../egress: chatHookEgressPolicy(ctx.config.chatHookTestOrigins), CHAT_HOOK_EGRESS_USER_AGENT;
// the opened URL wrapped as a RedactedSecret). The guard rows are in place: a name-only guest is refused every route
// (guests/guard.ts); listing, adding, changing and testing a hook need a creator ('always', purpose share:
// domain-access/guard.ts), and the route also requires a workspace owner or admin. Pending (../pending-routes.ts):
// none is registered until WS2 implements it.

import { CHAT_HOOK_ROUTE_KEYS } from '@draftroom/contracts'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../../errors.ts'
import type { FeatureContext } from '../context.ts'
import { type PendingMethod, routeUnlessPending } from '../pending-routes.ts'

export async function registerChatHooks(app: FastifyInstance, _ctx: FeatureContext): Promise<void> {
  const stub = async () => {
    throw notFound()
  }
  for (const key of CHAT_HOOK_ROUTE_KEYS) {
    const [method, url] = key.split(' ') as [PendingMethod, string]
    routeUnlessPending(app, method, url, stub)
  }
}
